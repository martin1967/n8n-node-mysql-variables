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
			'Store and read variables (cookies, API keys, client id/secret) in MySQL or embedded SQLite, with per-credential isolation and AES-256-GCM encryption',
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
						description: 'Read one variable by key',
					},
					{
						name: 'Get All Keys',
						value: 'getKeys',
						action: 'List all variable keys',
						description: 'List every key in this store',
					},
					{
						name: 'Set Variable',
						value: 'set',
						action: 'Create or update a variable',
						description: 'Upsert a variable',
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
						description: 'Update an existing variable, fail if missing',
					},
					{
						name: 'Delete Variable',
						value: 'delete',
						action: 'Delete a variable',
						description: 'Remove a variable entirely',
					},
					{
						name: 'Clear Variable',
						value: 'clear',
						action: 'Clear a variable value',
						description: "Empty a variable's value but keep the key",
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
				description: 'The variable key (unique within this store)',
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
				displayName: 'Include Values',
				name: 'includeValues',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: { operation: ['getKeys'] },
				},
				description:
					'Whether to decrypt and include values in the output (otherwise only keys and metadata are returned)',
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
		const store = await createStore(creds);

		try {
			if (creds.autoCreateTable) {
				await store.ensureSchema();
			}

			for (let i = 0; i < items.length; i++) {
				try {
					const operation = this.getNodeParameter('operation', i) as string;

					if (operation === 'getKeys') {
						const includeValues = this.getNodeParameter('includeValues', i) as boolean;

						const rows = await store.list();
						for (const row of rows) {
							const out: IDataObject = {
								key: row.key,
								type: row.type,
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
						const returnEmpty = options.returnEmptyIfNotFound as boolean;

						const row = await store.getOne(key);

						if (!row) {
							if (returnEmpty) {
								result = { key, value: null, found: false };
							} else {
								throw new NodeOperationError(this.getNode(), `Variable "${key}" not found.`, {
									itemIndex: i,
								});
							}
						} else {
							const decrypted = decryptValue(row.value, creds.encryptionKey);
							result = {
								key: row.key,
								value:
									row.type === 'json' && decrypted != null ? JSON.parse(decrypted) : decrypted,
								type: row.type,
								found: true,
							};
						}
					} else if (operation === 'set' || operation === 'create' || operation === 'update') {
						const valueType = this.getNodeParameter('valueType', i) as string;
						const rawValue = this.getNodeParameter('value', i) as string;

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
							await store.upsert(key, encrypted, valueType);
						} else if (operation === 'create') {
							try {
								await store.insert(key, encrypted, valueType);
							} catch (insertError) {
								if (insertError instanceof DuplicateKeyError) {
									throw new NodeOperationError(
										this.getNode(),
										`Variable "${key}" already exists. Use "Set" or "Update" instead.`,
										{ itemIndex: i },
									);
								}
								throw insertError;
							}
						} else {
							const affected = await store.update(key, encrypted, valueType);
							if (affected === 0) {
								throw new NodeOperationError(
									this.getNode(),
									`Variable "${key}" not found. Use "Create" or "Set" to add it.`,
									{ itemIndex: i },
								);
							}
						}

						result = { key, type: valueType, operation, success: true };
					} else if (operation === 'delete') {
						const affected = await store.remove(key);
						result = { key, deleted: affected > 0, operation };
					} else if (operation === 'clear') {
						const { existed } = await store.clearValue(key);
						if (!existed) {
							throw new NodeOperationError(this.getNode(), `Variable "${key}" not found.`, {
								itemIndex: i,
							});
						}
						result = { key, cleared: true, operation };
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
