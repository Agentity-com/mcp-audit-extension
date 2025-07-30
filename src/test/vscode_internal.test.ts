import type * as vscode from 'vscode';
import { InputVariableRetriever } from '../vscode_internal';
import path from 'path';
import mock from 'mock-fs';
import fs from 'fs/promises';
import initSqlJs from 'sql.js';
import * as chai from 'chai';
import { getRandomValues, subtle, JsonWebKey } from 'crypto';

const expect = chai.expect;

const GLOBAL_STORAGE_PATH = 'global/storage';
const WORKSPACE_STORAGE_PATH = 'workspace/storage';

const KEY: JsonWebKey = JSON.parse("{\"alg\":\"A256GCM\",\"ext\":true,\"k\":\"UT0NLDPHWOnsI5rx69YGYRyNgTfkq-wiIPaK1VDAck8\",\"key_ops\":[\"encrypt\",\"decrypt\"],\"kty\":\"oct\"}");

async function encryptSecrets(unsealedSecrets: any) {
    const iv: Uint8Array = getRandomValues(new Uint8Array(12));
    
    const toSeal = JSON.stringify(unsealedSecrets);
    const key = await subtle.importKey('jwk', KEY, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const encrypted = await subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(toSeal),
    );        
    const encryptedBuf = new Uint8Array(encrypted);
    return {
        iv: btoa(String.fromCharCode(...iv)),
        value: btoa(String.fromCharCode(...encryptedBuf))
    }
}

