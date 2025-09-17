import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
    ListToolsRequest,
    CallToolRequest,
    CallToolResultSchema,
    CompatibilityCallToolResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import { getAgentId, getHostName, getIpAddress } from './metadata';
import { Syslog, CEF } from 'syslog-pro';
import { createStream as createRotatingFileStream, RotatingFileStream } from 'rotating-file-stream';
import { logger } from './logger';
import jwt from 'jsonwebtoken';
import { getTelemetryReporter } from './telemetry';
import { extensionEvents } from './events';

let toolCallCount : number = 0;

// For now we do not support TLS verification
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let hasValidApiKey: boolean = false;

const hostName = getHostName();

const descriptionPrefix: string =
fs.readFileSync(path.join(__dirname, 'tool_preference_prefix.txt'), 'utf8');

export function prefixToolDescriptions(response: any): any {
    if (!response?.tools || !Array.isArray(response.tools)) {
        return response;
    }
    
    const modifiedTools = response.tools.map((tool: any) => ({
        ...tool,
        description: tool.description ? `${descriptionPrefix}${tool.description}` : tool.description
    }));
    
    return {
        ...response,
        tools: modifiedTools,
    };
}

export interface LogRecord {
    toolName: string; // Name of the tool
    mcpServerName?: string; // Name of the target MCP server
    agentId?: string;
    hostName: string;
    ipAddress?: string;
    timestamp: string;
    params?: any; // Parameters for tool call
    _meta?: any;
    result?: any; // Result for successful call
    error?: any; // Error message, if any
    //   payload?: any; // Complete payload
}

// LogForwarder interface and management
export interface LogForwarder {
    forward(record: LogRecord): Promise<void>;
}

let logForwarders: LogForwarder[] = [];

export function addLogForwarder(forwarder: LogForwarder) {
    logForwarders.push(forwarder);
}

export function resetLogForwarders() {
    logForwarders.length = 0;
}

export async function forwardLog(record: LogRecord) {
    for (const forwarder of logForwarders) {
        await forwarder.forward(record);
    }
    
    toolCallCount++;
    getTelemetryReporter().sendTelemetryEvent('tappedToolCallCount', {}, { 'count': toolCallCount });
}

export function isForwarding(): boolean {
    return logForwarders.length > 0;
}

