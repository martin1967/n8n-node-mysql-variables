import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class MySqlVariablesApi implements ICredentialType {
	name = 'mySqlVariablesApi';

	displayName = 'MySQL Variables API';

	documentationUrl = 'https://github.com/martin1967/n8n-node-mysql-variables';

	properties: INodeProperties[] = [
		{
			displayName: 'Account',
			name: 'account',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'alice',
			description:
				'Owner identity for variables created with this credential. Each person should use a unique account name. Variables are isolated by account; only "shared" ones are visible to other accounts (read-only for them).',
		},
		{
			displayName: 'Host',
			name: 'host',
			type: 'string',
			default: 'localhost',
		},
		{
			displayName: 'Port',
			name: 'port',
			type: 'number',
			default: 3306,
		},
		{
			displayName: 'Database',
			name: 'database',
			type: 'string',
			default: 'n8n',
		},
		{
			displayName: 'User',
			name: 'user',
			type: 'string',
			default: 'n8n',
			description: 'MySQL user. Give each person their own MySQL login with privileges on the variables table.',
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
		},
		{
			displayName: 'SSL',
			name: 'ssl',
			type: 'boolean',
			default: false,
			description: 'Whether to connect using SSL/TLS (self-signed certificates are accepted)',
		},
		{
			displayName: 'Encryption Key',
			name: 'encryptionKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Passphrase used to AES-256-GCM encrypt values at rest. IMPORTANT: to read SHARED variables created by other accounts, every account must use the SAME encryption key. Losing this key makes encrypted values unrecoverable.',
		},
		{
			displayName: 'Table Name',
			name: 'table',
			type: 'string',
			default: 'n8n_variables',
			description: 'MySQL table used to store variables (letters, digits and underscore only)',
		},
		{
			displayName: 'Auto-create Table',
			name: 'autoCreateTable',
			type: 'boolean',
			default: true,
			description: 'Whether to run CREATE TABLE IF NOT EXISTS before operations',
		},
	];
}
