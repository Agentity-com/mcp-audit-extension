import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { getAgentId, getVSCodeFolder } from './metadata';
import {
    startRemoteMcpProxy,
    updateProxyConfig,
    createProxyUrl,
    stopRemoteMcpProxy,
} from './tap-remote-mcp';
import { initForwarding, isForwarding } from './tap-services';
import { DecryptError, InputVariableRetriever, VarRetrievalError } from './vscode_internal';
import { logger, SUPPRESS_STDOUT_LOGS_ENV_VAR_NAME } from './logger';
import { initializeTelemetry, getTelemetryReporter } from './telemetry';

const INPUT_VARIABLE_REGEX: RegExp = /^\$\{input:(.*?)\}$/;
const TAPPED_SERVER_SUFFIX = ' (tapped)';
const SECRET_STORAGE_KEY = 'mcpTapForwarderKeys'

/**
* Main activation function for the extension.
*/
export async function activate(context: vscode.ExtensionContext): Promise<void> {
    logger.info('Activating MCP Audit extension');

    initializeTelemetry(context);
    
    const getForwardersConfig = () => {
        const config = vscode.workspace.getConfiguration('mcpAudit');
        return config.get<any[]>('forwarders', []).filter(f => f.enabled);
    }
    
    const secrets = await loadSecretsFromFile(context);
    initForwarding(getForwardersConfig(), secrets);
    
    const provider = new TapMcpServerDefinitionProvider(context);
    let disposable = vscode.lm.registerMcpServerDefinitionProvider(
        'mcpAuditProvider',
        provider
    );
    context.subscriptions.push(disposable);
    
    disposable = vscode.workspace.onDidChangeConfiguration((event) => {
        const isMcpConfigAffectedPromise = new Promise<boolean>(resolve => {
            if (event.affectsConfiguration('mcp')) {
                logger.info('MCP servers configuration change detected.');
                resolve(true);
            } else {
                resolve(false);
            }
        });
        
        const isTapConfigAffectedPromise = new Promise<boolean>(resolve => {
            if (event.affectsConfiguration('mcpAudit')) {
                logger.info('Extension configuration change detected.');
                const wasForwarding = isForwarding();
                loadSecretsFromFile(context).then(secrets => {
                    initForwarding(getForwardersConfig(), secrets);
                    const isForwardingNow = isForwarding();
                    if (!wasForwarding && isForwardingNow) {
                        logger.info('Forwarding was disabled and is now enabled, which requires a refresh.');
                        resolve(true);
                    } else {
                        resolve(false);
                    }
                });
            } else {
                resolve(false);
            }
        });
        
        Promise.all([isMcpConfigAffectedPromise, isTapConfigAffectedPromise]).then(([mcpConfigChange, tapConfigChange]) => {
            if (mcpConfigChange || tapConfigChange) {
                logger.info('A configuration change requires a provider refresh.');
                provider.refresh();
            }
        });
    });
    context.subscriptions.push(disposable);
    
    /* 
    Activate the tap HTTP proxy server directly from the extension
    I considered instead spawning a subprocess proxy in resolveMcpServerDefinition when the servers are started,
    but then there is hook when the server is stopped in order to kill the zombie processes. Instead I opted to 
    just bundle the express app proxying all remote servers into the extension process directly.
    */
    startRemoteMcpProxy();

    const deploymentArg = secrets?.API_KEY
        ? { deploymentId: require('crypto').createHash('sha256').update(secrets.API_KEY).digest('hex') }
        : undefined;
    getTelemetryReporter().sendTelemetryEvent('extensionActivated', deploymentArg);
    
    logger.info('MCP Tap Extension active.');
}

export function deactivate(): void {
    stopRemoteMcpProxy();
    logger.info('MCP Tap Extension deactivated.');
}

/*
Load the log forwarders from the configuration
*/

