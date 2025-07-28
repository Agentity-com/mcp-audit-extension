import winston from 'winston';
import 'winston-daily-rotate-file';

// --- Logger Setup ---
export const logger = winston.createLogger({
    level: 'info', // Default log level
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        // winston.format.printf((info: Logform.TransformableInfo) => `${info.timestamp} [${info.level.toUpperCase()}] ${info.message}`),
        winston.format.prettyPrint()
    ),
    transports: [
        new winston.transports.DailyRotateFile({
            filename: 'tap_server-%DATE%.log', // Log file name pattern
            dirname: '.', // Log in the current directory (or specify a path e.g., 'logs')
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true, // Compress rotated files
            maxSize: '10m', // Rotate if file size exceeds 10MB
            maxFiles: '14d', // Keep logs for 14 days (optional)
            handleExceptions: true, // Log unhandled exceptions to this transport
            handleRejections: true, // Log unhandled promise rejections
        }),
    ],
});
