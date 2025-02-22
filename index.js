// index.js
require('dotenv').config();
const express = require('express');
const MXTKMarketMaker = require('./market-maker');
const initializeStorage = require('./init-storage');

async function startBot() {
    try {
        const config = {
            // Any additional configuration can go here
        };

        const marketMaker = new MXTKMarketMaker(config);
        await marketMaker.start();
    } catch (error) {
        console.error('Error starting bot:', error);
        process.exit(1);
    }
}

startBot();