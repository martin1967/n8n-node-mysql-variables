import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import mysql from 'mysql2/promise';
import type { Connection } from 'mysql2/promise';
import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic } from 'sql.js';

import type { ParsedCredentials } from './GenericFunctions';

export interface StoredRow {
	key: string;
	value: string | null;
	type: string;
	created_at?: string;
	updated_at?: string;
}

export class DuplicateKeyError extends Error {}

/**
 * Backend-agnostic variable store. Isolation is per store (one SQLite file or
 * one MySQL table = one independent key→value space). The node layer handles
 * encryption, so all `value` arguments/results here are already-encrypted
 * (or NULL) opaque strings.
 */
export interface VariableStore {
	init(): Promise<void>;
	ensureSchema(): Promise<void>;
	getOne(key: string): Promise<StoredRow | null>;
	list(): Promise<StoredRow[]>;
	upsert(key: string, value: string, type: string): Promise<void>;
	insert(key: string, value: string, type: string): Promise<void>;
	update(key: string, value: string, type: string): Promise<number>;
	remove(key: string): Promise<number>;
	clearValue(key: string): Promise<{ existed: boolean }>;
	close(): Promise<void>;
}

const SELECT_COLS = '`key`,`value`,`type`,`created_at`,`updated_at`';

// --------------------------------------------------------------------------
// MySQL backend
// --------------------------------------------------------------------------

class MysqlStore implements VariableStore {
	private conn!: Connection;

	constructor(private readonly creds: ParsedCredentials) {}

	async init(): Promise<void> {
		this.conn = await mysql.createConnection({
			host: this.creds.host,
			port: this.creds.port,
			user: this.creds.user,
			password: this.creds.password,
			database: this.creds.database,
			ssl: this.creds.ssl ? { rejectUnauthorized: false } : undefined,
			multipleStatements: false,
			supportBigNumbers: true,
			dateStrings: true,
		});
	}

	async ensureSchema(): Promise<void> {
		await this.conn.query(
			`CREATE TABLE IF NOT EXISTS \`${this.creds.table}\` (
				\`key\` VARCHAR(190) NOT NULL,
				\`value\` LONGTEXT NULL,
				\`type\` VARCHAR(20) NOT NULL DEFAULT 'string',
				\`encrypted\` TINYINT(1) NOT NULL DEFAULT 1,
				\`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				\`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
				PRIMARY KEY (\`key\`)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
		);
	}

	async getOne(key: string): Promise<StoredRow | null> {
		const [rows] = await this.conn.query(
			`SELECT ${SELECT_COLS} FROM \`${this.creds.table}\` WHERE \`key\`=? LIMIT 1`,
			[key],
		);
		const list = rows as StoredRow[];
		return list.length ? list[0] : null;
	}

	async list(): Promise<StoredRow[]> {
		const [rows] = await this.conn.query(
			`SELECT ${SELECT_COLS} FROM \`${this.creds.table}\` ORDER BY \`key\` ASC`,
		);
		return rows as StoredRow[];
	}

	async upsert(key: string, value: string, type: string): Promise<void> {
		await this.conn.query(
			`INSERT INTO \`${this.creds.table}\` (\`key\`,\`value\`,\`type\`,\`encrypted\`)
			 VALUES (?,?,?,1)
			 ON DUPLICATE KEY UPDATE \`value\`=VALUES(\`value\`), \`type\`=VALUES(\`type\`), \`encrypted\`=1`,
			[key, value, type],
		);
	}

	async insert(key: string, value: string, type: string): Promise<void> {
		try {
			await this.conn.query(
				`INSERT INTO \`${this.creds.table}\` (\`key\`,\`value\`,\`type\`,\`encrypted\`) VALUES (?,?,?,1)`,
				[key, value, type],
			);
		} catch (error) {
			if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
				throw new DuplicateKeyError();
			}
			throw error;
		}
	}

	async update(key: string, value: string, type: string): Promise<number> {
		const [res] = await this.conn.query(
			`UPDATE \`${this.creds.table}\` SET \`value\`=?, \`type\`=?, \`encrypted\`=1 WHERE \`key\`=?`,
			[value, type, key],
		);
		return (res as { affectedRows: number }).affectedRows;
	}

	async remove(key: string): Promise<number> {
		const [res] = await this.conn.query(`DELETE FROM \`${this.creds.table}\` WHERE \`key\`=?`, [key]);
		return (res as { affectedRows: number }).affectedRows;
	}

	async clearValue(key: string): Promise<{ existed: boolean }> {
		const [res] = await this.conn.query(
			`UPDATE \`${this.creds.table}\` SET \`value\`=NULL WHERE \`key\`=?`,
			[key],
		);
		if ((res as { affectedRows: number }).affectedRows > 0) {
			return { existed: true };
		}
		// affectedRows is 0 either when the row is missing or value was already NULL.
		const [chk] = await this.conn.query(
			`SELECT 1 FROM \`${this.creds.table}\` WHERE \`key\`=? LIMIT 1`,
			[key],
		);
		return { existed: (chk as unknown[]).length > 0 };
	}

	async close(): Promise<void> {
		await this.conn.end();
	}
}

// --------------------------------------------------------------------------
// SQLite (embedded, sql.js / WASM) backend
// --------------------------------------------------------------------------

