import express, { Application, Request, Response } from 'express';
import { Server, IncomingMessage, ClientRequest } from 'http';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createParser, EventSourceMessage } from 'eventsource-parser';
import { 
    LogRecord, 
    populateCallRequestData, 
    prefixToolDescriptions, 
    fillResultData, 
    forwardLog 
} from './tap-services';
import { Readable } from 'stream';
import { logger } from './logger';

/*
The remote tap *could have been* implemented instead as an MCP server-client pair that proxies the
original client and server. We opted for the HTTP proxy instead which introduces some complexities, 
such as intercepting the streams. The reason is because this way we don't need to implement authn/authz
and simply relay whatever VScode implements as the MCP client.
*/

const app: Application = express();
let server: Server;
const PORT: number = 12358;

const toolCallRecords = new Map<string, Partial<LogRecord>>();
/*
Helper to create the key. Keys should live in the map only as long as there is a request pending a response
Note that there is potential for a clash and race condition here, if two separate clients have a request
to the same MCP server with the same event ID simultaneously. We could involve the remote port of the client,
but a client might in theory recreate the socket and listen to the same event id? Maybe not?
Anyway it *shouldn't* happen now as copilot doesn't call MCPs at once, but still good to keep this thing in mind.
*/
function toolCallKey(serverName: string, eventId: number) {
    return `${serverName}:${eventId}`;
}

/**
* This object will store our dynamic proxy configuration.
* The key is the sanitized path, and the value is the target URL.
* Using `Record<string, string>` provides type safety.
*/
let proxyConfig: Record<string, URL> = {};

// Used to store the current authorization server that is in the process of auth
let currentAuthTarget: string | undefined;

// This map dynamically stores a mapping for MCP servers that expose the PRM endpoint
// Since we want to redirect the clients to our own PRM endpoint, we will use this storage
// to retrieve the original PRM data
const originalPrmUris: Record<string, URL> = {};

export function updateProxyConfig(newConfig: Record<string, URL>): void {
    const sanitizedConfig: Record<string, URL> = {};
    if (typeof newConfig !== 'object' || newConfig === null || Array.isArray(newConfig)) {
        logger.error('Invalid configuration. New config must be a JSON object.');
        return;
    }
    for (const key in newConfig) {
        const sanitizedKey = encodeURI(key);
        
        try {
            // Validate that the value is a proper URL.
            sanitizedConfig[sanitizedKey] = new URL(newConfig[key]);
        } catch (error) {
            logger.warn(`[Config] Invalid URL format for key "${key}": "${newConfig[key]}". Skipping this entry.`);
        }
    }
    
    // Atomically replace the old configuration with the new one.
    proxyConfig = sanitizedConfig;
    logger.info('Proxy configuration updated. Active routes:',
        Object.entries(proxyConfig).map(([key, value]) => `/${key} -> ${value.toString()}`)
    );
}

export function createProxyUrl(origServerName: string, origTargetUrl: string): string {
    const origPath = new URL(origTargetUrl).pathname;
    return `http://127.0.0.1:${PORT}/${origServerName}${origPath}`;
}

