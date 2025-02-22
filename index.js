// index.js
require('dotenv').config();
const express = require('express');
const MXTKMarketMaker = require('./market-maker');
const initializeStorage = require('./init-storage');

async function startBot() {
    // Initialize storage first
    initializeStorage();

    const config = {
        isTestnet: process.env.NETWORK === 'testnet',
        maxDailyVolume: process.env.MAX_DAILY_VOLUME || 1000,
        circuitBreakerThreshold: 0.1,
        lowBalanceThreshold: 0.1,
        volumeAlertThreshold: 0.8
    };

    const marketMaker = new MXTKMarketMaker(config);
    await marketMaker.initialize(); // Initialize services, state, and wallets
	await marketMaker.startProcessManager();

    // Set up Express server for status endpoint
    const app = express();
    const port = process.env.PORT || 3000;

    app.get('/status', async (req, res) => {
        res.json({
            status: 'running',
            dailyVolume: marketMaker.state.dailyVolume,
            isCircuitBroken: marketMaker.state.isCircuitBroken,
            lastPrice: marketMaker.state.lastPrice,
            lastUpdate: marketMaker.state.lastPriceUpdate
        });
    });

    app.listen(port, () => {
        console.log(`Status endpoint listening at http://localhost:${port}`);
    });
}

startBot().catch(console.error);