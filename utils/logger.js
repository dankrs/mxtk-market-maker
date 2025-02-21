const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

// Define log format
const logFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
);

// Create the logger
const logger = winston.createLogger({
    level: 'info',
    format: logFormat,
    defaultMeta: { service: 'mxtk-market-maker' },
    transports: [
        // Console transport
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// Add file transport only in production
if (process.env.NODE_ENV === 'production') {
    logger.add(new DailyRotateFile({
        filename: '/tmp/logs/mxtk-market-maker-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: '20m',
        maxFiles: '14d',
        format: logFormat
    }));
}

// Add error logging to a separate file in production
if (process.env.NODE_ENV === 'production') {
    logger.add(new DailyRotateFile({
        filename: '/tmp/logs/mxtk-market-maker-error-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: '20m',
        maxFiles: '14d',
        level: 'error',
        format: logFormat
    }));
}

module.exports = logger; 