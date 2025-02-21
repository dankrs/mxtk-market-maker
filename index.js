// index.js
require('dotenv').config();
const express = require('express');
const MXTKMarketMaker = require('./market-maker');
const logger = require('./utils/logger');
const fs = require('fs');
const { DailyRotateFile } = require('winston-daily-rotate-file');

// Add process error handlers with proper cleanup
process.on('uncaughtException', async (error) => {
    logger.error('Uncaught Exception:', error);
    await cleanup();
    process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    await cleanup();
    process.exit(1);
});

// Add SIGTERM and SIGINT handlers
process.on('SIGTERM', async () => {
    logger.info('Received SIGTERM signal. Starting graceful shutdown...');
    await cleanup();
    process.exit(0);
});

process.on('SIGINT', async () => {
    logger.info('Received SIGINT signal. Starting graceful shutdown...');
    await cleanup();
    process.exit(0);
});

// Cleanup function
async function cleanup() {
    logger.info('Cleaning up before exit...');
    try {
        if (global.marketMaker) {
            await global.marketMaker.shutdown();
        }
    } catch (error) {
        logger.error('Error during cleanup:', error);
    }
}

async function startBot() {
    try {
        const config = {
            isTestnet: process.env.NETWORK === 'testnet',
            maxDailyVolume: process.env.MAX_DAILY_VOLUME || 1000,
            circuitBreakerThreshold: 0.1,
            lowBalanceThreshold: 0.1,
            volumeAlertThreshold: 0.8
        };

        const marketMaker = new MXTKMarketMaker(config);
        global.marketMaker = marketMaker; // Store reference for cleanup
        
        // Set up Express server first
        const app = express();
        const port = process.env.PORT || 3000;

        // Add health check endpoint
        app.get('/health', (req, res) => {
            res.status(200).json({ status: 'healthy' });
        });

        // Status endpoint
        app.get('/status', async (req, res) => {
            try {
                res.json({
                    status: 'running',
                    dailyVolume: marketMaker.state.dailyVolume,
                    isCircuitBroken: marketMaker.state.isCircuitBroken,
                    lastPrice: marketMaker.state.lastPrice,
                    lastUpdate: marketMaker.state.lastPriceUpdate,
                    environment: process.env.NODE_ENV
                });
            } catch (error) {
                logger.error('Status endpoint error:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Start the server first
        await new Promise((resolve) => {
            app.listen(port, '0.0.0.0', () => {
                logger.info(`Server listening at http://0.0.0.0:${port}`);
                resolve();
            });
        });

        // Then initialize the market maker
        await marketMaker.initialize();
        await marketMaker.startProcessManager();
        logger.info('Market maker initialized and started successfully');
    } catch (error) {
        logger.error('Fatal error starting bot:', error);
        await cleanup();
        process.exit(1);
    }
}

startBot().catch((error) => {
    logger.error('Fatal error starting bot:', error);
    process.exit(1);
});