async function loadSecretsFromFile(context: vscode.ExtensionContext): Promise<Record<string, string>> {
    let secretsPath: string;
    
    secretsPath = path.join(getVSCodeFolder(), 'mcp-tap-secrets.json');
    
    try {
        // Load the secrets provided into the secure storage
        const fileContent = await fs.readFile(secretsPath, 'utf-8');
        context.secrets.store(SECRET_STORAGE_KEY, fileContent);
        const parsedSecrets: Record<string, string> = JSON.parse(fileContent);
        
        // After storing, delete the file from the disk. 
        // The idea is that the file is only put for new secrets, loaded to secure storage and immediately deleted
        await fs.rm(secretsPath);
        logger.info('Successfully loaded updated secrets from file to secret storage');
    } catch (error: any) {
        // If the file doesn't exist, it's not an error. It just means no secrets were deployed.
        if ((error.code && error.code !== 'ENOENT')) {
            // For all other errors (e.g., permissions), log it and show an error message.
            logger.error('Failed to read or parse secrets file:', error);
        }
    }
    
    const secretsJson = await context.secrets.get(SECRET_STORAGE_KEY);
    return secretsJson ? JSON.parse(secretsJson) : {};
}

/**
* A server provider that creates a "tap" server configuration, pointing to our
* local tap script and passing the original server config as an argument.
*
* Important to note: The MCP extension only allows us to manipulate MCP servers by our own provider.
* That means we can't change the other pre-configured MCP servers. Therefore our implementation is to create
* a mirror for each one with the added tap functionality. If in the future VScode allows to manipulate existing MCP servers,
* it would be a better approach to tap into the preconfigured ones directly, because:
* 1) Cleaner config, with just one MCP server instead of two
* 2) No risk of having too many tools
* 3) No need to cause LLM to choose our version of hte tool
*/
class TapMcpServerDefinitionProvider implements vscode.McpServerDefinitionProvider {
    private _workspaceServers: string[] = [];
    private _globalServers: string[] = [];
    private _context: vscode.ExtensionContext;
    
    constructor(private readonly context: vscode.ExtensionContext) {
        this._context = context;
    }
    
    didChangeEmitter = new vscode.EventEmitter<void>();
    onDidChangeMcpServerDefinitions: vscode.Event<void> =
    this.didChangeEmitter.event;
    
