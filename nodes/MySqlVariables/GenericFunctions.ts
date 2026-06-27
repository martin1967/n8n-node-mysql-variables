import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import mysql from 'mysql2/promise';
import type { Connection } from 'mysql2/promise';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';

const ENC_PREFIX = 'enc:v1:';

export interface MySqlVariablesCredentials {
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
	ssl: boolean;
	account: string;
	encryptionKey: string;
	table: string;
	autoCreateTable: boolean;
}

function deriveKey(passphrase: string): Buffer {
	// AES-256 needs a 32-byte key; SHA-256 of the passphrase gives exactly that.
	return createHash('sha256').update(passphrase, 'utf8').digest();
}

/**
 * Encrypts a string with AES-256-GCM. Output format:
 *   enc:v1:<ivBase64>:<authTagBase64>:<ciphertextBase64>
 * A random IV per call means the same plaintext never produces the same blob.
 */
export function encryptValue(plain: string, passphrase: string): string {
	const key = deriveKey(passphrase);
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return (
		ENC_PREFIX +
		[iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':')
	);
}

/**
 * Decrypts a value produced by encryptValue. Values that do not carry the
 * encryption prefix (e.g. rows inserted manually into MySQL) are returned as-is.
 */
export function decryptValue(stored: string | null, passphrase: string): string | null {
	if (stored === null || stored === undefined) return stored;
	if (typeof stored !== 'string' || !stored.startsWith(ENC_PREFIX)) return stored;

	const payload = stored.slice(ENC_PREFIX.length);
	const [ivB64, tagB64, ctB64] = payload.split(':');
	const key = deriveKey(passphrase);
	const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
	decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
	const plain = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
	return plain.toString('utf8');
}

export function sanitizeTableName(name: string): string {
	if (!/^[A-Za-z0-9_]+$/.test(name)) {
		throw new Error(`Invalid table name "${name}". Only letters, digits and underscore are allowed.`);
	}
	return name;
}

export function parseCredentials(raw: ICredentialDataDecryptedObject): MySqlVariablesCredentials {
	return {
		host: (raw.host as string) || 'localhost',
		port: (raw.port as number) || 3306,
		database: raw.database as string,
		user: raw.user as string,
		password: raw.password as string,
		ssl: raw.ssl as boolean,
		account: ((raw.account as string) || '').trim(),
		encryptionKey: raw.encryptionKey as string,
		table: sanitizeTableName(((raw.table as string) || 'n8n_variables').trim()),
		autoCreateTable: raw.autoCreateTable !== false,
	};
}

export async function createConnection(creds: MySqlVariablesCredentials): Promise<Connection> {
	return mysql.createConnection({
		host: creds.host,
		port: creds.port,
		user: creds.user,
		password: creds.password,
		database: creds.database,
		ssl: creds.ssl ? { rejectUnauthorized: false } : undefined,
		multipleStatements: false,
		supportBigNumbers: true,
		dateStrings: true,
	});
}

/** Thin query helper returning the first element of mysql2's [result, fields] tuple. */
export async function query(conn: Connection, sql: string, params: unknown[] = []): Promise<any> {
	const [rows] = await conn.query(sql, params);
	return rows;
}

export async function ensureTable(conn: Connection, table: string): Promise<void> {
	await conn.query(
		`CREATE TABLE IF NOT EXISTS \`${table}\` (
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
