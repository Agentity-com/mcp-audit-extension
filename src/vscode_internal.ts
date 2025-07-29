import { getRandomValues, subtle, webcrypto, JsonWebKey } from 'crypto';
import { ExtensionContext, SecretStorage } from 'vscode';
import fs from 'fs/promises';
import path from 'path';
import initSqlJs, { type Database } from 'sql.js';
import { logger } from './logger';

/*
This module contains logic that 'hacks' internal VS code structures. We only use this for capabilities
that we need but are not exposed in the vscode API. It leverages internal implementation that is subject
to change unexpectedly. We would need robust integration testing with vscode-test to launch real VScodes 
and verify our underlying assumptions still hold.
*/


const MCP_ENCRYPTION_KEY = 'mcpEncryptionKey';
const MCP_ENCRYPTION_KEY_ALGORITHM = 'AES-GCM';

export class DecryptError extends Error { }
export type VarRetrievalError = 'none' | 'decrypt' | 'format';

/*
This class is used to retrieve the values of input variables of MCP servers. These are namespaced in a way
that makes them inaccessible using the vscode API's ExtensionContext.
To workaround it, we look inside the internal state sqlite DB on the disk. This allows us to retrieve the 
values of input variables so that we could launch the tapped MCP servers correctly. If a tapped server is 
launched and the original doesn't have input variables set, we will prompt the user for input and write the 
input into the state of the ORIGINAL server, serving both it and the tap.
For secret input variables, we also need to gain access to the MCP encryption key. We do this by copying the
encrypted key into our extension's namespace in the DB, and then SecretStorage decrypts it successfuly.
It's important to note that VScode loads the storage to memory only when it starts. It means that whatever
we write to the DB will only be reflected on the next VScode restart.
*/
export class InputVariableRetriever {
    private _dbPath: string;
    private _globalDbPath: string;
    private _secretStorage: SecretStorage;
    private _extensionId: string;
    
    constructor(context: ExtensionContext, isWorkspace: boolean) {
        const extStoragePath = isWorkspace ? context.storageUri!.fsPath : context.globalStorageUri.fsPath;
        this._dbPath = path.join(extStoragePath, '..', 'state.vscdb');
        this._globalDbPath = path.join(context.globalStorageUri.fsPath, '..', 'state.vscdb');
        
        this._secretStorage = context.secrets;
        this._extensionId = context.extension.id.toLowerCase();
        
        this.copyEncryptionKey();
    }
    
    // We use sql.js because it has no native dependencies and allows us to ship one VSIX
    // Load the DB into memory
    private async getDB(isGlobal: boolean = false): Promise<Database> {
        const dbBytes = await fs.readFile(isGlobal ? this._globalDbPath : this._dbPath);
        
        try {
            const SQL = await initSqlJs();
            return new SQL.Database(dbBytes);        
        } catch (ex) {
            logger.error('Error loading database', ex);
            throw ex;
        }
    }
    
    private async writeDB(db: Database, isGlobal: boolean = false) : Promise<void> {
        // Only write to disk if there was a change in memory
        if (db.getRowsModified() > 0) {
            const newDbBytes = db.export();
            await fs.writeFile(isGlobal ? this._globalDbPath : this._dbPath, newDbBytes);
        }
    }
    
    /*
    We copy the encrypted key used to encrypt MCP secret input variables into our namespace to trick SecretStorage to load it.
    Important: This will not affect the current run of VScode, only the following one. This is because VScode loads the entire
    DB from disk only on start. This means that the key didn't exist in our namespace before this run, SecretStorage.get will
    be empty because it wasn't loaded before.
    This method is really here to ensure that for the *next* VScode run we will be in place to read secret inputs.
    We rely heavily on the fact that VScode creates the original key dynamically only if it hasn't existed before. If it was 
    already set, it *should* remain the same making our copy valid for a long time.
    */
    async copyEncryptionKey() : Promise<void> {
        let db: Database | null = null;
        try {
            // Note that the encryption key is always kept in the global storage
            db = await this.getDB(true);
            
            const result: any = db.exec(`SELECT value FROM ItemTable WHERE key = "secret://${MCP_ENCRYPTION_KEY}"`)[0];
            
            if (!result) {
                logger.warn('MCP encryption key was not set yet');
                return;
            }
            
            // Copy encrypted mcp encryption key from global VS code scope to the extension's scope
            const upsert = `INSERT INTO ItemTable (key, value)
                            VALUES (
                                'secret://{"extensionId":"${this._extensionId}","key":"${MCP_ENCRYPTION_KEY}"}',
                                '${result.values[0][0]}'
                            )
                            ON CONFLICT(key) DO UPDATE SET
                                value = excluded.value
                            WHERE
                                ItemTable.value IS DISTINCT FROM excluded.value;`;
            db.exec(upsert);
            this.writeDB(db, true);
            
        } catch (ex) {
            logger.error("Error while copying MCP encryption key", ex);
        } finally {
            if (db!) {
                db.close();
            }
        }
    }
    
    async getEncryptionKey(): Promise<webcrypto.CryptoKey | undefined> {
        const serializedKey = await this._secretStorage.get(MCP_ENCRYPTION_KEY);
        if (serializedKey) {
            try {
                const parsed: JsonWebKey = JSON.parse(serializedKey);
                return await subtle.importKey('jwk', parsed, MCP_ENCRYPTION_KEY_ALGORITHM, false, ['encrypt', 'decrypt']);
            } catch {
                // fall through
            }
        }
    }
    
