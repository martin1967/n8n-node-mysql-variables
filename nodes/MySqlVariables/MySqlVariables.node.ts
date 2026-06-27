import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeConnectionType,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { decryptValue, encryptValue, parseCredentials } from './GenericFunctions';
import { createStore, DuplicateKeyError } from './stores';

export class MySqlVariables implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'MySQL Variables',
		name: 'mySqlVariables',
		icon: 'file:mysqlVariables.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] }}',
		description:
			'Store and read dynamic & static variables (cookies, API keys, client id/secret) in MySQL or embedded SQLite, with per-account isolation, shared variables and AES-256-GCM encryption',
		defaults: {
			name: 'MySQL Variables',
		},
		usableAsTool: true,
		inputs: ['main'] as NodeConnectionType[],
		outputs: ['main'] as NodeConnectionType[],
		credentials: [
			{
				name: 'mySqlVariablesApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Get Variable',
						value: 'get',
						action: 'Get a variable by key',
						description: 'Read one variable (own first, then shared)',
					},
					{
						name: 'Get All Keys',
						value: 'getKeys',
						action: 'List visible variable keys',
						description: 'List keys visible to this account (own + shared)',
					},
					{
						name: 'Set Variable',
						value: 'set',
						action: 'Create or update a variable',
						description: 'Upsert a variable for this account',
					},
					{
						name: 'Create Variable',
						value: 'create',
						action: 'Create a variable',
						description: 'Insert a new variable, fail if it already exists',
					},
					{
						name: 'Update Variable',
						value: 'update',
						action: 'Update an existing variable',
						description: 'Update an existing own variable, fail if missing',
					},
					{
						name: 'Delete Variable',
						value: 'delete',
						action: 'Delete a variable',
						description: 'Remove an own variable entirely',
					},
					{
						name: 'Clear Variable',
						value: 'clear',
						action: 'Clear a variable value',
						description: "Empty an own variable's value but keep the key",
					},
				],
				default: 'get',
			},
			{
				displayName: 'Key',
				name: 'key',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'stripe_api_key',
				displayOptions: {
					show: { operation: ['get', 'set', 'create', 'update', 'delete', 'clear'] },
				},
				description: 'The variable key (unique per account)',
			},
			{
				displayName: 'Value Type',
				name: 'valueType',
				type: 'options',
				options: [
					{ name: 'String', value: 'string' },
					{ name: 'JSON', value: 'json' },
				],
				default: 'string',
				displayOptions: {
					show: { operation: ['set', 'create', 'update'] },
				},
			},
			{
				displayName: 'Value',
				name: 'value',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				displayOptions: {
					show: { operation: ['set', 'create', 'update'] },
				},
				description: 'Value to store. For the JSON value type, provide valid JSON.',
			},
			{
				displayName: 'Shared',
				name: 'shared',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: { operation: ['set', 'create', 'update'] },
				},
				description:
					'Whether other accounts can read this variable. Only the owner can edit or delete it.',
			},
			{
				displayName: 'Filter',
				name: 'filter',
				type: 'options',
				options: [
					{ name: 'All Visible (Own + Shared)', value: 'all' },
					{ name: 'Mine Only', value: 'mine' },
					{ name: 'Shared Only', value: 'shared' },
				],
				default: 'all',
				displayOptions: {
					show: { operation: ['getKeys'] },
				},
			},
			{
				displayName: 'Include Values',
				name: 'includeValues',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: { operation: ['getKeys'] },
				},
				description:
					'Whether to decrypt and include values in the output (otherwise only metadata is returned)',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: {
					show: { operation: ['get'] },
				},
				options: [
					{
						displayName: 'Owner Override',
						name: 'ownerOverride',
						type: 'string',
						default: '',
						description:
							"Read a specific owner's shared variable instead of resolving own-then-shared. Private variables of other accounts remain inaccessible.",
					},
					{
						displayName: 'Return Empty if Not Found',
						name: 'returnEmptyIfNotFound',
						type: 'boolean',
						default: false,
						description:
							'Whether to return an empty value instead of throwing an error when the key is missing',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const creds = parseCredentials(await this.getCredentials('mySqlVariablesApi'));
		if (!creds.account) {
			throw new NodeOperationError(
				this.getNode(),
				'The "Account" field is required in the MySQL Variables credential.',
			);
		}

		const owner = creds.account;
		const store = await createStore(creds);

		try {
			if (creds.autoCreateTable) {
				await store.ensureSchema();
			}

			for (let i = 0; i < items.length; i++) {
				try {
					const operation = this.getNodeParameter('operation', i) as string;

					if (operation === 'getKeys') {
						const filter = this.getNodeParameter('filter', i) as 'all' | 'mine' | 'shared';
						const includeValues = this.getNodeParameter('includeValues', i) as boolean;

						const rows = await store.list(filter, owner);
						for (const row of rows) {
							const out: IDataObject = {
								key: row.key,
								owner: row.owner,
								shared: !!row.shared,
								type: row.type,
								isMine: row.owner === owner,
								createdAt: row.created_at,
								updatedAt: row.updated_at,
							};
							if (includeValues) {
								const decrypted = decryptValue(row.value, creds.encryptionKey);
								out.value =
									row.type === 'json' && decrypted != null ? JSON.parse(decrypted) : decrypted;
							}
							returnData.push({ json: out, pairedItem: { item: i } });
						}
						continue;
					}

					const key = this.getNodeParameter('key', i) as string;
					let result: IDataObject;

					if (operation === 'get') {
						const options = this.getNodeParameter('options', i, {}) as IDataObject;
						const ownerOverride = ((options.ownerOverride as string) || '').trim();
						const returnEmpty = options.returnEmptyIfNotFound as boolean;

						const row = await store.getOne(key, owner, ownerOverride || undefined);

						if (!row) {
							if (returnEmpty) {
								result = { key, value: null, found: false };
							} else {
								throw new NodeOperationError(
									this.getNode(),
									`Variable "${key}" not found or not visible to account "${owner}".`,
									{ itemIndex: i },
								);
							}
						} else {
							const decrypted = decryptValue(row.value, creds.encryptionKey);
							result = {
								key: row.key,
								value:
									row.type === 'json' && decrypted != null ? JSON.parse(decrypted) : decrypted,
								owner: row.owner,
								shared: !!row.shared,
								type: row.type,
								isMine: row.owner === owner,
								found: true,
							};
						}
					} else if (operation === 'set' || operation === 'create' || operation === 'update') {
						const valueType = this.getNodeParameter('valueType', i) as string;
						const rawValue = this.getNodeParameter('value', i) as string;
						const shared = this.getNodeParameter('shared', i) as boolean;

						if (valueType === 'json') {
							try {
								JSON.parse(rawValue);
							} catch (jsonError) {
								throw new NodeOperationError(
									this.getNode(),
									`Value for "${key}" is not valid JSON: ${(jsonError as Error).message}`,
									{ itemIndex: i },
								);
							}
						}
						const encrypted = encryptValue(rawValue, creds.encryptionKey);

						if (operation === 'set') {
							await store.upsert(owner, key, encrypted, valueType, shared);
						} else if (operation === 'create') {
							try {
								await store.insert(owner, key, encrypted, valueType, shared);
							} catch (insertError) {
								if (insertError instanceof DuplicateKeyError) {
									throw new NodeOperationError(
										this.getNode(),
										`Variable "${key}" already exists for account "${owner}". Use "Set" or "Update" instead.`,
										{ itemIndex: i },
									);
								}
								throw insertError;
							}
						} else {
							const affected = await store.update(owner, key, encrypted, valueType, shared);
							if (affected === 0) {
								throw new NodeOperationError(
									this.getNode(),
									`Variable "${key}" not found for account "${owner}". You can only update your own variables.`,
									{ itemIndex: i },
								);
							}
						}

						result = { key, owner, shared, type: valueType, operation, success: true };
					} else if (operation === 'delete') {
						const affected = await store.remove(owner, key);
						result = { key, owner, deleted: affected > 0, operation };
					} else if (operation === 'clear') {
						const { existed } = await store.clearValue(owner, key);
						if (!existed) {
							throw new NodeOperationError(
								this.getNode(),
								`Variable "${key}" not found for account "${owner}".`,
								{ itemIndex: i },
							);
						}
						result = { key, owner, cleared: true, operation };
					} else {
						throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, {
							itemIndex: i,
						});
					}

					returnData.push({ json: result, pairedItem: { item: i } });
				} catch (error) {
					if (this.continueOnFail()) {
						returnData.push({
							json: { error: (error as Error).message },
							pairedItem: { item: i },
						});
						continue;
					}
					throw error;
				}
			}
		} finally {
			await store.close();
		}

		return [returnData];
	}
}
