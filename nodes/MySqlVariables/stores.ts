import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import mysql from 'mysql2/promise';
import type { Connection } from 'mysql2/promise';
import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic } from 'sql.js';

import type { ParsedCredentials } from './GenericFunctions';

export interface StoredRow {
	owner: string;
	key: string;
	value: string | null;
	type: string;
	shared: number;
	created_at?: string;
	updated_at?: string;
}

export type ListFilter = 'all' | 'mine' | 'shared';

export class DuplicateKeyError extends Error {}

/**
 * Backend-agnostic variable store. The node layer handles encryption, so all
 * `value` arguments/results here are already-encrypted (or NULL) opaque strings.
 */
export interface VariableStore {
	init(): Promise<void>;
	ensureSchema(): Promise<void>;
	getOne(key: string, owner: string, ownerOverride?: string): Promise<StoredRow | null>;
	list(filter: ListFilter, owner: string): Promise<StoredRow[]>;
	upsert(owner: string, key: string, value: string, type: string, shared: boolean): Promise<void>;
	insert(owner: string, key: string, value: string, type: string, shared: boolean): Promise<void>;
	update(owner: string, key: string, value: string, type: string, shared: boolean): Promise<number>;
	remove(owner: string, key: string): Promise<number>;
	clearValue(owner: string, key: string): Promise<{ existed: boolean }>;
	close(): Promise<void>;
}

