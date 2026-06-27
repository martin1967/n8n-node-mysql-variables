import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class MySqlVariablesApi implements ICredentialType {
	name = 'mySqlVariablesApi';

	displayName = 'MySQL Variables API';

	documentationUrl = 'https://github.com/martin1967/n8n-node-mysql-variables';

	properties: INodeProperties[] = [
		{
			displayName: 'Storage',
			name: 'storage',
			type: 'options',
			options: [
				{ name: 'SQLite (embedded, no setup)', value: 'sqlite' },
				{ name: 'MySQL', value: 'mysql' },
			],
			default: 'sqlite',
			description:
				'Where to store variables. SQLite needs no database server — data is kept in a file inside the n8n data folder. Use MySQL for a central store shared across multiple n8n instances.',
		},
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
			displayName: 'Encryption Key',
			name: 'encryptionKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Passphrase used to AES-256-GCM encrypt values at rest. IMPORTANT: to read SHARED variables created by other accounts, every account must use the SAME encryption key. Losing this key makes encrypted values unrecoverable.',
		},
		// ---- SQLite ----
		{
			displayName: 'SQLite File Path',
			name: 'sqliteFile',
			type: 'string',
			default: '',
			displayOptions: { show: { storage: ['sqlite'] } },
			placeholder: '/home/node/.n8n/n8n-mysql-variables.sqlite',
			description:
				'Path to the SQLite file. Leave empty to use <n8n user folder>/n8n-mysql-variables.sqlite. Keep it on a mounted volume so data survives restarts.',
		},
		// ---- MySQL ----
		{
			displayName: 'Host',
			name: 'host',
			type: 'string',
			default: 'localhost',
			displayOptions: { show: { storage: ['mysql'] } },
			description:
				'Inside Docker, "localhost" points to the n8n container itself. Use the MySQL container/service name, or host.docker.internal for a DB on the host machine.',
		},
		{
			displayName: 'Port',
			name: 'port',
			type: 'number',
			default: 3306,
			displayOptions: { show: { storage: ['mysql'] } },
		},
		{
			displayName: 'Database',
			name: 'database',
			type: 'string',
			default: 'n8n',
			displayOptions: { show: { storage: ['mysql'] } },
		},
		{
			displayName: 'User',
			name: 'user',
			type: 'string',
			default: 'n8n',
			displayOptions: { show: { storage: ['mysql'] } },
			description: 'MySQL user. Give each person their own MySQL login with privileges on the variables table.',
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			displayOptions: { show: { storage: ['mysql'] } },
		},
		{
			displayName: 'SSL',
			name: 'ssl',
			type: 'boolean',
			default: false,
			displayOptions: { show: { storage: ['mysql'] } },
			description: 'Whether to connect using SSL/TLS (self-signed certificates are accepted)',
		},
		// ---- Common ----
		{
			displayName: 'Table Name',
			name: 'table',
			type: 'string',
			default: 'n8n_variables',
			description: 'Table used to store variables (letters, digits and underscore only)',
		},
		{
			displayName: 'Auto-create Table',
			name: 'autoCreateTable',
			type: 'boolean',
			default: true,
			description: 'Whether to create the variables table automatically if it does not exist',
		},
	];
}