    /**
    * Called by VS Code to discover all available servers.
    * This method now reads the entire configuration and returns a FULL tap configuration
    * object for each server it finds, dynamically choosing the tap type.
    */
    async provideMcpServerDefinitions(_token: vscode.CancellationToken): 
        Promise<vscode.McpServerDefinition[]> {
        if (!isForwarding()) {
            // Do not provide tapped MCP servers because there are no log forwarders, no reason
            // to set up tap
            logger.warn('No forwarders were loaded, extension will not tap MCP servers');
            return [];
        }
        
        const config = vscode.workspace.getConfiguration('mcp').inspect<{ [id: string]: any }>('servers');
        this._workspaceServers = Object.keys(config?.workspaceValue || {});
        this._globalServers = Object.keys(config?.globalValue || {});
        
        const servers = { ...config?.workspaceValue, ...config?.globalValue };
        
        // For workspace and global context, check if there are errors in parsing
        // the input variables. Remember that it has to do with internal data structures
        // of VSCode that are not accessible via the API. There is an underlying assumption here:
        // If the problem is due to format, a broader and earlier error would be thrown, so if we
        // reached DecryptError we can be sure it is the real issue
        const workspaceVarRetriever = new InputVariableRetriever(this._context, true);        
        const globalVarRetriever = new InputVariableRetriever(this._context, false); 
        let workspaceError, globalError: VarRetrievalError;
        try {
            await workspaceVarRetriever.getInputVariablesFromDB(false);
            workspaceError = 'none';
        }
        catch (err) {
            workspaceError = (err instanceof DecryptError) ? 'decrypt' : 'format';
        }
        try {
            await globalVarRetriever.getInputVariablesFromDB(false);
            globalError = 'none';
        }
        catch (err) {
            globalError = (err instanceof DecryptError) ? 'decrypt' : 'format';
        }
        
        const serverDefinitions: vscode.McpServerDefinition[] = [];
        const remoteMcpProxyConfig: Record<string, URL> = {};
        for (const [serverName, originalServerConfig] of Object.entries(servers)) {
            if (!originalServerConfig) {
                continue;
            }
            
            const tappedServerName = serverName + TAPPED_SERVER_SUFFIX;
            
            // Dynamically choose the tap configuration type based on the original config.
            const isStdio: boolean = originalServerConfig.type === 'stdio' || (!originalServerConfig.type && !originalServerConfig.url);
            let tapConfig: vscode.McpServerDefinition;
            if (isStdio) {
                // The following code is fail-open mechanism where we don't want to set up taps where we lack necessary input variables
                const isWorkspaceServer = serverName in this._workspaceServers;
                const varError = isWorkspaceServer ? workspaceError : globalError;
                if (varError !== 'none') {
                    // There was a problem getting the input variable values. Check if this server depends on them.
                    const envInputVars = Object.entries(originalServerConfig.env || {})
                        .filter(([key, val]) => typeof val === 'string' && INPUT_VARIABLE_REGEX.test(val));
                    if (envInputVars.length > 0) {
                        if (varError === 'format') {
                            // The server has input variables, and ther was an error parsing the structure.
                            // Avoid tapping it to not diturb MCP activities by the user
                            logger.error(`Not tapping ${serverName} because there was a format error parsing input variables that it requires.`);
                            continue;
                        }
                        // This is the case where varError === `decrypt` - there was an issue decrypting the secrets
                        // Get meta-data of all inputs required by this server and check if any of them is a secret
                        const config = vscode.workspace.getConfiguration('mcp').inspect<any[]>('inputs')!;
                        const secretInput = envInputVars.find(([key, val]) => {
                            const varName = INPUT_VARIABLE_REGEX.exec(val as string)![1]; // We know there is a match because we tested earlier
                            const input = (isWorkspaceServer ? config.workspaceValue : config.globalValue)?.find((i) => i.id == varName);
                            return input?.password;
                        });
                        if (secretInput) {
                            // The server has secret input variables, and we had a decryptin issue.
                            // Avoid tapping it to not diturb MCP activities by the user
                            logger.error(`Not tapping ${serverName} because there was an issue accessing password input variables that it requires.`);
                            continue; 
                        }
                    }
                }
                
                tapConfig = new vscode.McpStdioServerDefinition(
                    tappedServerName,
                    originalServerConfig.command,
                    originalServerConfig.args,
                    originalServerConfig.env
                );
            } else {
                // Reroute configuration to target our local proxy
                const proxyUrl = createProxyUrl(serverName, originalServerConfig.url);
                tapConfig = new vscode.McpHttpServerDefinition(tappedServerName, vscode.Uri.parse(proxyUrl), {});
                
                // We only re-target the origin, the path will be rewritten in the proxy
                remoteMcpProxyConfig[serverName] = new URL(new URL(originalServerConfig.url).origin);
            }
            serverDefinitions.push(tapConfig);
        }
        
        // Update proxy config with latest
        updateProxyConfig(remoteMcpProxyConfig);
        
        logger.info(`Providing ${serverDefinitions.length} full tapped server configurations.`);
        return serverDefinitions;
    }
    
    // Triggered when want to indicate the provider to update
    public refresh(): void {
        logger.info('TapMcpServerDefinitionProvider refresh requested.');
        // Fire the event. This tells VS Code to call provideMcpServerDefinitions() again.
        this.didChangeEmitter.fire();
    }
    
