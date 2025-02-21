// index.js
require('dotenv').config();
const express = require('express');
const MXTKMarketMaker = require('./market-maker');
const logger = require('./utils/logger');

// Add process error handlers
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

async function startBot() {
    const config = {
        isTestnet: process.env.NETWORK === 'testnet',
        maxDailyVolume: process.env.MAX_DAILY_VOLUME || 1000,
        circuitBreakerThreshold: 0.1,
        lowBalanceThreshold: 0.1,
        volumeAlertThreshold: 0.8
    };

    const marketMaker = new MXTKMarketMaker(config);
    
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
        app.listen(port, () => {
            logger.info(`Server listening at http://localhost:${port}`);
            resolve();
        });
    });

    // Then initialize the market maker
    try {
        await marketMaker.initialize();
        await marketMaker.startProcessManager();
        logger.info('Market maker initialized and started successfully');
    } catch (error) {
        logger.error('Failed to start market maker:', error);
        throw error;
    }
}

startBot().catch((error) => {
    logger.error('Fatal error starting bot:', error);
    process.exit(1);
});