const SELECT_COLS = '`owner`,`key`,`value`,`type`,`shared`,`created_at`,`updated_at`';

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
				\`owner\` VARCHAR(190) NOT NULL,
				\`key\` VARCHAR(190) NOT NULL,
				\`value\` LONGTEXT NULL,
				\`type\` VARCHAR(20) NOT NULL DEFAULT 'string',
				\`encrypted\` TINYINT(1) NOT NULL DEFAULT 1,
				\`shared\` TINYINT(1) NOT NULL DEFAULT 0,
				\`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				\`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
				PRIMARY KEY (\`owner\`, \`key\`),
				KEY \`idx_shared\` (\`shared\`)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
		);
	}

	async getOne(key: string, owner: string, ownerOverride?: string): Promise<StoredRow | null> {
		const t = this.creds.table;
		const [rows] = ownerOverride
			? await this.conn.query(
					`SELECT ${SELECT_COLS} FROM \`${t}\` WHERE \`key\`=? AND \`owner\`=? AND (\`owner\`=? OR \`shared\`=1) LIMIT 1`,
					[key, ownerOverride, owner],
				)
			: await this.conn.query(
					`SELECT ${SELECT_COLS} FROM \`${t}\` WHERE \`key\`=? AND (\`owner\`=? OR \`shared\`=1) ORDER BY (\`owner\`=?) DESC LIMIT 1`,
					[key, owner, owner],
				);
		const list = rows as StoredRow[];
		return list.length ? list[0] : null;
	}

	async list(filter: ListFilter, owner: string): Promise<StoredRow[]> {
		const t = this.creds.table;
		let where = '(`owner`=? OR `shared`=1)';
		const params: unknown[] = [owner];
		if (filter === 'mine') {
			where = '`owner`=?';
		} else if (filter === 'shared') {
			where = '`shared`=1';
			params.length = 0;
		}
		const [rows] = await this.conn.query(
			`SELECT ${SELECT_COLS} FROM \`${t}\` WHERE ${where} ORDER BY \`owner\` ASC, \`key\` ASC`,
			params,
		);
		return rows as StoredRow[];
	}

	async upsert(owner: string, key: string, value: string, type: string, shared: boolean): Promise<void> {
		await this.conn.query(
			`INSERT INTO \`${this.creds.table}\` (\`owner\`,\`key\`,\`value\`,\`type\`,\`encrypted\`,\`shared\`)
			 VALUES (?,?,?,?,1,?)
			 ON DUPLICATE KEY UPDATE \`value\`=VALUES(\`value\`), \`type\`=VALUES(\`type\`), \`encrypted\`=1, \`shared\`=VALUES(\`shared\`)`,
			[owner, key, value, type, shared ? 1 : 0],
		);
	}

	async insert(owner: string, key: string, value: string, type: string, shared: boolean): Promise<void> {
		try {
			await this.conn.query(
				`INSERT INTO \`${this.creds.table}\` (\`owner\`,\`key\`,\`value\`,\`type\`,\`encrypted\`,\`shared\`)
				 VALUES (?,?,?,?,1,?)`,
				[owner, key, value, type, shared ? 1 : 0],
			);
		} catch (error) {
			if ((error as { code?: string }).code === 'ER_DUP_ENTRY') {
				throw new DuplicateKeyError();
			}
			throw error;
		}
	}

	async update(owner: string, key: string, value: string, type: string, shared: boolean): Promise<number> {
		const [res] = await this.conn.query(
			`UPDATE \`${this.creds.table}\` SET \`value\`=?, \`type\`=?, \`encrypted\`=1, \`shared\`=? WHERE \`owner\`=? AND \`key\`=?`,
			[value, type, shared ? 1 : 0, owner, key],
		);
		return (res as { affectedRows: number }).affectedRows;
	}

	async remove(owner: string, key: string): Promise<number> {
		const [res] = await this.conn.query(
			`DELETE FROM \`${this.creds.table}\` WHERE \`owner\`=? AND \`key\`=?`,
			[owner, key],
		);
		return (res as { affectedRows: number }).affectedRows;
	}

	async clearValue(owner: string, key: string): Promise<{ existed: boolean }> {
		const [res] = await this.conn.query(
			`UPDATE \`${this.creds.table}\` SET \`value\`=NULL WHERE \`owner\`=? AND \`key\`=?`,
			[owner, key],
		);
		if ((res as { affectedRows: number }).affectedRows > 0) {
			return { existed: true };
		}
		// affectedRows is 0 either when the row is missing or value was already NULL.
		const [chk] = await this.conn.query(
			`SELECT 1 FROM \`${this.creds.table}\` WHERE \`owner\`=? AND \`key\`=? LIMIT 1`,
			[owner, key],
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
				\`owner\` TEXT NOT NULL,
				\`key\` TEXT NOT NULL,
				\`value\` TEXT,
				\`type\` TEXT NOT NULL DEFAULT 'string',
				\`encrypted\` INTEGER NOT NULL DEFAULT 1,
				\`shared\` INTEGER NOT NULL DEFAULT 0,
				\`created_at\` TEXT NOT NULL DEFAULT (datetime('now')),
				\`updated_at\` TEXT NOT NULL DEFAULT (datetime('now')),
				PRIMARY KEY (\`owner\`, \`key\`)
			)`,
		);
		this.persist();
	}

	async getOne(key: string, owner: string, ownerOverride?: string): Promise<StoredRow | null> {
		const t = this.creds.table;
		const rows = ownerOverride
			? this.select(
					`SELECT ${SELECT_COLS} FROM \`${t}\` WHERE \`key\`=? AND \`owner\`=? AND (\`owner\`=? OR \`shared\`=1) LIMIT 1`,
					[key, ownerOverride, owner],
				)
			: this.select(
					`SELECT ${SELECT_COLS} FROM \`${t}\` WHERE \`key\`=? AND (\`owner\`=? OR \`shared\`=1) ORDER BY (\`owner\`=?) DESC LIMIT 1`,
					[key, owner, owner],
				);
		return rows.length ? rows[0] : null;
	}

	async list(filter: ListFilter, owner: string): Promise<StoredRow[]> {
		const t = this.creds.table;
		let where = '(`owner`=? OR `shared`=1)';
		const params: unknown[] = [owner];
		if (filter === 'mine') {
			where = '`owner`=?';
		} else if (filter === 'shared') {
			where = '`shared`=1';
			params.length = 0;
		}
		return this.select(
			`SELECT ${SELECT_COLS} FROM \`${t}\` WHERE ${where} ORDER BY \`owner\` ASC, \`key\` ASC`,
			params,
		);
	}

	async upsert(owner: string, key: string, value: string, type: string, shared: boolean): Promise<void> {
		this.run(
			`INSERT INTO \`${this.creds.table}\` (\`owner\`,\`key\`,\`value\`,\`type\`,\`encrypted\`,\`shared\`,\`updated_at\`)
			 VALUES (?,?,?,?,1,?, datetime('now'))
			 ON CONFLICT(\`owner\`,\`key\`) DO UPDATE SET
			   \`value\`=excluded.\`value\`, \`type\`=excluded.\`type\`, \`encrypted\`=1, \`shared\`=excluded.\`shared\`, \`updated_at\`=datetime('now')`,
			[owner, key, value, type, shared ? 1 : 0],
		);
		this.persist();
	}

	async insert(owner: string, key: string, value: string, type: string, shared: boolean): Promise<void> {
		try {
			this.run(
				`INSERT INTO \`${this.creds.table}\` (\`owner\`,\`key\`,\`value\`,\`type\`,\`encrypted\`,\`shared\`)
				 VALUES (?,?,?,?,1,?)`,
				[owner, key, value, type, shared ? 1 : 0],
			);
		} catch (error) {
			if (/UNIQUE constraint failed/i.test((error as Error).message)) {
				throw new DuplicateKeyError();
			}
			throw error;
		}
		this.persist();
	}

	async update(owner: string, key: string, value: string, type: string, shared: boolean): Promise<number> {
		const n = this.run(
			`UPDATE \`${this.creds.table}\` SET \`value\`=?, \`type\`=?, \`encrypted\`=1, \`shared\`=?, \`updated_at\`=datetime('now') WHERE \`owner\`=? AND \`key\`=?`,
			[value, type, shared ? 1 : 0, owner, key],
		);
		this.persist();
		return n;
	}

	async remove(owner: string, key: string): Promise<number> {
		const n = this.run(`DELETE FROM \`${this.creds.table}\` WHERE \`owner\`=? AND \`key\`=?`, [owner, key]);
		this.persist();
		return n;
	}

	async clearValue(owner: string, key: string): Promise<{ existed: boolean }> {
		const n = this.run(
			`UPDATE \`${this.creds.table}\` SET \`value\`=NULL, \`updated_at\`=datetime('now') WHERE \`owner\`=? AND \`key\`=?`,
			[owner, key],
		);
		if (n > 0) {
			this.persist();
			return { existed: true };
		}
		const chk = this.select(`SELECT \`key\` FROM \`${this.creds.table}\` WHERE \`owner\`=? AND \`key\`=? LIMIT 1`, [
			owner,
			key,
		]);
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
