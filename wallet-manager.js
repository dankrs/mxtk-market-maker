// wallet-manager.js
// This module defines the WalletManager class. 
// It loads existing wallets from a specified data directory (or creates the directory if it doesn't exist), 
// provides methods to load wallets from files, create new wallets (using ethers.Wallet.createRandom), and retrieve all wallets.

const fs = require('fs');
const path = require('path');
const ethers = require("ethers");

class WalletManager {
    /**
     * Constructs a new WalletManager.
     * @param {Object} config - Configuration object.
     * @param {string} config.dataDir - Directory where wallet files will be stored.
     */
    constructor(config) {
        this.dataDir = config.dataDir || path.join(__dirname, '.wallets');
        // Ensure the data directory exists
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
        this.wallets = [];
    }

    /**
     * Loads existing wallets from JSON files stored in the data directory.
     */
    async loadWallets() {
        try {
            const files = fs.readdirSync(this.dataDir);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const data = JSON.parse(fs.readFileSync(path.join(this.dataDir, file), 'utf8'));
                    // Create a wallet instance from the private key
                    const wallet = new ethers.Wallet(data.privateKey);
                    this.wallets.push(wallet);
                }
            }
            console.log(`Loaded ${this.wallets.length} wallets.`);
        } catch (error) {
            console.error("Error loading wallets:", error);
        }
    }

    /**
     * Creates a new wallet, saves it to a file, and adds it to the manager.
     * @returns {Promise<ethers.Wallet>} The created wallet.
     */
    async createWallet() {
        try {
            const wallet = ethers.Wallet.createRandom();
            this.wallets.push(wallet);
            // Save the wallet to a file named after its address
            const filePath = path.join(this.dataDir, `${wallet.address}.json`);
            const data = {
                address: wallet.address,
                privateKey: wallet.privateKey
            };
            fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
            console.log(`Created new wallet: ${wallet.address}`);
            return wallet;
        } catch (error) {
            console.error("Error creating wallet:", error);
            throw error;
        }
    }

    /**
     * Returns all wallets managed by the WalletManager.
     * @returns {ethers.Wallet[]} Array of wallet instances.
     */
    getAllWallets() {
        return this.wallets;
    }
}

module.exports = { WalletManager };
