import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import {
    OAuthClientMetadata,
    OAuthClientInformation,
    OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import chaiSubset from 'chai-subset';
import * as fs from 'fs';
import * as path from 'path';
import {
    startRemoteMcpProxy,
    stopRemoteMcpProxy,
    updateProxyConfig,
    createProxyUrl,
} from '../tap-remote-mcp';
import * as dummy_server from './dummy_server';
import {
    LogRecord,
    resetLogForwarders,
    initForwarding,
    isForwarding,
} from '../tap-services';
import * as dgram from 'dgram';
import { getHostName, getIpAddress } from '../metadata';
import tmp from 'tmp';
import net from 'net';
import tls from 'tls';
import selfsigned from 'selfsigned';
import http from 'http';
import https from 'https';
import mockFs from 'mock-fs';

chai.use(chaiAsPromised);
chai.use(chaiSubset);
const expect = chai.expect;
chai.should();

tmp.setGracefulCleanup();

const API_KEY = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJteS1hdXRoLXNlcnZpY2UiLCJzdWIiOiJ1c2VyLWlkLTEyMyIsImF1ZCI6Im15LWFwaSIsImlhdCI6MTc1ODAyNzYzNywiZXhwIjoxODQ0NDI3NjM3fQ.LvMgqkpR6Jieygv_JaIvrbmjjwmzj5azvCcOkmADTO95KQo8THarnJNNKphPcDplWzURDB5T9gd5CPi7_4_L1AXNWS9oh-xvfd_q4all8lSpXGAH0MEmN0vTXSah8yuC8i5snhDRFtEvYfv0lkq7PA-SkbulkWHNzwbOHlIrMHvmFRtbP2LEkc5bZ0A0EvAlqKtw1puILpfvW-AFdSib993V6Csg76zmYL5qRHk9Hi1K63x8EtWKYB6ozWBCdjfmBAJ75MaRFMaGk6_e0p-jCR_ZW_dTpgo-Ekn6SAmKHkDHb4dqrL0Rt9LMlLzNG0NxDlCuRvmuKlXTFgIBbVrwoA';

// TODO: This test file grew to suck, in particulal all the after and before. Learn Mocha fixtures better and refactor. Use AI.

describe('Tap Integration Test', () => {
    let client: Client;
    let tapMessages: LogRecord[];
    let syslogServer: dgram.Socket;
    let forwarderConfig: object;
    let proxyUrl: URL;

    const setProxyMcp = (mcpName: string, mcpUrl: string) => {
        const proxyUrl = new URL(
            new URL(createProxyUrl(mcpName, mcpUrl)).origin
        );
        updateProxyConfig({ [mcpName]: new URL(new URL(mcpUrl).origin) });
        return proxyUrl;
    };

    before(() => {
        // Setup a test syslog forwarder that we can use to check calls were tapped
        resetLogForwarders();

        syslogServer = dgram.createSocket('udp4');

        syslogServer.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
            const messageStr = msg.toString();
            tapMessages.push(JSON.parse(messageStr.slice(messageStr.indexOf("rawEvent=") + 9)));
        });
        syslogServer.bind(5514, '127.0.0.1');

        forwarderConfig = {
            type: "CEF",
            name: 'Test UDP',
            enabled: true,
            host: '127.0.0.1',
            port: 5514,
            protocol: 'udp'
        };
    });

    beforeEach(() => {
        tapMessages = [];
    });

    after(() => {
        syslogServer.close();
    });

    async function testToolDescriptionPrefix(
        client: Client<
            {
                method: string;
                params?:
                | {
                    [x: string]: unknown;
                    _meta?:
                    | {
                        [x: string]: unknown;
                        progressToken?: string | number | undefined;
                    }
                    | undefined;
                }
                | undefined;
            },
            {
                method: string;
                params?:
                | {
                    [x: string]: unknown;
                    _meta?: { [x: string]: unknown } | undefined;
                }
                | undefined;
            },
            {
                [x: string]: unknown;
                _meta?: { [x: string]: unknown } | undefined;
            }
        >
    ) {
        const prefixPath = path.join(
            __dirname,
            '..',
            'tool_preference_prefix.txt'
        );
        const toolPrefix = fs.readFileSync(prefixPath, 'utf-8').trim();

        const result = await client.listTools();
        expect(result.tools).to.be.an('array').with.length.greaterThan(0);
        for (const tool of result.tools) {
            expect(tool.description?.startsWith(toolPrefix)).to.be.true;
        }
    }

    async function testToolLogForwarding(
        client: Client<
            {
                method: string;
                params?:
                | {
                    [x: string]: unknown;
                    _meta?:
                    | {
                        [x: string]: unknown;
                        progressToken?: string | number | undefined;
                    }
                    | undefined;
                }
                | undefined;
            },
            {
                method: string;
                params?:
                | {
                    [x: string]: unknown;
                    _meta?: { [x: string]: unknown } | undefined;
                }
                | undefined;
            },
            {
                [x: string]: unknown;
                _meta?: { [x: string]: unknown } | undefined;
            }
        >,
        forwarderConfig: any,
        secrets: Record<string, string> = {},
        hasApiKey: boolean = true,
    ) {
        if (hasApiKey) {
            secrets = { ...secrets, API_KEY };
        }
        initForwarding([forwarderConfig], secrets);

        // Test the echo tool
        const echoResult = await client.callTool({
            name: 'echo',
            arguments: { s: 'test' },
        });
        expect((echoResult.content as any[])[0].text).to.equal('test');
        await new Promise(resolve => setTimeout(resolve, 500));
        const resultBase = {
            toolName: 'echo',
            mcpServerName: 'dummy_server',
            ipAddress: getIpAddress(),
            hostName: getHostName(),
            params: {
                s: 'test'
            }
        };
        expect(tapMessages).to.containSubset([{
            ...resultBase,
            result: hasApiKey ? [{ text: 'test' }] : 'Get an API key on audit.agentity.com' 
        }]);
    }

    describe('Remote MCP Servers Tap', () => {

        before(() => {
            startRemoteMcpProxy();
        });

        beforeEach(async () => {
            // Create a FastMCP client to connect to the tap process
            client = new Client({
                name: 'Dummy Client',
                version: '1.0.0',
            });
        });

        afterEach(async () => {
            await dummy_server.stopRemote();
            try {
                await client.close();
            } catch (ex) {
                console.warn('Couldn\'t close client');
            }
        });

        after(() => {
            stopRemoteMcpProxy();
        });

        describe('Auth and proxy tests', async () => {
            it('Should connect to remote server without authentication through proxy', async () => {
                await dummy_server.startRemote(false);
                const proxyUrl = setProxyMcp('dummy_server', 'http://127.0.0.1:8080');
                const transport = new StreamableHTTPClientTransport(
                    new URL('http://127.0.0.1:12358/dummy_server/mcp')
                );
                await client.connect(transport);
            });

            it('Should return error when trying to connect to an unproxied server', async () => {
                await dummy_server.startRemote();
                const proxyUrl = setProxyMcp('dummy_server', 'http://127.0.0.1:8080');
                const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:12358/not_declared/mcp'));
                await client.connect(transport).should.be.rejected;
            });

            // The purpose is to check that the remote MCP proxy dynamically creates PRM and redirects to the OAuth endpoint
            // While it's not a full integration test, I think it is important to have something to verify the complex dynamic flow
            // to simulate the 2025-06-18 spec even for servers that don't support it, this test is important to avoid breakages
            it('Should connect to remote server with authentication through proxy', async () => {
                // Spy storage
                let calledWithUrl: string | undefined = undefined;

                const dummyClientMetadata: OAuthClientMetadata = { client_name: 'test-client', redirect_uris: [] };
                const dummyClientInformation: OAuthClientInformation = { client_id: 'test-client' };

                // Minimal mock provider
                const provider: OAuthClientProvider = {
                    get redirectUrl() { return 'http://127.0.0.1/callback'; },
                    get clientMetadata() { return dummyClientMetadata; },
                    clientInformation() { return dummyClientInformation; },
                    tokens() { return undefined; },
                    saveTokens(tokens: OAuthTokens) { },
                    redirectToAuthorization(url: URL) { calledWithUrl = url.toString(); },
                    saveCodeVerifier(codeVerifier: string) { },
                    codeVerifier() { return 'dummy-code-verifier'; }
                };

                await dummy_server.startRemote(true);
                const proxyUrl = setProxyMcp('dummy_server', 'http://127.0.0.1:8080');
                const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:12358/dummy_server/mcp'), { authProvider: provider });
                await client.connect(transport).should.be.rejected;
                expect(calledWithUrl).to.contain('http://127.0.0.1:8080/oauth/authorize');
            });
        });

        describe('Streamable HTTP', async () => {
            let transport: StreamableHTTPClientTransport;

            beforeEach(async () => {
                const proxyUrl = setProxyMcp('dummy_server', 'http://127.0.0.1:8080');
                transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:12358/dummy_server/mcp'));
            });

            describe('text/event-stream responses', async () => {
                beforeEach(async () => {
                    await dummy_server.startRemote(false, false);
                    await client.connect(transport);
                });

                it('Should return tools with descriptions starting with the correct prefix', async () => {
                    await testToolDescriptionPrefix(client);
                });
            })

            describe('application/json responses', async () => {
                beforeEach(async () => {
                    await dummy_server.startRemote(false, true);
                    await client.connect(transport);
                });

                it('Should return tools with descriptions starting with the correct prefix', async () => {
                    await testToolDescriptionPrefix(client);
                });

                it('Should echo a value and forward the log', async () => {
                    await testToolLogForwarding(client, forwarderConfig);
                })

                it('Should not log results if no API key', async() => {
                    await testToolLogForwarding(client, forwarderConfig, {}, false);
                });
            })
        });

        describe('SSE', async () => {
            beforeEach(async () => {
                await dummy_server.startRemote();
                const proxyUrl = setProxyMcp(
                    'dummy_server',
                    'http://127.0.0.1:8080/sse'
                );
                const transport = new SSEClientTransport(
                    new URL('http://127.0.0.1:12358/dummy_server/sse')
                );
                await client.connect(transport);
            });

            it('Should return tools with descriptions starting with the correct prefix', async () => {
                await testToolDescriptionPrefix(client);
            });
        });
    });

    describe('Local MCP Servers Tap', () => {
        // These tests spin up a single local tap proxy server and tests its functionality

        function createTransport(hasApiKey: boolean = true) {
            const tapMcpPath = path.join(__dirname, '..', 'tap-local-mcp.ts');
            const dummyServerPath = path.join(__dirname, 'dummy_server.ts');

            const tmpSettingsFile = tmp.fileSync();
            const settings = {
                'mcpAudit.forwarders': [
                    forwarderConfig
                ]
            };
            fs.writeFileSync(tmpSettingsFile.name, JSON.stringify(settings));

            const transport = new StdioClientTransport({
                command: 'ts-node',
                args: [
                    tapMcpPath,
                    '--settings-file',
                    tmpSettingsFile.name,
                    '--mcp-server-name',
                    'dummy_server',
                    '--target',
                    'ts-node',
                    dummyServerPath,
                ],
                env: {
                    ...process.env,
                    DUMMY_ENV: 'dummy value',
                    // Update PATH for ts-node
                    PATH: `${path.join(
                        __dirname,
                        '..',
                        '..',
                        'node_modules',
                        '.bin'
                    )}${path.delimiter}${process.env.PATH}`,
                    forwarderSecrets: hasApiKey 
                                ? `{"API_KEY":"${API_KEY}"}`
                                : ''
                },
            });
            return transport;
        }

        before(async () => {
            const transport = createTransport(true);

            // Create a FastMCP client to connect to the tap process
            client = new Client({
                name: 'Dummy Client',
                version: '1.0.0',
            });

            await client.connect(transport);
        });

        after(async () => {
            await client.close();
        });

        it('Should return tools with descriptions starting with the correct prefix', async () => {
            // Read the prefix from the file
            await testToolDescriptionPrefix(client);
        });

        it('Should echo a value and forward the log', async () => {
            await testToolLogForwarding(client, forwarderConfig);
        });

        it('Should return the correct environment variable', async () => {
            // Test the env tool
            const envResult = await client.callTool({ name: 'env' });
            const envVars = JSON.parse((envResult.content as any[])[0].text);
            expect(envVars).to.have.property('DUMMY_ENV', 'dummy value');
        });

        it('Should not log results if no API key', async() => {
            const transport = createTransport(false);

            // Create a FastMCP client to connect to the tap process
            const clientWithoutApiKey = new Client({
                name: 'Dummy Client',
                version: '1.0.0',
            });

            await clientWithoutApiKey.connect(transport);
            await testToolLogForwarding(clientWithoutApiKey, forwarderConfig, {}, false);

            clientWithoutApiKey.close();
        });
    });

    describe('Forwarders', () => {
        let transport: StreamableHTTPClientTransport;

        before(async () => {
            startRemoteMcpProxy();
            await dummy_server.startRemote();
            const proxyUrl = setProxyMcp('dummy_server', 'http://127.0.0.1:8080');
            transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:12358/dummy_server/mcp'));
            client = new Client({ name: 'Dummy Client', version: '1.0.0' });
            await client.connect(transport);
        });

        beforeEach(() => {
            resetLogForwarders();
            tapMessages = [];
        });

        after(async () => {
            await dummy_server.stopRemote();
            await client.close();
            stopRemoteMcpProxy();
        });

        describe('CEF Forwarder', () => {
            let server: dgram.Socket | net.Server;

            afterEach(async () => {
                if (server) {
                    server.close();
                }
            });

            it('UDP', async () => {
                server = dgram.createSocket('udp4');

                server.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
                    const messageStr = msg.toString();
                    tapMessages.push(JSON.parse(messageStr.slice(messageStr.indexOf("rawEvent=") + 9)));
                });
                server.bind(6514, '127.0.0.1');

                const config = {
                    type: "CEF",
                    name: 'Test UDP',
                    enabled: true,
                    host: '127.0.0.1',
                    port: 6514,
                    protocol: 'udp'
                };
                await testToolLogForwarding(client, config);
            });

            it('TCP', async () => {
                server = net.createServer((socket: any) => {
                    socket.on('data', (data: Buffer) => {
                        const messageStr = data.toString();
                        if (messageStr.includes('rawEvent=')) {
                            tapMessages.push(JSON.parse(messageStr.slice(messageStr.indexOf("rawEvent=") + 9)));
                        }
                    });
                });
                server.listen(6514, '127.0.0.1');
                const config = {
                    type: "CEF",
                    name: 'Test TCP',
                    enabled: true,
                    host: '127.0.0.1',
                    port: 6514,
                    protocol: 'tcp'
                };
                await new Promise(resolve => setTimeout(resolve, 500)); // Wait to confirm server is listening
                await testToolLogForwarding(client, config);
            });

            it('TLS', async () => {
                // Generate self-signed cert
                const attrs = [{ name: 'commonName', value: 'localhost' }];
                const serverPems = selfsigned.generate(attrs, { days: 365 });
                const options = { key: serverPems.private, cert: serverPems.cert };

                server = tls.createServer(options, (socket: any) => {
                    socket.on('data', (data: Buffer) => {
                        const messageStr = data.toString();
                        if (messageStr.includes('rawEvent=')) {
                            tapMessages.push(JSON.parse(messageStr.slice(messageStr.indexOf("rawEvent=") + 9)));
                        }
                    });
                });
                server.listen(6514, '127.0.0.1');
                const config = {
                    type: "CEF",
                    name: 'Test TLS',
                    enabled: true,
                    host: '127.0.0.1',
                    port: 6514,
                    protocol: 'tls'
                };
                await new Promise(resolve => setTimeout(resolve, 500)); // Wait to confirm server is listening
                await testToolLogForwarding(client, config);
            });
        });

        describe('HEC Forwarder', () => {
            let server: http.Server | https.Server;
            const hecToken = 'TOKEN123';

            afterEach(async () => {
                if (server) {
                    server.close();
                }
            });

            const requestListener = (req: http.IncomingMessage, res: http.ServerResponse) => {
                if (req.method !== 'POST' || req.url !== '/services/collector') {
                    res.writeHead(404).end();
                    return;
                }
                if (req.headers.authorization !== `Splunk ${hecToken}`) {
                    res.writeHead(401).end(JSON.stringify({ text: 'Invalid token', code: 4 }));
                    return;
                }

                let body = '';
                req.on('data', (chunk) => body += chunk);
                req.on('end', () => {
                    try {
                        const hecPayload = JSON.parse(body);
                        expect(hecPayload.sourcetype).is.eq('agentity');
                        expect(hecPayload.index).is.eq('mcp');
                        if (hecPayload?.event) {
                            tapMessages.push(hecPayload.event);
                        }
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ text: 'Success', code: 0 }));
                    } catch (e) {
                        res.writeHead(400).end(JSON.stringify({ text: 'Bad Request', code: 6 }));
                    }
                });
            };

            it('HTTP', async () => {
                server = http.createServer(requestListener);
                server.listen(8000, '127.0.0.1');
                const config = {
                    type: 'HEC',
                    name: 'Test HTTP',
                    enabled: true,
                    url: 'http://127.0.0.1:8000/services/collector',
                    port: 8000,
                    sourcetype: 'agentity',
                    index: 'mcp',
                    tokenSecretKey: 'TOKENKEY'
                };
                await new Promise(resolve => setTimeout(resolve, 500)); // Wait to confirm server is listening
                await testToolLogForwarding(client, config, { 'TOKENKEY': hecToken });
            });

            it('HTTPS', async () => {
                const attrs = [{ name: 'commonName', value: 'localhost' }];
                const pems = selfsigned.generate(attrs, { days: 1 });
                const options = { key: pems.private, cert: pems.cert };
                server = https.createServer(options, requestListener);
                server.listen(8000, '127.0.0.1');
                const config = {
                    type: 'HEC',
                    name: 'Test HTTP',
                    enabled: true,
                    url: 'https://127.0.0.1:8000/services/collector',
                    port: 8000,
                    sourcetype: 'agentity',
                    index: 'mcp',
                    tokenSecretKey: 'TOKENKEY'
                };
                await new Promise(resolve => setTimeout(resolve, 500)); // Wait to confirm server is listening
                await testToolLogForwarding(client, config, { 'TOKENKEY': hecToken });
            });
        });

        describe('File Forwarder', () => {
            before(() => {
                const publicKeyPath = path.join(process.cwd(), 'src', 'jwt-signing-key.pub');
                const publicKey = fs.readFileSync(publicKeyPath, 'utf8');
                mockFs({
                    [path.join(path.parse(process.cwd()).root, 'logdir')]: {}, // Emtpy folder
                    [publicKeyPath]: publicKey
                })
            })

            after(() => {
                mockFs.restore();
            })

            it('Log events to file', async () => {
                const logFilePath = path.join(path.parse(process.cwd()).root, 'logdir', 'logfile');
                const config = {
                    type: 'FILE',
                    name: 'File forwrader',
                    enabled: true,
                    path: logFilePath,
                    maxSize: '10M'
                }
                initForwarding([config], { API_KEY });

                const echoResult = await client.callTool({
                    name: 'echo',
                    arguments: { s: 'test' },
                });

                const logContent = fs.readFileSync(logFilePath, 'utf-8');
                expect(logContent).to.not.be.empty;
                const parsedLog = JSON.parse(logContent);
                expect(parsedLog.toolName).to.equal('echo');
                expect(parsedLog.params).to.deep.equal({ s: 'test' });
                expect(parsedLog.result).to.deep.equal(echoResult.content);
            });
        });
    });
});