describe('InputVariableRetriever Test Suite', () => {
    let context: vscode.ExtensionContext;
    let sql;
    
    const globalDbPath = path.join(GLOBAL_STORAGE_PATH, '..', 'state.vscdb');
    const workspaceDbPath = path.join(WORKSPACE_STORAGE_PATH, '..', 'state.vscdb');
        
    after(() => {
        mock.restore();
    });
    
    beforeEach(async () => {
        // Mock ExtensionContext
        context = {
            extension: {
                id: 'test.extension'
            },
            secrets: {
                get: async (key: string) => {
                    // We don't actually run encryption for SecretStorage, so just retrieve value from namespaced key as-is
                    const globalDb = new sql!.Database(await fs.readFile(globalDbPath));
                    const newKey = `secret://{"extensionId":"test.extension","key":"${key}"}`;
                    const res = globalDb.exec(`SELECT value FROM ItemTable WHERE key='${newKey}'`);
                    globalDb.close();
                    
                    return res[0].values[0][0];
                }
            } as any,
            globalStorageUri: { fsPath: GLOBAL_STORAGE_PATH },
            storageUri: { fsPath: WORKSPACE_STORAGE_PATH },
        } as any;

        // Set up initial DB
        sql = await initSqlJs();
        
        const globalDb = new sql!.Database();
        const workspaceDb = new sql!.Database();
        globalDb.run('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
        workspaceDb.run('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');

        // Assume this is run after the MCP encryption key has already been copied over outside of the extension
        // There is also a separate UT to check it is executed correctly by the extension
        const mcpKey = 'secret://{"extensionId":"test.extension","key":"mcpEncryptionKey"}';
        globalDb.run('INSERT INTO ItemTable (key, value) VALUES (?, ?)', [mcpKey, JSON.stringify(KEY)]);

        const initialVars = {
            "${input:workspace_var1}": {
                "value": "var1",
                "input": {
                    "id": "workspace_var1",
                    "type": "promptString",
                    "description": "Test variable",
                    "password":false
                }
            }
        };
        const initialSecretVars = {
            "${input:workspace_secret_var1}": {
                "value": "secret1",
                "input": {
                    "id": "workspace_secret_var1",
                    "type": "promptString",
                    "description": "Test variable",
                    "password":true
                }
            }
        };
        const dbData = JSON.stringify({
            values: initialVars,
            secrets: await encryptSecrets(initialSecretVars)
        });
        workspaceDb.run('INSERT INTO ItemTable (key, value) VALUES (?, ?)', ['mcpInputs', dbData]);
        
        mock({
            [globalDbPath]: Buffer.from(globalDb.export()),
            [workspaceDbPath]: Buffer.from(workspaceDb.export())
        });
        
        globalDb.close();
        workspaceDb.close();
    });
    
    afterEach(() => {
    });
    
    it('MCP encryption key is copied over', async () => {
        // First, set up the base mcpEncryptionKey that VScode normally saves
        let globalDb = new sql!.Database();
        
        const mcpKey = 'secret://mcpEncryptionKey';
        const mcpValue = Buffer.from('TESTSECRET');
        const serializedMcpValue = JSON.stringify(mcpValue.toJSON());
        
        globalDb.run('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
        globalDb.run('INSERT INTO ItemTable (key, value) VALUES (?, ?)', [mcpKey, serializedMcpValue]);
        
        mock({ [globalDbPath]: Buffer.from(globalDb.export()) });
        
        globalDb.close();
        
        // Now check that it has been copied over correctly
        const retriever = new InputVariableRetriever(context, true);
        await new Promise(resolve => setTimeout(resolve, 500)); // Wait to confirm key was copied
        
        globalDb = new sql!.Database(await fs.readFile(globalDbPath));
        const newKey = 'secret://{"extensionId":"test.extension","key":"mcpEncryptionKey"}';
        const res = globalDb.exec(`SELECT value FROM ItemTable WHERE key='${newKey}'`);
        globalDb.close();
        
        expect(res, 'Row with the new key format was not found in the global database').to.exist;
        
        const parsedBuf = Buffer.from(JSON.parse(res[0].values[0][0]));
        const secret = new TextDecoder().decode(parsedBuf);
        
        expect(secret).to.equal('TESTSECRET', 'The retrieved secret is incorrect');
    });

    it('Input variables are retrieved from the database', async() => {
        const retriever = new InputVariableRetriever(context, true);
        const vars = await retriever.getInputVariablesFromDB();
        expect(vars).to.deep.equal({
            'workspace_var1': 'var1',
            'workspace_secret_var1': 'secret1'
        });
    })

    it('New input variables are stored database', async() => {
        const retriever = new InputVariableRetriever(context, false);
        let vars = await retriever.getInputVariablesFromDB();
        // Initial DB is empty
        expect(vars).to.deep.equal({});

        await retriever.saveInputVariableInDb({
            "id": "global_var1",
            "type": "promptString",
            "description": "Test variable",
            "password":false
        }, 'var1');
        await retriever.saveInputVariableInDb({
            "id": "global_secret_var1",
            "type": "promptString",
            "description": "Test variable",
            "password": true
        }, 'secret1');

        vars = await retriever.getInputVariablesFromDB();
        expect(vars).to.deep.equal({
            'global_var1': 'var1',
            'global_secret_var1': 'secret1'
        });

        await retriever.saveInputVariableInDb({
            "id": "global_var2",
            "type": "promptString",
            "description": "Test variable",
            "password":false
        }, 'var2');
        await retriever.saveInputVariableInDb({
            "id": "global_secret_var2",
            "type": "promptString",
            "description": "Test variable",
            "password": true
        }, 'secret2');
        vars = await retriever.getInputVariablesFromDB();
        expect(vars).to.deep.equal({
            'global_var1': 'var1',
            'global_var2': 'var2',
            'global_secret_var1': 'secret1',
            'global_secret_var2': 'secret2'
        });
    })

    it('Errors decrypting secrets are handled correctly', async() => {
        context.secrets.get = async (key) => "wrong_key";
        const retriever = new InputVariableRetriever(context, true);
        await retriever.getInputVariablesFromDB(false).should.be.rejected;
        // If decryption is allowed to fail then only non-secret inputs will be retreived
        const vars = await retriever.getInputVariablesFromDB(true);
        expect(vars).to.deep.equal({
            'workspace_var1': 'var1'
        });
    });
});
