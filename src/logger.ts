import { resolve } from 'path';
import type { LogOutputChannel } from 'vscode';
import * as winston from 'winston';

// The logger can be a VS Code LogOutputChannel or the standard console
export let logger: LogOutputChannel | winston.Logger;
export const SUPPRESS_STDOUT_LOGS_ENV_VAR_NAME = "DONT_STDOUT_LOG";

try {
    // Dynamically require 'vscode' only when it's expected to be available
    const vscode = require('vscode');
    const displayName = require(resolve(__dirname, "..", "package.json")).displayName;
    logger = vscode.window.createOutputChannel(displayName, { log: true });
} catch (e) {
    /* 
    If 'vscode' module is not found (e.g., in UTs), fall back to the standard console.
    However, first check for flag to avoid outputting logs to stdout. This is important in 
    the case this is a tap-local-mcp module spawned by the extension, which acts as an MCP 
    server over STDIO. In that case we don't want redundant output on stdout.
    */
   let logLevel;
   let stderrLevels;
    if (process.env[SUPPRESS_STDOUT_LOGS_ENV_VAR_NAME]) {
        logLevel = 'warn';
        stderrLevels = ['warn', 'error'];
    } else {
        logLevel = 'info';
        stderrLevels = ['error'];
    }

    logger = winston.createLogger({
        level: logLevel,
        format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
            winston.format.printf(({ level, message, timestamp }) => {
                return `${timestamp} [${level}] ${message}`;
            })
        ),
        transports: [new winston.transports.Console({ stderrLevels })]
    });
    logger.info('VS Code API not available. Falling back to console for logging.');
}