export function initForwarding(fowardersConfig: any[], secrets?: Record<string, string>): void {
    // First, process any new secrets that may have been dropped.
    logger.info('Initializing loggers based on configuration...');
    
    // De-initialize old loggers here if necessary...
    resetLogForwarders();
    
    for (const forwarderConfig of fowardersConfig) {
        try {
            switch (forwarderConfig.type) {
                case 'HEC': {
                    const token = secrets?.[forwarderConfig.tokenSecretKey];
                    if (token) {
                        addLogForwarder(new HECForwarder({ ...forwarderConfig, token }));
                        logger.info(`Set up HEC forwarder: "${forwarderConfig.name}"`);
                    } else {
                        logger.error(`Secret key ${forwarderConfig.tokenSecretKey} not found for HEC forwarder ${forwarderConfig.name}. Not creating it.`);
                    }
                    break;
                }
                
                case 'CEF': {
                    addLogForwarder(new CEFForwarder(forwarderConfig));
                    logger.info(`Set up CEF/Syslog forwarder: ${forwarderConfig.name}`);
                    break;
                }
                
                case 'FILE': {
                    if (path.isAbsolute(forwarderConfig.path)) {
                        addLogForwarder(new FileForwarder(forwarderConfig));
                        logger.info(`Set up file forwarder: ${forwarderConfig.name} to path ${forwarderConfig.path}`);
                    }
                    else {
                        logger.error(`Provided invalid absolute path ${forwarderConfig.path} for file forwarder ${forwarderConfig.name}. Not creating it.`);
                    }
                    break;
                }
                
                default:
                throw new Error(`Unknown forwarder type ${forwarderConfig.type}`);
            }
        } catch (e) {
            logger.error(`Could not create forwarder ${forwarderConfig.name}`, e);
        }
    }

    // Finally set the API if it is part of the secrets
    if (secrets?.API_KEY) {
        logger.info("API key set, validating");

        hasValidApiKey = verifyApiKey(secrets.API_KEY);
    } else {
        hasValidApiKey = false;
    }

    const forwardersCount = fowardersConfig.reduce((acc, config) => {
        acc[config.type] = (acc[config.type] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);
    getTelemetryReporter().sendTelemetryEvent('configuredForwardersCount', forwardersCount);
}

// ConsoleLogger implementation
export class ConsoleLogger implements LogForwarder {
    async forward(record: LogRecord): Promise<void> {
        console.info('MCP Event', record);
    }
}

// HEC Forwarder
export class HECForwarder implements LogForwarder {
    private url: string;
    private token: string;
    private sourcetype?: string;
    private index?: string;
    
    constructor(config: any) {
        this.url = config.url;
        this.token = config.token;
        this.sourcetype = config.sourcetype;
        this.index = config.index;
    }
    
    async forward(record: LogRecord): Promise<void> {
        // Send log to Splunk HEC endpoint
        const urlObj = new URL(this.url);
        const payload: any = {
            event: record,
            sourcetype: this.sourcetype || 'mcp:event',
            source: getAgentId(),
            index: this.index,
            time: Date.parse(record.timestamp) / 1000
        };
        const data = JSON.stringify(payload);
        
        const options: any = {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname,
            method: 'POST',
            headers: {
                'Authorization': `Splunk ${this.token}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };
        
        // Use https or http
        const httpModule = urlObj.protocol === 'https:' ? require('https') : require('http');
        
        try {
            await new Promise<void>((resolve, reject) => {
                const req = httpModule.request(options, (res: any) => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve();
                    } else {
                        let body = '';
                        res.on('data', (chunk: any) => { body += chunk; });
                        res.on('end', () => {
                            reject(new Error(`HEC responded with status ${res.statusCode}: ${body}`));
                        });
                    }
                });
                req.on('error', (err: any) => {
                    reject(err);
                });
                req.write(data);
                req.end();
            });
        } catch (error) {
            logger.error(`Failed to forward log to HEC endpoint ${this.url}`, error);
        }
    }
}

// CEF/Syslog Forwarder
export class CEFForwarder implements LogForwarder {
    private syslogClient: Syslog;
    
    constructor(config: any) {
        this.syslogClient = new Syslog({
            target: config.host,
            port: config.port,
            protocol: config.protocol
        })
    }
    
    async forward(record: LogRecord): Promise<void> {
        const event = new CEF({
            deviceVendor: 'Agentity',
            deviceProduct: record.agentId,
            deviceVersion: require(path.join(__dirname, '..', 'package.json')).version || '1.0',
            deviceEventClassId: record.toolName,
            name: record.toolName,
            severity: 1,
            
            extensions: {
                ...{
                    rt: record.timestamp,
                    shost: record.hostName,
                    src: record.ipAddress,
                    dserver: record.mcpServerName,
                    dtool: record.toolName,
                    outcome: record.error ? 'error' : 'success'
                },
                ...(record.params && { params: JSON.stringify(record.params) }),
                ...(record._meta && { meta: JSON.stringify(record._meta) }),
                ...(record.result && { result: JSON.stringify(record.result) }),
                ...(record.error && { error: JSON.stringify(record.error) }),
                ...{ rawEvent: JSON.stringify(record) }
            },
            server: this.syslogClient
        });
        
        try {
            await event.send();
        } catch (error) {
            logger.error(`Failed to forward log to CEF/Syslog target ${this.syslogClient.target}`, error);
        }
    }
}

// File Forwarder
export class FileForwarder implements LogForwarder {
    private stream: RotatingFileStream;
    private path: string;
    
    constructor(config: any) {
        // Extract the directory and filename
        this.path = config.path;
        const logDirectory = path.dirname(config.path);
        const logFilename = path.basename(config.path);
        
        this.stream = createRotatingFileStream(logFilename, {
            path: logDirectory,
            size: config.maxSize || '10M',
            maxFiles: 1       // Set to 0 to ensure only the single active file is kept
        });
    }
    
    async forward(record: LogRecord): Promise<void> {
        try {
            this.stream.write(`${JSON.stringify(record)}\n`);

            // For some reason VSCode's FileSystemWatcher failed for me on MacOS. Doing this slightly hacky instead
            if (this.path.endsWith('mcp-tool-calls.log')) {
                extensionEvents.emit('logFileUpdated');
            }
        } catch (err) {
            logger.error(`Error writing record to log file ${this.path}`, err);
        }
    }
}

export const populateCallRequestData = (mcpServerName: string, params: CallToolRequest['params']): Partial<LogRecord> =>
    ({
    mcpServerName: mcpServerName,
    agentId: getAgentId(),
    hostName,
    ipAddress: getIpAddress(),
    timestamp: new Date().toJSON(),
    toolName: params.name,
    params: params.arguments,
    _meta: params._meta,
});

function verifyApiKey(apiKey: string) : boolean {
    const publicKey = fs.readFileSync(path.join(__dirname, 'jwt-signing-key.pub'), 'utf8');

    try {
        const decoded = jwt.verify(apiKey, publicKey, { algorithms: ['RS256'] });

        logger.info('API Key validates successfuly');
        return true;
    } catch (err) {
        console.error('Failed validating API key, responses and errors will not be logged');
        return false;
    }
}

export function fillResultData(result: any, record: Partial<LogRecord>) {
    const GET_API_KEY_STR = "Get an API key on audit.agentity.com";
    if (result && !result.isError) {
        if (hasValidApiKey) {
            record.result = result.structuredContent || result.content; // Prefer structuredContent if available
        } else {
            record.result = GET_API_KEY_STR;
        }
    } else {
        if (hasValidApiKey) {
            if (result.isError) {
                record.error = result.content || 'Unknown error';
            } else {
                record.error = result.error;
            }
        } else {
            record.error = GET_API_KEY_STR;
        }
    }
}

// A custom client class that extends the base MCP Client to intercept tool lists and calls.
export class ToolTappingClient extends Client {
    private originalTargetName: string = "";
    
    init(name: string) {
        this.originalTargetName = name;
    }
    
    /**
    * Overrides the listTools method to modify the descriptions of the returned tools.
    * The base method returns an object with a 'tools' property.
    * @param params Parameters for listing tools.
    * @returns A promise that resolves to the modified list of tools response.
    */
    async listTools(
        params?: ListToolsRequest['params'],
        options?: RequestOptions
    ) {
        // First, retrieve the original result by running listTools of the superclass.
        const originalResponse = await super.listTools(params, options);
        
        return prefixToolDescriptions(originalResponse);
    }
    
    /**
    * Overrides the callTool method to log the tool call and its result.
    * The base method expects a single object for its parameters.
    * @param params The parameters for the tool call, including name and arguments.
    * @returns A promise that resolves to the result of the tool call.
    */
    async callTool(
        params: CallToolRequest['params'],
        resultSchema:
        | typeof CallToolResultSchema
        | typeof CompatibilityCallToolResultSchema = CallToolResultSchema,
        options?: RequestOptions
    ) {
        // Perform the original functionality by running callTool of the super class.
        const result = await super.callTool(params, resultSchema, options);
        
        const record: Partial<LogRecord> = populateCallRequestData(this.originalTargetName, params);
        fillResultData(result, record);
        
        // Forward the log to all registered log forwarders
        // Do NOT await - we want this to be async and non-blocking
        forwardLog(record as LogRecord);
       
        // Return the result.
        return result;
    }
}