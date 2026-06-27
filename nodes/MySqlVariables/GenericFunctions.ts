import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import type { ICredentialDataDecryptedObject } from 'n8n-workflow';

const ENC_PREFIX = 'enc:v1:';

export type StorageBackend = 'sqlite' | 'mysql';

export interface ParsedCredentials {
	storage: StorageBackend;
	// MySQL
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
	ssl: boolean;
	// SQLite
	sqliteFile: string;
	// Common
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
 * encryption prefix (e.g. rows inserted manually into the database) are returned as-is.
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

function defaultSqlitePath(): string {
	const base = process.env.N8N_USER_FOLDER || join(homedir(), '.n8n');
	return join(base, 'n8n-mysql-variables.sqlite');
}

export function parseCredentials(raw: ICredentialDataDecryptedObject): ParsedCredentials {
	const storage: StorageBackend = (raw.storage as string) === 'mysql' ? 'mysql' : 'sqlite';
	const sqliteFile = ((raw.sqliteFile as string) || '').trim();

	return {
		storage,
		host: (raw.host as string) || 'localhost',
		port: (raw.port as number) || 3306,
		database: raw.database as string,
		user: raw.user as string,
		password: raw.password as string,
		ssl: raw.ssl as boolean,
		sqliteFile: sqliteFile || defaultSqlitePath(),
		account: ((raw.account as string) || '').trim(),
		encryptionKey: raw.encryptionKey as string,
		table: sanitizeTableName(((raw.table as string) || 'n8n_variables').trim()),
		autoCreateTable: raw.autoCreateTable !== false,
	};
}
