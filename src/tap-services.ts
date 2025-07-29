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
import tls from 'tls';
import net from 'net';
import { createStream as createRotatingFileStream, RotatingFileStream } from 'rotating-file-stream';

// For now we do not support TLS verification
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const hostName = getHostName();
const agentId = getAgentId();

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
}

export function isForwarding(): boolean {
    return logForwarders.length > 0;
}

export function initForwarders(fowardersConfig: any[], secrets?: Record<string, string>): void {
    // First, process any new secrets that may have been dropped.
    console.log('Initializing loggers based on configuration...');

    // De-initialize old loggers here if necessary...
    resetLogForwarders();

    for (const forwarderConfig of fowardersConfig) {
        try {
            switch (forwarderConfig.type) {
                case 'HEC': {
                    const token = secrets?.[forwarderConfig.tokenSecretKey];
                    if (token) {
                        addLogForwarder(new HECForwarder({ ...forwarderConfig, token }));
                        console.log(`Set up HEC forwarder: "${forwarderConfig.name}"`);
                    } else {
                        console.error(`Secret key ${forwarderConfig.tokenSecretKey} not found for HEC forwarder ${forwarderConfig.name}. Not creating it.`);
                    }
                    break;
                }

                case 'CEF': {
                    addLogForwarder(new CEFForwarder(forwarderConfig));
                    console.log(`Set up CEF/Syslog forwarder: ${forwarderConfig.name}`);
                    break;
                }

                case 'FILE': {
                    if (path.isAbsolute(forwarderConfig.path)) {
                        addLogForwarder(new FileForwarder(forwarderConfig));
                        console.log(`Set up file forwarder: ${forwarderConfig.name} to path ${forwarderConfig.path}`);
                    }
                    else {
                        console.error(`Provided invalid absolute path ${forwarderConfig.path} for file forwarder ${forwarderConfig.name}. Not creating it.`);
                    }
                    break;
                }

                default:
                    throw new Error(`Unknown forwarder type ${forwarderConfig.type}`);
            }
        } catch (e) {
            console.error(`Could not create forwarder ${forwarderConfig.name}`, e);
        }
    }
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
    }
}

// CEF/Syslog Forwarder
export class CEFForwarder implements LogForwarder {
    private syslogClient: Syslog;
    private isReachable: boolean;

    constructor(config: any) {
        this.syslogClient = new Syslog({
            target: config.host,
            port: config.port,
            protocol: config.protocol
        })

        // If TCP, verify connection by attempting to connect
        this.isReachable = false;
        if ((config.protocol === 'tcp') || (config.protocol === 'tls')) {
            let socket: net.Socket | tls.TLSSocket;
            const callback = () => {
                this.isReachable = true;
                socket.destroy();
            };
            if (config.protocol == 'tcp') {
                socket = net.connect({ port: config.port, host: config.host }, callback);
            } else {
                // For now, we do not support TLS verification
                socket = tls.connect({ port: config.port, host: config.host, rejectUnauthorized: false }, callback);
            }
            socket.on('error', () => {
                console.error('Syslog TCP connection cannot be established');
                socket.destroy();
            });
            socket.on('timeout', () => {
                socket.destroy();
            });
        } else {
            // Can't verify with UDP, assume reachable
            this.isReachable = true;
        }
    }

    async forward(record: LogRecord): Promise<void> {
        if (!this.isReachable) {
            // Do not attempt to send a log since the initial reachability check failed
            // This does mean that if the check failed to a temporary glitch it would not work until VScode restart or extension config change
            return;
        }

        const event = new CEF({
            deviceVendor: 'Agentity',
            deviceProduct: record.agentId,
            deviceVersion: require('../package.json').version || '1.0',
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

        return event.send().then(() => { });
    }
}

// File Forwarder
export class FileForwarder implements LogForwarder {
    private stream: RotatingFileStream;

    constructor(config: any) {
        // Extract the directory and filename
        const logDirectory = path.dirname(config.path);
        const logFilename = path.basename(config.path);

        this.stream = createRotatingFileStream(logFilename, {
            path: logDirectory,
            size: config.maxSize,
            maxFiles: 1       // Set to 0 to ensure only the single active file is kept
        });
    }

    async forward(record: LogRecord): Promise<void> {
        // TODO: Implement file log forwarding
        this.stream.write(`${JSON.stringify(record)}\n`);
    }
}

export const populateCallRequestData = (mcpServerName: string, params: CallToolRequest['params']): Partial<LogRecord> =>
({
    mcpServerName: mcpServerName,
    agentId,
    hostName,
    ipAddress: getIpAddress(),
    timestamp: new Date().toJSON(),
    toolName: params.name,
    params: params.arguments,
    _meta: params._meta,
});

export function fillResultData(result: any, record: Partial<LogRecord>) {
    if (result && !result.isError) {
        record.result = result.structuredContent || result.content; // Prefer structuredContent if available
    } else {
        if (result.isError) {
            record.error = result.content || 'Unknown error';
        } else {
            record.error = result.error;
        }
    }
}

// A custom client class that extends the base MCP Client to intercept tool lists and calls.
export class ToolTappingClient extends Client {
    private originalTargetName: string = "";
    private agentId?: string;

    init(name: string, agentId: string) {
        this.originalTargetName = name;
        this.agentId = agentId;
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