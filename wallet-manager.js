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
    constructor(provider) {
        // Use persistent storage path for Render.com
        this.dataDir = process.env.PERSISTENT_DIR 
            ? path.join(process.env.PERSISTENT_DIR, '.wallets')
            : path.join(__dirname, '.wallets');
            
        this.provider = provider;
        this.wallets = [];
        
        // Ensure the data directory exists
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
            console.log(`Created wallet directory at: ${this.dataDir}`);
        }
    }

    /**
     * Loads existing wallets from JSON files stored in the data directory.
     */
    async loadWallets() {
        try {
            // First check if we have environment-based wallets
            if (process.env.WALLET_PRIVATE_KEYS) {
                const privateKeys = process.env.WALLET_PRIVATE_KEYS.split(',');
                for (const privateKey of privateKeys) {
                    const wallet = new ethers.Wallet(privateKey.trim(), this.provider);
                    this.wallets.push(wallet);
                }
                console.log(`Loaded ${this.wallets.length} wallets from environment`);
                return;
            }

            // Otherwise load from files
            if (fs.existsSync(this.dataDir)) {
                const files = fs.readdirSync(this.dataDir);
                for (const file of files) {
                    if (file.endsWith('.json')) {
                        const data = JSON.parse(fs.readFileSync(path.join(this.dataDir, file), 'utf8'));
                        const wallet = new ethers.Wallet(data.privateKey, this.provider);
                        this.wallets.push(wallet);
                    }
                }
                console.log(`Loaded ${this.wallets.length} wallets from files`);
            }
        } catch (error) {
            console.error("Error loading wallets:", error);
            throw error;
        }
    }

    /**
     * Creates a new wallet, saves it to a file, and adds it to the manager.
     * @returns {Promise<ethers.Wallet>} The created wallet.
     */
    async createWallet() {
        try {
            const wallet = ethers.Wallet.createRandom().connect(this.provider);
            this.wallets.push(wallet);
            
            // Save wallet data
            const filePath = path.join(this.dataDir, `${wallet.address}.json`);
            const data = {
                address: wallet.address,
                privateKey: wallet.privateKey,
                created: new Date().toISOString()
            };
            
            // Write to file with better formatting and error handling
            await fs.promises.writeFile(
                filePath, 
                JSON.stringify(data, null, 2), 
                { mode: 0o600 } // Set restrictive file permissions
            );
            
            console.log(`Created and saved new wallet: ${wallet.address}`);
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

    async getWalletPrivateKey(address) {
        try {
            // First check environment variables
            if (process.env.WALLET_PRIVATE_KEYS) {
                const wallet = this.wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
                if (wallet) return wallet.privateKey;
            }

            // Then check files
            const filePath = path.join(this.dataDir, `${address}.json`);
            const data = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
            return data.privateKey;
        } catch (error) {
            console.error(`Error getting private key for wallet ${address}:`, error);
            throw error;
        }
    }
}

module.exports = WalletManager;