export function startRemoteMcpProxy() {
    /*
    Support fallback to original MCP authorization (MCP 2025-03-26 spec) where resource server is authorization server as well. This route will only be called in that case.
    Dynamically create the content expected at the protected resource metadata endpoint. All VScode supporting MCP know how to handle PRM.
    Point to the original target as the authorization server directly, without passing through the proxy. This would cause VScode to see this as the same 
    authentication provider and retrieve the same session as for the original MCP server, avoiding re-authentication by the user and not showing a new 
    auth provider under localhost. After the auth is complete, VScode will return to the tap server as the resource server.
    Note that VScode will ask the user to allow the authentication, but it will not trigger the full OAuth flow. The consent is local to the VScode
    to let a new MCP server use the existing session.
    */
    app.use(new RegExp('/.well-known/oauth-protected-resource/([^/]+)(.*)'), async (req, res, next) => {
        try {
            const server = req.params[0];
            const rest = req.params[1];
            const resourceValue = `http://127.0.0.1:${PORT}/${server}${rest}`;

            const originalPrmUri = originalPrmUris[server];
            let resourceMetadata: Record<string, any> = {
                resource_name: server,
                authorization_servers: [proxyConfig[server!].origin],
                bearer_methods_supported: ['header'],
                // Scopes are missing since we don't know them - we assume the default OAuth client app will set them correctly
            };
            if (originalPrmUri) {
                // If there was an original PRM that we proxied, then get its original values (we will override resource)
                const response = await fetch(originalPrmUri);
                if (response.ok) {
                    resourceMetadata = await response.json() as Record<string, any>;
                }
            }
            // Fix the resource value to point to our proxy gateway
            resourceMetadata.resource = resourceValue; 
            
            res.status(200).json(resourceMetadata);
        }
        catch (err) {
            // Catch-all to make sure express correctly handled async rejections
            next(err); 
        }
    });
    
    /*
    These paths are the last callback, they will only be called if the MCP server supports auth, is the auth server, but doesn't expose the expected
    /.well-known/oauth-authorization-server endpoint. The client will fallback to the expected path and expect the MCP server to support them.
    In this case, simply proxy through to the original server. VScode will see this as a new authentication provider on localhost and expect the user
    to re-authenticate.
    */
    const authMiddleware = createProxyMiddleware<Request, Response>({
        router: () => currentAuthTarget,
        pathRewrite: (path, req: Request) => req.originalUrl, // Avoid omitting the matching part
        changeOrigin: true,
        //logger: console, // Use this when testing
    });
    app.use('/register', authMiddleware);
    app.use('/token', authMiddleware);
    app.use('/authorize', authMiddleware);
    
    app.use(express.json()); // The order between the two app.use MATTERS
    
    /*
    * This middleware handles all HTTP requests to /[server], except for the fallbacks handled above.
    * It looks up the `server` in our `proxyConfig` and forwards the request.
    */
    app.use(
        '/:server',
        (req: Request, res: Response, next) => {
            // This is a fix taken from https://github.com/chimurai/http-proxy-middleware/issues/472#issuecomment-2623306291
            // Essentially the proxy is called with buffer and headers guaranateed to be ready, avoiding race conditions
            const contentType = req.header('Content-Type');
            const headers = {} as Record<string, string>;
            
            const buffer = new Readable();
            if (contentType) {
                headers['Content-Type'] = contentType;
                headers['Content-Length'] = String(Buffer.byteLength(JSON.stringify(req.body)));
                buffer.push(JSON.stringify(req.body));
                buffer.push(null);
            }
            
            createProxyMiddleware({
                ...(contentType && { headers }),
                ...(contentType && { buffer }),
                pathFilter: (path, req: Request) => req.params.server in proxyConfig, // Return 404 if unproxied server
                router: (req: Request) => proxyConfig[req.params.server].origin, // Dynamically target to MCP server based on server in path
                changeOrigin: true,
                //logger: console, // Use this when testing
                selfHandleResponse: true, // necessary to use interceptors
                on: {
                    proxyReq: logRequests,
                    proxyRes: fixResponses
                },
            })(req, res, next);
        }
    );
    
    function logRequests(proxyReq: ClientRequest, req: Request) {
        const jsonRPCMessage = req.body;
        
        const targetMcpServer = req.baseUrl.slice(1); // Skip leading '/'
        
        if (jsonRPCMessage?.method === 'tools/call') {
            const eventId: number = req.body.id;
            const params: any = req.body.params;
            
            const record: Partial<LogRecord> = populateCallRequestData(targetMcpServer, params);
            
            // Store the call record, to be completed once the response is received
            toolCallRecords.set(toolCallKey(targetMcpServer, eventId), record);
        }
    }
    
    // Streaming proxyRes handler for JSON tool lists
    function fixResponses(proxyRes: IncomingMessage, req: Request, res: Response) {
        const targetMcpServer = req.baseUrl.slice(1); // Skip leading '/
        
        res.status(proxyRes.statusCode!);
        res.statusMessage = proxyRes.statusMessage!;

        const resourceMetadataRegex = new RegExp('^( *)resource_metadata="(\\S*)"$');

        // Copy headers
        Object.entries(proxyRes.headers)
        .filter(([key, value]) => !['content-encoding', 'transfer-encoding'].includes(key))
        .forEach(([key, value]) => {
            if ((proxyRes.statusCode === 401) && (key === 'www-authenticate')) {
                currentAuthTarget = proxyConfig[targetMcpServer].origin;

                if (!value?.includes('resource_metadata')) {
                    // This is the case where server requires auth but doesn't support PRM per 2025-06-18 spec
                    // In this case we want to simulate that support through the proxy
                    const target = req.originalUrl;
                    // Note that the spec requires the well known part to be at the start of the path, so we put the target after
                    res.setHeader('www-authenticate',
                        `${value}, resource_metadata="http://127.0.0.1:${PORT}/.well-known/oauth-protected-resource${target}"`);
                } else {
                    // In this case, the MCP server supports and presents a PRM endpoint.
                    // In order to pass OAuth 2.0 PRM validation, we don't send the client to the original PRM
                    // but instead proxy it to one that we would present. We maintain the original endpoint in memory
                    // to retrieve the values from it once the client requests our PRM endpoint
                    if (value.indexOf("Bearer") != 0) {
                        throw new Error("www-authenticate header does not beging with Bearer as expected");
                    } 

                    const headerParams = (value as string).slice("Bearer".length + 1).split(',');
                    
                    const metadataParamIndex = headerParams.findIndex(param => !!param.match(resourceMetadataRegex));
                    // Such an index is found because of the previous if conditions
                    let [drop, spaces, originalPrmUri] = headerParams[metadataParamIndex].match(resourceMetadataRegex)!;
                    originalPrmUris[targetMcpServer] = new URL(originalPrmUri);
                    const target = req.originalUrl;
                    headerParams[metadataParamIndex] = `${spaces}resource_metadata="http://127.0.0.1:${PORT}/.well-known/oauth-protected-resource${target}"`;

                    res.setHeader('www-authenticate', `Bearer ${headerParams.join(',')}`);
                }
                } else {
                    res.setHeader(key, proxyRes.headers[key] as any);
                }
            });
            
            function handleResponseMessage(data: string) {
                const jsonRPCMessage = JSON.parse(data);
                
                const key = toolCallKey(targetMcpServer, jsonRPCMessage.id);
                const toolCallRecord = toolCallRecords.get(key);
                if (toolCallRecord) {
                    // This is the response to a tool call which was previously sent
                    // First remove the key from the map because a response was matched and it might be re-used in the future
                    toolCallRecords.delete(key);
                    
                    fillResultData(jsonRPCMessage.result, toolCallRecord);
                    // Forward the log to all registered log forwarders
                    // Do NOT await - we want this to be async and non-blocking
                    forwardLog(toolCallRecord as LogRecord);
                } else if (jsonRPCMessage.result) {
                    // Otherwise, check if this is a tools list
                    jsonRPCMessage.result = prefixToolDescriptions(jsonRPCMessage.result);
                }
                return jsonRPCMessage;
            }
            
            const contentType = proxyRes.headers['content-type'] || '';
            if (contentType === 'application/json') {
                let buffer = Buffer.alloc(0);
                proxyRes.on('data', (chunk: Buffer) => {
                    buffer = Buffer.concat([buffer, chunk]);
                });
                proxyRes.on('end', () => {
                    try {
                        const dataStr = buffer.toString('utf8');
                        const jsonRPCMessage = handleResponseMessage(dataStr);
                        // Maintain original trailing newlines since clients expect it
                        const trailingNewlinesMatch = dataStr.match(/\n*$/)?.[0] ?? '';
                        const response = `${JSON.stringify(jsonRPCMessage)}${trailingNewlinesMatch}`;
                        res.setHeader('Content-Length', Buffer.byteLength(response, 'utf8'));
                        res.write(response);
                    } catch (err) {
                        logger.error("JSON stream error:", err);
                        res.write(buffer); // Write original buffer in case we had issue in manipulation
                    }
                    res.end();
                });
                proxyRes.on('error', (err: Error) => {
                    logger.error("JSON stream error:", err);
                    res.end();
                });
                
            } else if (contentType === 'text/event-stream') {
                // In case the server set it, remove it. Client shuld handle text/event-stream without Content-Length correctly
                res.removeHeader('Content-Length');
                
                const sseParser = createParser({
                    onEvent: (event: EventSourceMessage) => {
                        // Format back to SSE and write to the client
                        if (event.id) res.write(`id: ${event.id}\n`);
                        if (event.event) res.write(`event: ${event.event}\n`);
                        if (event.event === 'message') {
                            try {
                                const jsonRPCMessage = handleResponseMessage(event.data);
                                res.write(`data: ${JSON.stringify(jsonRPCMessage)}\n\n`);
                                return;
                            } 
                            catch (e) {
                                // If data is not JSON, pass it through unmodified
                            }
                        } else if (event.event === 'endpoint') {
                            // Legacy requests endpoint for HTTP + SSES format. Fix the endpoint to go through our proxy
                            res.write(`data: ${req.baseUrl}${event.data}\n\n`);
                            return;
                        }
                        res.write(`data: ${event.data}\n\n`);
                    }
                });
                
                proxyRes.on('data', (chunk: Buffer) => sseParser.feed(chunk.toString()));
                proxyRes.on('end', () => res.end());
                proxyRes.on('error', (err: Error) => {
                    logger.error("SSE proxy stream error:", err);
                    res.end();
                });
            } else {
                // Not JSON, just pipe through
                proxyRes.pipe(res);
            }
            
        }
        
        
        server = app.listen(PORT, '127.0.0.1', () => {
            logger.info(
                `Configurable proxy server listening on http://localhost:${PORT}`
            );
            logger.info('Call updateProxyConfig to set up proxy routes.');
        });
    }
    
    export function stopRemoteMcpProxy() {
        if (!server) {
            logger.warn("Attempting stop proxy that wasn't started");
            return;
        }
        
        server.close();
    }