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
			displayName: 'Encryption Key',
			name: 'encryptionKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Passphrase used to AES-256-GCM encrypt values at rest. Also used to auto-derive a private SQLite store when no Username is set. Losing this key makes encrypted values unrecoverable.',
		},
		// ---- SQLite ----
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			placeholder: 'alice',
			displayOptions: { show: { storage: ['sqlite'] } },
			description:
				'Friendly name for your variable store. Each distinct username gets its own isolated set of variables. Leave empty to automatically get a private store derived from your Encryption Key. To share variables, use the SAME username + Encryption Key, or just share this credential with colleagues.',
		},
		{
			displayName: 'Advanced: Custom File Path',
			name: 'advancedPath',
			type: 'boolean',
			default: false,
			displayOptions: { show: { storage: ['sqlite'] } },
			description:
				'Whether to store the SQLite file at an explicit path instead of the auto-managed location. For advanced users.',
		},
		{
			displayName: 'SQLite File Path',
			name: 'sqliteFile',
			type: 'string',
			default: '',
			displayOptions: { show: { storage: ['sqlite'], advancedPath: [true] } },
			placeholder: '/home/node/.n8n/vars-alice.sqlite',
			description:
				'Explicit path to the SQLite file (overrides Username / auto). Credentials pointing at the same path share the same variables. Keep the file on a mounted volume so data survives restarts.',
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
		{
			displayName: 'Table Name',
			name: 'table',
			type: 'string',
			default: 'n8n_variables',
			displayOptions: { show: { storage: ['mysql'] } },
			description:
				'MySQL table for this store. Use a separate table (or database) per credential for isolation. Letters, digits and underscore only.',
		},
		// ---- Common ----
		{
			displayName: 'Auto-create Table',
			name: 'autoCreateTable',
			type: 'boolean',
			default: true,
			description: 'Whether to create the variables table automatically if it does not exist',
		},
	];
}