    // The following decrypt and encrypt functions mimic the process used by VScode. If it or any of its parameters changes,
    // it will break our copy
    private async decryptSecretInputs(secrets: { iv: string, value: string }): Promise<Record<string, string | number>> {
        try {
            // Load key
            const secretKey = await this.getEncryptionKey();
            if (!secretKey) {
                logger.warn('MCP encryption key could not be retrieved. Likely need to restart VScode.');
                throw new DecryptError();
            }
            
            // Decrypt
            const iv = Uint8Array.from(atob(secrets.iv), c => c.charCodeAt(0));
            const encrypted = Uint8Array.from(atob(secrets.value), c => c.charCodeAt(0));
            const decrypted = await subtle.decrypt(
                { name: MCP_ENCRYPTION_KEY_ALGORITHM, iv: iv.buffer },
                secretKey!,
                encrypted.buffer
            );
            const decodedStr = new TextDecoder().decode(new Uint8Array(decrypted));
            return JSON.parse(decodedStr);
        } catch (ex) {
            logger.error('Failed to decrypt secret inputs', ex);
            throw new DecryptError();
        }
    }
    
    private async encryptSecretInputs(unsealedSecrets: any, ivStr?: string): Promise<{ iv: string, value: string }> {
        let iv: Uint8Array;
        if (ivStr) {
            iv = Uint8Array.from(atob(ivStr), c => c.charCodeAt(0));
        } else {
            iv = getRandomValues(new Uint8Array(12));
        }
        
        const toSeal = JSON.stringify(unsealedSecrets);
        const key = await this.getEncryptionKey();
        const encrypted = await subtle.encrypt(
            { name: MCP_ENCRYPTION_KEY_ALGORITHM, iv: iv },
            key!,
            new TextEncoder().encode(toSeal),
        );        
        const encryptedBuf = new Uint8Array(encrypted);
        return {
            iv: btoa(String.fromCharCode(...iv)),
            value: btoa(String.fromCharCode(...encryptedBuf))
        }
    }
    
    // Function to retrieve the input variables value stored on the disk in VScode's local storage
    async getInputVariablesFromDB(allowDecryptFailure = true): Promise<Record<string, string | number>> {
        let db: Database | null = null;
        const resolvedValues: Record<string, string | number> = {};
        try {
            db = await this.getDB();
            const row: any = db.exec('SELECT value FROM ItemTable WHERE key = \'mcpInputs\'')[0];
            if (row && row.values) {
                const updateResolvedValues = (vars: any[]) => {
                    for (const { input, value } of vars as { input: any; value: string; }[]) {
                        if (input && input.id) {
                            resolvedValues[input.id] = value;
                        }
                    }    
                };
                
                // Retrieve regular variables
                const mcpInputs = JSON.parse(row.values);
                const varData = Object.values(mcpInputs.values);
                updateResolvedValues(varData);
                
                // Retrieve the secret variables
                if (mcpInputs.secrets) {
                    let secretInputs;
                    try {
                        secretInputs = await this.decryptSecretInputs(mcpInputs.secrets);
                    } catch (err) {
                        if ((err instanceof DecryptError) && (!allowDecryptFailure)) {
                            // In this case we don't want to swallow the error
                            throw err;
                        } else { 
                            secretInputs = {};
                        }
                    }
                    updateResolvedValues(Object.values(secretInputs));
                }
            }
        } catch (ex) {
            logger.error('Error attempting to resolve input variables', ex);
            throw ex;
        } finally {
            if (db) {
                db.close();
            }
        }
        
        return resolvedValues;
    }
    
    // Function to save new input and value in the VScode's local storage
    async saveInputVariableInDb(input: any, value: string): Promise<void> {
        let db: Database | null = null;
        try {
            db = await this.getDB();
            const row: any = db.exec('SELECT value FROM ItemTable WHERE key = \'mcpInputs\'')[0];
            
            let mcpData: { version?: number, values: { [key: string]: any; }, secrets?: { iv: string, value: string } };
            try {
                // If row exists and has a value, parse it. Otherwise, start with a new object.
                mcpData = row && row.values ? JSON.parse(row.values) : { version: 1, values: {} };
            } catch (e) {
                logger.warn(`Failed to parse existing mcpInputs JSON, initializing a new one. Error:`, e);
                mcpData = { values: {} };
            }
            
            // The key is the input id adjusted to input variable format.
            const inputVarId = `\$\{input:${input.id}\}`;
            
            if (input.password) {
                // This needs to be added to the secrets
                
                // First decrypt the current secret inputs. 
                // If there are none - the variable to be saved is the first - then start with an empty dict and let's create it
                let secretInputs: any = {};
                if (mcpData.secrets) {
                    try {
                        secretInputs = await this.decryptSecretInputs(mcpData.secrets);
                    } catch (err) {
                        if (err instanceof DecryptError) {
                            // In case we have an issue decrypting, do not try to encrypt over it since we will lose the old secrets
                            throw err;
                        }
                    }
                }
                
                // Add input and encrypt
                secretInputs[inputVarId] = { value, input };
                
                mcpData.secrets = await this.encryptSecretInputs(secretInputs, mcpData.secrets?.iv);
            } else {
                // Add the new input variable data.
                // The structure is an object containing the original input definition and the new value.
                mcpData.values[inputVarId] = { value, input };
            }
            
            const newValue = JSON.stringify(mcpData);
            // Write the updated JSON blob back to the database.
            // "INSERT OR REPLACE" will either insert a new row or replace the existing one.
            db.run(`REPLACE INTO ItemTable (key, value) VALUES ('mcpInputs', '${newValue}')`);
            
            this.writeDB(db);
        } catch (ex) {
            logger.error('Error attempting to resolve input variables', ex);
        } finally {
            if (db) {
                db.close();
            }
        }
    }
}