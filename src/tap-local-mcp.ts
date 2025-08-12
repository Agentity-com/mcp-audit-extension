import { spawn, ChildProcess } from 'child_process';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { proxyServer } from 'mcp-proxy';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
import { readFile } from 'fs/promises';
import fsExists from 'fs.promises.exists'
import { constants as osConstants } from 'os';
import { join as pathJoin } from 'path';
import { initForwarding, ToolTappingClient } from './tap-services';
import { getAgentId, getVSCodeFolder } from './metadata';
import { logger } from './logger';

async function main() {
    // 1. Argument Parsing
    const argvParser = yargs(hideBin(process.argv))
        .option('env-file', {
            type: 'string',
            description: 'Path to .env file for spawned command',
        })
        .option('mcp-server-name', {
            // For logging, identifies the original target
            type: 'string',
            description: 'Name of the original target MCP server being tapped',
            demandOption: true,
        })
        .option('agent-id', {
            type: 'string',
            description: 'A unique identifier for the agent instance.',
        })
        .option('settings-file', {
            type: 'string',
            description: 'Path to settings.json file to read forwarders configuration',
            default: pathJoin(getVSCodeFolder(), "settings.json")
        })
        .help()
        .alias('help', 'h');

    const rawArgs = hideBin(process.argv);
    const targetFlagIndex = rawArgs.indexOf('--target');

    let cliArgsToParse: string[];
    let targetCommandAndArgs: string[] = [];

    if (targetFlagIndex !== -1) {
        cliArgsToParse = rawArgs.slice(0, targetFlagIndex);
        if (targetFlagIndex < rawArgs.length - 1) {
            targetCommandAndArgs = rawArgs.slice(targetFlagIndex + 1);
        }
    } else {
        const mcpServerNameForLog = rawArgs.includes('--mcp-server-name')
            ? rawArgs[rawArgs.indexOf('--mcp-server-name') + 1]
            : 'unknown-target';
        logger.error(`[${mcpServerNameForLog}] Error: The --target flag is mandatory.`);
        process.exit(1);
    }

    const argv = await argvParser.parseAsync(cliArgsToParse);

    if (targetCommandAndArgs.length === 0) {
        logger.error(`[${argv.mcpServerName}] Error: --target flag requires a value (URL or command).`);
        process.exit(1);
    }

    const target = targetCommandAndArgs[0];
    const targetArgs = targetCommandAndArgs.slice(1);
    const originalTargetName = argv.mcpServerName; // For logging
    const tappedServerName = originalTargetName + ' (tapped)';

    // Get the forwarders config from the VScode settings
    const jsonContent = await readFile(argv.settingsFile, 'utf8');
    const forwarderConfig = JSON.parse(jsonContent)['mcpAudit.forwarders'];

    initForwarding(forwarderConfig, process.env.forwarderSecrets ? JSON.parse(process.env.forwarderSecrets) : {});

    let targetClientTransport: Transport;
    let childProc: ChildProcess | undefined;

    // Prepare environment for spawned process (if STDIO target)
    const spawnEnv = { ...process.env };
    if (argv.envFile) {
        if (await fsExists(argv.envFile)) {
            try {
                const envConfig = dotenv.parse(await readFile(argv.envFile));
                Object.assign(spawnEnv, envConfig);
            } catch (e: any) {
                logger.warn(`[${originalTargetName}] Warning: Failed to parse --env-file ${argv.envFile}: ${e.message}`);
            }
        } else {
            logger.warn(`[${originalTargetName}] Warning: --env-file ${argv.envFile} not found.`);
        }
    }

    logger.info(`[${tappedServerName}] Initializing for target: ${originalTargetName}`);
    try {
        // 2. Create Client Transport for the actual target server
        logger.info(`[${originalTargetName}] Target is a command: ${target} ${targetArgs.join(' ')}`);
        childProc = spawn(target, targetArgs, {
            env: spawnEnv,
            shell: true,
            stdio: ['pipe', 'pipe', 'pipe'], // stdin, stdout, stderr
        });

        if (!childProc.stdin || !childProc.stdout || !childProc.stderr) {
            throw new Error('Failed to get stdio streams from child process.');
        }

        childProc.stderr.on('data', (data) => {
            logger.error(`[${originalTargetName}] Target STDERR: ${data.toString().trim()}`);
        });

        childProc.on('error', (err) => {
            logger.error(`[${originalTargetName}] Error with target command '${target}': ${err.message}`);
            // McpServer and proxyServer might already be running; need graceful shutdown.
            // For now, exiting, but a more robust solution might involve closing transports.
            process.exit(1);
        });

        childProc.on('exit', (code, signal) => {
            const exitCode =
                code ?? 
                (signal ? 128 + (osConstants.signals[signal as keyof typeof osConstants.signals] || 0) : 1);
            logger.info(`[${originalTargetName}] Target command exited with code ${exitCode} (signal: ${signal || 'unknown'})`);
            // This will also cause the tap server to exit if proxyServer is tied to this transport.
            // Consider if tap server should exit or just log and stop proxying.
            process.exit(exitCode);
        });

        targetClientTransport = new StdioClientTransport({
            command: target,
            args: targetArgs,
            env: Object.entries(spawnEnv).reduce(
                (acc, [key, value]) =>
                    value !== undefined ? { ...acc, [key]: value } : acc,
                {} as Record<string, string>
            ),
        });
        

        // 3. Launch the client and connect it, then tap the client transport for logging
        // tapTransport takes the transport and a callback for messages
        const mcpClient = new ToolTappingClient({
            name: 'Client',
            version: '1.0.0',
        });
        mcpClient.init(originalTargetName);
        await mcpClient.connect(targetClientTransport);

        const targetServerCapabilities = mcpClient.getServerCapabilities()!;

        // 4. Create this tap's MCP Server instance
        const mcpServer = new McpServer(
            { name: tappedServerName, version: '1,0.0' },
            { capabilities: targetServerCapabilities }
        );
        logger.info(`[${tappedServerName}] McpServer instance created.`);

        // 5. Proxy the McpServer to the tapped client transport
        // This connects our server logic (if any) to the actual target.
        // proxyServer handles the bi-directional message flow.
        // The capabilities here might influence what the IDE sees from the tap server.
        // It's often set to the capabilities of the mcpServer instance itself.
        proxyServer({
            server: mcpServer.server,
            client: mcpClient,
            serverCapabilities: targetServerCapabilities,
        }).catch((err) => {
            logger.error(`[${tappedServerName}] Error in proxyServer: ${(err as Error).message}`);
            if (childProc && !childProc.killed) childProc.kill();
            process.exit(1);
        });
        logger.info(`[${tappedServerName}] proxyServer started, bridging to ${originalTargetName}.`);

        // 6. Expose the McpServer via STDIO for the IDE to connect to
        // StdioServerTransport typically defaults to process.stdin/stdout
        const proxyStdioTransport = new StdioServerTransport();
        await mcpServer.connect(proxyStdioTransport);

        // The process will now stay alive due to the active server and proxy.
        // Handle graceful shutdown on SIGINT/SIGTERM.
        let isShuttingDown = false;
        const shutdown = async (signal: string) => {
            if (isShuttingDown) return;
            isShuttingDown = true;

            logger.info(`[${tappedServerName}] Received ${signal}. Shutting down gracefully.`);

            try {
                await mcpServer.close();
                logger.info(`[${tappedServerName}] McpServer closed.`);
            } catch (e: any) {
                logger.error(`[${tappedServerName}] Error closing McpServer: ${e.message}`);
            }

            try {
                await mcpClient.close();
                logger.info(`[${originalTargetName}] McpClient disconnected from target.`);
            } catch (e: any) {
                logger.error(`[${originalTargetName}] Error disconnecting McpClient: ${e.message}`);
            }

            if (childProc && !childProc.killed) {
                logger.info(
                    `[${originalTargetName}] Terminating target process. The tap will exit when the target process terminates.`
                );
                childProc.kill('SIGTERM');
                // The existing 'exit' handler on childProc will now call process.exit()
            } else {
                // No child process, so we need to exit manually after a short delay for logs.
                setTimeout(() => {
                    logger.info(`[${tappedServerName}] Shutdown complete.`);
                    process.exit(0);
                }, 500);
            }
        };

        process.stdin.on('close', () => shutdown('stdin.close'));
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    } catch (error: any) {
        logger.error(`[${tappedServerName}] Fatal initialization error: ${error?.stack || error?.message || error}`);
        if (childProc && !childProc.killed) {
            childProc.kill();
        }
        process.exit(1);
    }
}

main().catch((error) => {
    const serverNameArg = process.argv.includes('--mcp-server-name')
        ? process.argv[process.argv.indexOf('--mcp-server-name') + 1]
        : 'Unknown name'; // Use tap server name if original target name parsing failed
    logger.error(
        `[${serverNameArg}] Unhandled error during tap server execution: ${error?.stack || error?.message || error}`
    );
    process.exit(1);
});