    /*
    Retrieve the values set for the input variables of the original MCP servers. If a value is not set then ask the user for input.
    There are currently no means to retrieve those variables via the vscode extension API so we use InputVariableRetriever to look into the internal state DB
    TO  DO: Support VS Code web
    */
    private async resolveInputVariables(inputVars: [string, string | number | null][], origServerName: string): Promise<Record<string, string | number | null>> {
        const resolvedVars: Record<string, string | number | null> = {};

        if (inputVars.length > 0) {
            // If there are input variables, we need to retrieve their value set for the original server from the workspace or global storage
            const isWorkspaceServer = this._workspaceServers.includes(origServerName);
            const varRetriever = new InputVariableRetriever(this._context, isWorkspaceServer);
            let setInputVariables: Record<string, string | number | null>;
            try {
                // Accept the possibility of failed decryptions, since we at least want to have the regular input variables at hand in case no secrets needed for this server
                setInputVariables = await varRetriever.getInputVariablesFromDB(true);
            } catch (err) {
                // In general we hope to avoid this situation by checking whether we can get the input variables in provideMcpServerDefinitions
                // and not tapping problematic servers. If we alreay reached the point where the user is attempting to activate one and we miss an input variable's value,
                // we'll prompt the user for it. It is also possible that input variable was plainly not set yet, or that the user launches an MCP server that does not use them.
                setInputVariables = {};
                logger.warn('Failed to retrieve input variables from the database. Internal storage implementation likely changed. Fix might be required');
            }
            
            for (let [key, val] of inputVars) {
                const varName = INPUT_VARIABLE_REGEX.exec(val as string)![1]; // We know there is a match because we tested earlier
                if (varName in setInputVariables) {
                    // Replace the input variable with its resolved value
                    resolvedVars[key] = setInputVariables[varName];
                } else {
                    // If the variable is not set, ask for input from the user
                    // First need to get informaton about expected input variable
                    const config = vscode.workspace.getConfiguration('mcp').inspect<any[]>('inputs')!;
                    const input = (isWorkspaceServer ? config.workspaceValue : config.globalValue)!.find((i) => i.id == varName);
                    
                    // Show input box
                    const inputVal: string | undefined = await vscode.window.showInputBox({ prompt: input.description, password: input.password });
                    // If input was provided, then save it in the DB for the ORIGINAL server. It would make both that and the tapped server work
                    if (inputVal) {
                        await varRetriever.saveInputVariableInDb(input, inputVal);
                        
                        // Finally add this to the resolved variables
                        resolvedVars[key] = inputVal;
                    } else {
                        // Set null to override original env, otherwise it would still have the input variable format
                        resolvedVars[key] = null;
                    }
                }
            }
        }
        
        return resolvedVars;
    }
    
    /**
    * Called by VS Code when it needs the full details to launch a server.
    * This is where we define the stdio process for our tap server.
    */
    async resolveMcpServerDefinition(
        server: vscode.McpServerDefinition,
        token: vscode.CancellationToken
    ): Promise<vscode.McpServerDefinition> {
        const origServerName = server.label.substring(0, server.label.lastIndexOf(TAPPED_SERVER_SUFFIX));
        logger.info(`Launching MCP tap server for: ${origServerName}`);
        
        if (server instanceof vscode.McpStdioServerDefinition) {
            // Path to our bundled tap server script
            const relativeScriptPath = path.join(
                this._context.extensionMode === vscode.ExtensionMode.Test ? 'out' : 'dist',
                'tap-local-mcp.js'
            );
            const tapScriptPath = this._context.asAbsolutePath(relativeScriptPath);
            
            // This is the new, in-memory configuration that VS Code will use.
            const tapArgs: string[] = [tapScriptPath];
            
            // Add environment variables if the original server has env options
            let env: Record<string, string | number | null> = {};
            if (server.env) {
                // Check if there are any input variables in the env
                const envInputVars = Object.entries(server.env).filter(
                    ([key, val]) => typeof val === 'string' && INPUT_VARIABLE_REGEX.test(val)
                );
                let resolvedEnvInputVars: Record<string, string | number | null> =
                (await this.resolveInputVariables(envInputVars, origServerName)) || {};
                env = {
                    [SUPPRESS_STDOUT_LOGS_ENV_VAR_NAME]: 1,
                    ...server.env,
                    ...resolvedEnvInputVars,
                };
            }
            const secretsJson = await this._context.secrets.get(SECRET_STORAGE_KEY);
            if (secretsJson) {
                Object.assign(env, { 'forwarderSecrets': secretsJson });
            }
            
            tapArgs.push('--mcp-server-name', origServerName);
            
            tapArgs.push('--agent-id', await getAgentId());
            
            // Add the --target flag, followed by the target itself and its arguments
            tapArgs.push('--target');
            tapArgs.push(server.command);
            if (server.args) {
                tapArgs.push(...server.args);
            }
            
            return new vscode.McpStdioServerDefinition(
                server.label, // Use the original server's label for the tap definition
                'node', // Command to run the tap script (Node.js)
                tapArgs, // Arguments for the tap script,
                env
            );
        } else {
            return server;
        }
    }
}