let sqlJsPromise: Promise<SqlJsStatic> | undefined;
function getSqlJs(): Promise<SqlJsStatic> {
	if (!sqlJsPromise) {
		sqlJsPromise = initSqlJs({
			locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm'),
		});
	}
	return sqlJsPromise;
}

// In-process mutex: sql.js holds the whole DB in memory and persists by
// rewriting the file, so concurrent executions must be serialized to avoid
// clobbering each other's writes.
let lockChain: Promise<void> = Promise.resolve();
function acquireLock(): Promise<() => void> {
	let release!: () => void;
	const next = new Promise<void>((resolve) => {
		release = resolve;
	});
	const previous = lockChain;
	lockChain = lockChain.then(() => next);
	return previous.then(() => release);
}

class SqliteStore implements VariableStore {
	private db!: Database;
	private release: (() => void) | undefined;

	constructor(private readonly creds: ParsedCredentials) {}

	async init(): Promise<void> {
		this.release = await acquireLock();
		try {
			const SQL = await getSqlJs();
			const file = this.creds.sqliteFile;
			const buffer = existsSync(file) ? readFileSync(file) : undefined;
			this.db = new SQL.Database(buffer);
		} catch (error) {
			this.release?.();
			this.release = undefined;
			throw error;
		}
	}

	private persist(): void {
		const file = this.creds.sqliteFile;
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, Buffer.from(this.db.export()));
	}

	private select(sql: string, params: unknown[]): StoredRow[] {
		const stmt = this.db.prepare(sql);
		stmt.bind(params as never);
		const out: StoredRow[] = [];
		while (stmt.step()) {
			out.push(stmt.getAsObject() as unknown as StoredRow);
		}
		stmt.free();
		return out;
	}

	private run(sql: string, params: unknown[]): number {
		this.db.run(sql, params as never);
		return this.db.getRowsModified();
	}

	async ensureSchema(): Promise<void> {
		this.db.run(
			`CREATE TABLE IF NOT EXISTS \`${this.creds.table}\` (
				\`key\` TEXT NOT NULL,
				\`value\` TEXT,
				\`type\` TEXT NOT NULL DEFAULT 'string',
				\`encrypted\` INTEGER NOT NULL DEFAULT 1,
				\`created_at\` TEXT NOT NULL DEFAULT (datetime('now')),
				\`updated_at\` TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (\`key\`)
			)`,
		);
		this.persist();
	}

	async getOne(key: string): Promise<StoredRow | null> {
		const rows = this.select(
			`SELECT ${SELECT_COLS} FROM \`${this.creds.table}\` WHERE \`key\`=? LIMIT 1`,
			[key],
		);
		return rows.length ? rows[0] : null;
	}

	async list(): Promise<StoredRow[]> {
		return this.select(`SELECT ${SELECT_COLS} FROM \`${this.creds.table}\` ORDER BY \`key\` ASC`, []);
	}

	async upsert(key: string, value: string, type: string): Promise<void> {
		this.run(
			`INSERT INTO \`${this.creds.table}\` (\`key\`,\`value\`,\`type\`,\`encrypted\`,\`updated_at\`)
			 VALUES (?,?,?,1, datetime('now'))
			 ON CONFLICT(\`key\`) DO UPDATE SET
			   \`value\`=excluded.\`value\`, \`type\`=excluded.\`type\`, \`encrypted\`=1, \`updated_at\`=datetime('now')`,
			[key, value, type],
		);
		this.persist();
	}

	async insert(key: string, value: string, type: string): Promise<void> {
		try {
			this.run(
				`INSERT INTO \`${this.creds.table}\` (\`key\`,\`value\`,\`type\`,\`encrypted\`) VALUES (?,?,?,1)`,
				[key, value, type],
			);
		} catch (error) {
			if (/UNIQUE constraint failed/i.test((error as Error).message)) {
				throw new DuplicateKeyError();
			}
			throw error;
		}
		this.persist();
	}

	async update(key: string, value: string, type: string): Promise<number> {
		const n = this.run(
			`UPDATE \`${this.creds.table}\` SET \`value\`=?, \`type\`=?, \`encrypted\`=1, \`updated_at\`=datetime('now') WHERE \`key\`=?`,
			[value, type, key],
		);
		this.persist();
		return n;
	}

	async remove(key: string): Promise<number> {
		const n = this.run(`DELETE FROM \`${this.creds.table}\` WHERE \`key\`=?`, [key]);
		this.persist();
		return n;
	}

	async clearValue(key: string): Promise<{ existed: boolean }> {
		const n = this.run(
			`UPDATE \`${this.creds.table}\` SET \`value\`=NULL, \`updated_at\`=datetime('now') WHERE \`key\`=?`,
			[key],
		);
		if (n > 0) {
			this.persist();
			return { existed: true };
		}
		const chk = this.select(`SELECT \`key\` FROM \`${this.creds.table}\` WHERE \`key\`=? LIMIT 1`, [key]);
		return { existed: chk.length > 0 };
	}

	async close(): Promise<void> {
		try {
			this.persist();
			this.db.close();
		} finally {
			this.release?.();
			this.release = undefined;
		}
	}
}

export async function createStore(creds: ParsedCredentials): Promise<VariableStore> {
	const store: VariableStore = creds.storage === 'mysql' ? new MysqlStore(creds) : new SqliteStore(creds);
	await store.init();
	return store;
}
