// market-maker.js
// This file contains the main market-making logic. It imports necessary modules (including the custom WalletManager from wallet-manager.js),
// initializes services (Moralis, provider, contracts), sets up monitoring (price, balance, volume reset), manages order creation, error handling,
// state persistence, and approves tokens for trading.

const Moralis = require("moralis").default;
const { EvmChain } = require("@moralisweb3/common-evm-utils");
const ethers = require("ethers");
const { Token, CurrencyAmount, Percent } = require('@uniswap/sdk-core');
const { AlphaRouter } = require('@uniswap/smart-order-router');
const { Pool } = require('@uniswap/v3-sdk');
const IUniswapV2Router02 = require('@uniswap/v2-periphery/build/IUniswapV2Router02.json');
const IUniswapV2Factory = require('@uniswap/v2-periphery/build/IUniswapV2Factory.json');
const IERC20 = require('@openzeppelin/contracts/build/contracts/IERC20.json');
const nodemailer = require('nodemailer');
const cluster = require('cluster');
const fs = require('fs');
const path = require('path');
const WalletManager = require('./wallet-manager');

class MXTKMarketMaker {
    constructor(config) {
        // Token addresses for Arbitrum
        this.MXTK_ADDRESS = process.env.MXTK_ADDRESS;
        if (!this.MXTK_ADDRESS) {
            throw new Error('MXTK_ADDRESS not configured');
        }
        
        this.USDT_ADDRESS = process.env.USDT_ADDRESS;
        if (!this.USDT_ADDRESS) {
            throw new Error('USDT_ADDRESS not configured');
        }
        
        // Update Uniswap V3 contract addresses
        this.UNISWAP_V3_ROUTER = process.env.UNISWAP_V3_ROUTER;
        this.UNISWAP_V3_FACTORY = process.env.UNISWAP_V3_FACTORY;
        this.UNISWAP_V3_QUOTER = process.env.UNISWAP_V3_QUOTER;
        this.UNISWAP_POOL_FEE = parseInt(process.env.UNISWAP_POOL_FEE);
        
        if (!this.UNISWAP_V3_ROUTER || !this.UNISWAP_V3_FACTORY || !this.UNISWAP_V3_QUOTER) {
            throw new Error('Uniswap V3 contract addresses not properly configured');
        }
        
        // Slippage settings
        this.MAX_SLIPPAGE = parseFloat(process.env.MAX_SLIPPAGE);
        
        // Merge custom configuration with defaults from environment
        this.config = {
            ...config,
            recoveryFile: path.join(__dirname, 'recovery.json'),
            maxRetries: 3,
            retryDelay: 5000,
            minSpread: parseFloat(process.env.MIN_SPREAD) || 0.02,
            targetSpread: parseFloat(process.env.TARGET_SPREAD) || 0.015,
            maxSpread: parseFloat(process.env.MAX_SPREAD) || 0.025,
            minOrders: 10,
            maxDailyVolume: parseFloat(process.env.MAX_DAILY_VOLUME) || 10,
            circuitBreakerThreshold: parseFloat(process.env.CIRCUIT_BREAKER_THRESHOLD) || 0.10,
            lowBalanceThreshold: parseFloat(process.env.LOW_BALANCE_THRESHOLD) || 0.1,
            volumeAlertThreshold: parseFloat(process.env.VOLUME_ALERT_THRESHOLD) || 0.8,
            timeRange: {
                min: parseInt(process.env.MIN_TIME_DELAY) || 60,
                max: parseInt(process.env.MAX_TIME_DELAY) || 900
            },
            amountRange: {
                min: parseFloat(process.env.MIN_TRADE_AMOUNT) || 0.0005,
                max: parseFloat(process.env.MAX_TRADE_AMOUNT) || 0.05
            },
            gasLimit: parseInt(process.env.GAS_LIMIT) || 300000,
            maxGasPrice: parseInt(process.env.MAX_GAS_PRICE) || 100
        };

        // Flag for tracking update operations
        this._isUpdating = false;

        // Instantiate the WalletManager with a data directory for secure wallet storage
        this.walletManager = new WalletManager({
            dataDir: path.join(__dirname, '.secure')
        });

        // Initialize state object for tracking operational data
        this.state = this.getInitialState();
    }

    getInitialState() {
        return {
            dailyVolume: 0,
            lastPrice: null,
            activeOrders: {},
            isCircuitBroken: false,
            lastPriceUpdate: Date.now(),
            recoveryAttempts: 0,
            wallets: []
        };
    }

    async initializeServices() {
        try {
            // Validate required contract addresses
            if (!this.MXTK_ADDRESS) {
                throw new Error('MXTK_ADDRESS is not configured in environment variables');
            }
            if (!this.USDT_ADDRESS) {
                throw new Error('USDT_ADDRESS is not configured in environment variables');
            }
            if (!this.UNISWAP_V3_ROUTER) {
                throw new Error('UNISWAP_V3_ROUTER is not configured in environment variables');
            }
            if (!this.UNISWAP_V3_FACTORY) {
                throw new Error('UNISWAP_V3_FACTORY is not configured in environment variables');
            }
            if (!this.UNISWAP_V3_QUOTER) {
                throw new Error('UNISWAP_V3_QUOTER is not configured in environment variables');
            }

            // Log the addresses for debugging
            console.log('\nInitializing with addresses:');
            console.log('MXTK:', this.MXTK_ADDRESS);
            console.log('USDT:', this.USDT_ADDRESS);
            console.log('Router:', this.UNISWAP_V3_ROUTER);
            console.log('Factory:', this.UNISWAP_V3_FACTORY);
            console.log('Quoter:', this.UNISWAP_V3_QUOTER);

            // Initialize provider based on network
            const rpcUrl = this.config.isTestnet 
                ? process.env.ARBITRUM_TESTNET_RPC 
                : process.env.ARBITRUM_MAINNET_RPC;
            
            this.provider = new ethers.providers.JsonRpcProvider(rpcUrl);
            
            // Initialize contract interfaces
            this.mxtkContract = new ethers.Contract(
                this.MXTK_ADDRESS,
                [
                    'function approve(address spender, uint256 amount) public returns (bool)',
                    'function balanceOf(address account) public view returns (uint256)',
                    'function decimals() public view returns (uint8)'
                ],
                this.provider
            );

            // Initialize USDT contract
            this.usdtContract = new ethers.Contract(
                this.USDT_ADDRESS,
                [
                    'function approve(address spender, uint256 amount) public returns (bool)',
                    'function balanceOf(address account) public view returns (uint256)',
                    'function decimals() public view returns (uint8)'
                ],
                this.provider
            );

            // Initialize wallet manager
            this.walletManager = new WalletManager(this.provider);

            console.log('✅ Services initialized successfully');
            
        } catch (error) {
            console.error('Error initializing services:', error);
            throw error;
        }
    }

    setupAlertSystem() {
        this.mailer = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT,
            secure: false, // Set to false for port 587
            requireTLS: true, // Require TLS
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            },
            tls: {
                minVersion: 'TLSv1.2' // Specify minimum TLS version
            }
        });
    }

    async sendAlert(type, message) {
        try {
            if (!this.mailer) {
                console.warn('Email alerts not configured - skipping alert:', type);
                return;
            }

            const alert = {
                from: process.env.ALERT_FROM_EMAIL,
                to: process.env.ALERT_TO_EMAIL,
                subject: `MXTK Market Maker Alert: ${type}`,
                text: message,
                html: `<h2>MXTK Market Maker Alert: ${type}</h2>
                       <pre>${message}</pre>
                       <p>Time: ${new Date().toISOString()}</p>`
            };

            await this.mailer.sendMail(alert);
            console.log(`Alert sent: ${type}`);
        } catch (error) {
            console.error('Failed to send alert:', error);
            // Don't throw the error, just log it
        }
    }

    async initializeMonitoring() {
        // Price monitoring: update price data and check circuit breaker every 30 seconds
        setInterval(async () => {
            if (this._isUpdating) return;
            this._isUpdating = true;
            try {
                await this.updatePriceData();
                await this.checkCircuitBreaker();
            } finally {
                this._isUpdating = false;
            }
        }, 30000);

        // Wallet balance monitoring: check every 5 minutes
        setInterval(async () => {
            if (this._isUpdating) return;
            this._isUpdating = true;
            try {
                await this.checkWalletBalances();
            } finally {
                this._isUpdating = false;
            }
        }, 300000);

        // Daily volume reset: check every minute at UTC midnight
        setInterval(() => {
            const now = new Date();
            if (now.getUTCHours() === 0 && now.getUTCMinutes() === 0) {
                this.state.dailyVolume = 0;
                this.saveState();
            }
        }, 60000);
    }

    async checkWalletBalances() {
        // Loop through all managed wallets and check ETH and MXTK balances
        for (const wallet of this.state.wallets) {
            const balance = await wallet.getBalance();
            const tokenBalance = await this.mxtkContract.balanceOf(wallet.address);

            if (balance.lt(ethers.utils.parseEther('0.1'))) {
                await this.sendAlert('Low Balance',
                    `Wallet ${wallet.address} has low ETH balance: ${ethers.utils.formatEther(balance)}`);
            }

            if (tokenBalance.lt(ethers.utils.parseEther('100'))) {
                await this.sendAlert('Low Token Balance',
                    `Wallet ${wallet.address} has low MXTK balance: ${ethers.utils.formatEther(tokenBalance)}`);
            }
        }
    }

    async getCurrentPrice() {
        try {
            // 1) Instantiate the Uniswap factory on Arbitrum
            const factory = new ethers.Contract(
                this.UNISWAP_V3_FACTORY,
                ['function getPool(address,address,uint24) external view returns (address)'],
                this.provider
            );

            // 2) Get the pool address (MXTK-USDT). Using 0.3% fee tier (3000)
            const poolAddress = await factory.getPool(this.MXTK_ADDRESS, this.USDT_ADDRESS, 3000);
            if (poolAddress === ethers.constants.AddressZero) {
                const message = 'No MXTK–USDT pool found on Uniswap. The pool needs to be created before trading can begin.';
                console.warn(message);
                
                // Send email alert about missing pool
                await this.sendAlert(
                    'Missing Liquidity Pool',
                    `WARNING: ${message}\n\n` +
                    `MXTK Address: ${this.MXTK_ADDRESS}\n` +
                    `USDT Address: ${this.USDT_ADDRESS}\n` +
                    `Factory Address: ${this.UNISWAP_V3_FACTORY}\n\n` +
                    'Action Required: A liquidity pool needs to be created on Uniswap V3 for MXTK-USDT pair.'
                );
                
                // Return null but don't throw an error
                return null;
            }

            // 3) Check liquidity in the pool
            const poolContract = new ethers.Contract(
                poolAddress,
                ['function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'],
                this.provider
            );
            
            const slot0 = await poolContract.slot0();
            if (slot0.sqrtPriceX96.eq(0)) {
                const message = 'MXTK–USDT pool exists but has zero liquidity. Trading cannot begin until liquidity is added.';
                console.warn(message);
                
                // Send email alert about zero liquidity
                await this.sendAlert(
                    'Zero Liquidity in Pool',
                    `WARNING: ${message}\n\n` +
                    `Pool Address: ${poolAddress}\n` +
                    `MXTK Address: ${this.MXTK_ADDRESS}\n` +
                    `USDT Address: ${this.USDT_ADDRESS}\n\n` +
                    'Action Required: Liquidity needs to be added to the MXTK-USDT pool on Uniswap V3.'
                );
                
                return null;
            }

            // 4) Calculate price from sqrtPriceX96
            const price = (Number(slot0.sqrtPriceX96) / (2 ** 96)) ** 2;
            return price.toString();
        } catch (error) {
            console.error('Error getting current price:', error);
            await this.handleError(error);
            return null;
        }
    }

    async updatePriceData() {
        try {
            const currentPrice = await this.getCurrentPrice();
            
            if (this.state.lastPrice) {
                const priceChange = Math.abs(currentPrice - this.state.lastPrice) / this.state.lastPrice;
                await this.adjustSpread(priceChange);
            }

            this.state.lastPrice = currentPrice;
            this.state.lastPriceUpdate = Date.now();
            await this.saveState();
        } catch (error) {
            console.error('Error updating price data:', error);
            await this.handleError(error);
        }
    }

    async adjustSpread(priceChange) {
        // Adjust spread based on price volatility, within min and max bounds
        const newSpread = Math.min(
            this.config.maxSpread,
            Math.max(
                this.config.minSpread,
                this.config.targetSpread * (1 + priceChange * 10)
            )
        );

        if (Math.abs(newSpread - this.config.minSpread) > 0.005) {
            await this.sendAlert('Spread Adjustment',
                `Spread adjusted to ${newSpread} due to price change of ${priceChange}`);
        }

        this.config.minSpread = newSpread;
    }

    async checkCircuitBreaker() {
        if (this.state.lastPrice) {
            const currentPrice = await this.getCurrentPrice();
            const priceChange = Math.abs(currentPrice - this.state.lastPrice) / this.state.lastPrice;

            if (priceChange > this.config.circuitBreakerThreshold) {
                this.state.isCircuitBroken = true;
                await this.saveState();
                await this.sendAlert('Circuit Breaker',
                    `Trading halted due to price movement of ${priceChange * 100}%`);
                
                // Resume trading after 15 minutes if price stabilizes
                setTimeout(async () => {
                    const newPriceChange = Math.abs(
                        await this.getCurrentPrice() - this.state.lastPrice
                    ) / this.state.lastPrice;

                    if (newPriceChange < this.config.circuitBreakerThreshold) {
                        this.state.isCircuitBroken = false;
                        await this.saveState();
                        await this.sendAlert('Circuit Breaker',
                            'Trading resumed after price stabilization');
                    }
                }, 900000);
            }
        }
    }

    getRandomDelay() {
        // Return a random delay (in seconds) within the configured range
        return Math.floor(
            Math.random() * 
            (this.config.timeRange.max - this.config.timeRange.min + 1) + 
            this.config.timeRange.min
        );
    }

    getRandomAmount() {
        // Return a random trade amount within the specified range
        return Math.random() * 
            (this.config.amountRange.max - this.config.amountRange.min) + 
            this.config.amountRange.min;
    }

    async createOrder(wallet, amount, isBuy) {
        try {
            // Initialize V3 specific components
            const router = new ethers.Contract(
                this.UNISWAP_V3_ROUTER,
                ['function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160)) external returns (uint256)'],
                wallet
            );

            const path = isBuy 
                ? [this.USDT_ADDRESS, this.MXTK_ADDRESS]
                : [this.MXTK_ADDRESS, this.USDT_ADDRESS];

            // V3 specific parameters
            const params = {
                tokenIn: path[0],
                tokenOut: path[1],
                fee: 3000, // 0.3% fee tier
                recipient: wallet.address,
                deadline: Math.floor(Date.now() / 1000) + 300,
                amountIn: isBuy 
                    ? ethers.utils.parseUnits(amount.toString(), 6) // USDT has 6 decimals
                    : ethers.utils.parseEther(amount.toString()), // MXTK has 18 decimals
                amountOutMinimum: 0, // Will be calculated from quote
                sqrtPriceLimitX96: 0 // No limit
            };

            // Get quote using V3 quoter
            const quoterAddress = '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6';
            const quoter = new ethers.Contract(
                quoterAddress,
                ['function quoteExactInputSingle(address,address,uint24,uint256,uint160) external returns (uint256)'],
                this.provider
            );

            const quote = await quoter.quoteExactInputSingle(
                params.tokenIn,
                params.tokenOut,
                params.fee,
                params.amountIn,
                0
            );

            // Set minimum output with 2% slippage
            params.amountOutMinimum = quote.mul(98).div(100);

            // Execute the swap
            const tx = await router.exactInputSingle(
                params,
                {
                    gasLimit: this.config.gasLimit,
                    gasPrice: await this.provider.getGasPrice()
                }
            );

            await tx.wait();
            
            this.state.dailyVolume += amount;
            await this.saveState();

            console.log(`Order executed: ${isBuy ? 'Buy' : 'Sell'} ${amount} MXTK`);
        } catch (error) {
            console.error('Error creating order:', error);
            await this.handleError(error);
        }
    }

    async handleError(error) {
        await this.sendAlert('Error', error.message);
        
        if (this.state.recoveryAttempts < this.config.maxRetries) {
            this.state.recoveryAttempts++;
            await this.saveState();
            
            console.log(`Attempting recovery (${this.state.recoveryAttempts}/${this.config.maxRetries})`);
            
            setTimeout(async () => {
                await this.initializeServices();
                if (this.state.recoveryAttempts === this.config.maxRetries) {
                    await this.sendAlert('Recovery',
                        'Max retries reached. Manual intervention required.');
                }
            }, this.config.retryDelay);
        }
    }

    async saveState() {
        try {
            // Create a clean state object without circular references
            const cleanState = {
                dailyVolume: this.state.dailyVolume,
                lastPrice: this.state.lastPrice,
                isCircuitBroken: this.state.isCircuitBroken,
                lastPriceUpdate: this.state.lastPriceUpdate,
                recoveryAttempts: this.state.recoveryAttempts,
                wallets: this.state.wallets.map(w => ({
                    address: w.address,
                    balance: w.balance
                }))
            };

            await fs.promises.writeFile(
                this.config.recoveryFile,
                JSON.stringify(cleanState, null, 2)
            );
        } catch (error) {
            console.error('Error saving state:', error);
            // Don't throw the error, just log it
        }
    }

    async loadState() {
        try {
            if (fs.existsSync(this.config.recoveryFile)) {
                const data = JSON.parse(
                    fs.readFileSync(this.config.recoveryFile, 'utf8')
                );
                this.state = { ...this.state, ...data };
            }
        } catch (error) {
            console.error('Error loading state:', error);
            await this.handleError(error);
        }
    }

    async distributeInitialEth() {
        try {
            console.log('\n=== Master Wallet Status (Arbitrum) ===');
            
            // Get master wallet
            const masterWallet = new ethers.Wallet(
                process.env.MASTER_WALLET_PRIVATE_KEY,
                this.provider
            );
            console.log('Master wallet address:', masterWallet.address);

            // Check master wallet balance
            const masterBalance = await this.provider.getBalance(masterWallet.address);
            const masterBalanceEth = ethers.utils.formatEther(masterBalance);
            console.log('Current Arbitrum balance:', masterBalanceEth, 'ETH');

            // Calculate required balance for distribution
            const requiredEthPerWallet = 0.001; // 0.001 ETH per wallet
            const totalWallets = this.state.wallets.length;
            const totalRequiredEth = requiredEthPerWallet * totalWallets;
            console.log('Required balance:', totalRequiredEth, 'ETH');

            // Check if master wallet has sufficient funds
            if (parseFloat(masterBalanceEth) < totalRequiredEth) {
                const shortfall = totalRequiredEth - parseFloat(masterBalanceEth);
                console.log('\n⚠️ Insufficient Funds Warning:');
                console.log('----------------------------------------');
                console.log(`Current Balance: ${masterBalanceEth} ETH`);
                console.log(`Required Balance: ${totalRequiredEth} ETH`);
                console.log(`Shortfall: ${shortfall.toFixed(4)} ETH`);
                console.log(`Number of Wallets: ${totalWallets}`);
                console.log('----------------------------------------');
                console.log('Please send the required ETH to the master wallet address above.');
                console.log('The bot will not be able to operate without sufficient funds.');
                console.log('----------------------------------------\n');

                // Send alert email if configured
                const alertMessage = `
                    Insufficient funds detected in master wallet on Arbitrum
                    
                    Master Wallet: ${masterWallet.address}
                    Current Balance: ${masterBalanceEth} ETH
                    Required Balance: ${totalRequiredEth} ETH
                    Shortfall: ${shortfall.toFixed(4)} ETH
                    
                    Please add funds to continue operation.
                `;
                await this.sendAlert('Low Balance Alert', alertMessage);

                throw new Error('INSUFFICIENT_FUNDS');
            }

            // Distribute ETH to trading wallets
            console.log('\n=== Distributing ETH to Trading Wallets ===');
            for (const wallet of this.state.wallets) {
                const balance = await this.provider.getBalance(wallet.address);
                const balanceEth = ethers.utils.formatEther(balance);
                
                if (parseFloat(balanceEth) < requiredEthPerWallet) {
                    const amountToSend = ethers.utils.parseEther(
                        (requiredEthPerWallet - parseFloat(balanceEth)).toFixed(6)
                    );
                    
                    console.log(`Sending ${ethers.utils.formatEther(amountToSend)} ETH to ${wallet.address}`);
                    
                    const tx = await masterWallet.sendTransaction({
                        to: wallet.address,
                        value: amountToSend,
                        gasLimit: this.config.gasLimit
                    });
                    
                    await tx.wait();
                    console.log('✅ Transfer complete');
                } else {
                    console.log(`Wallet ${wallet.address} already has sufficient funds (${balanceEth} ETH)`);
                }
            }
            
            console.log('\n✅ ETH distribution completed successfully\n');

        } catch (error) {
            if (error.message === 'INSUFFICIENT_FUNDS') {
                // We've already displayed the detailed message, just exit gracefully
                process.exit(1);
            } else {
                console.error('Error during ETH distribution:', error);
                throw error;
            }
        }
    }

    async initialize() {
        try {
            // Validate required environment variables
            const requiredEnvVars = {
                // Uniswap V3 Configuration
                UNISWAP_V3_ROUTER: process.env.UNISWAP_V3_ROUTER,
                UNISWAP_V3_FACTORY: process.env.UNISWAP_V3_FACTORY,
                UNISWAP_V3_QUOTER: process.env.UNISWAP_V3_QUOTER,
                UNISWAP_POOL_FEE: process.env.UNISWAP_POOL_FEE,

                // Token Addresses
                MXTK_ADDRESS: process.env.MXTK_ADDRESS,
                USDT_ADDRESS: process.env.USDT_ADDRESS,

                // Network Configuration
                ARBITRUM_MAINNET_RPC: process.env.ARBITRUM_MAINNET_RPC,
                MORALIS_API_KEY: process.env.MORALIS_API_KEY,
                MASTER_WALLET_PRIVATE_KEY: process.env.MASTER_WALLET_PRIVATE_KEY
            };

            // Check for missing required variables
            const missingVars = Object.entries(requiredEnvVars)
                .filter(([_, value]) => !value)
                .map(([key]) => key);

            if (missingVars.length > 0) {
                throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
            }

            // Validate addresses
            const addressVars = {
                UNISWAP_V3_ROUTER: process.env.UNISWAP_V3_ROUTER,
                UNISWAP_V3_FACTORY: process.env.UNISWAP_V3_FACTORY,
                UNISWAP_V3_QUOTER: process.env.UNISWAP_V3_QUOTER,
                MXTK_ADDRESS: process.env.MXTK_ADDRESS,
                USDT_ADDRESS: process.env.USDT_ADDRESS
            };

            for (const [key, value] of Object.entries(addressVars)) {
                if (!ethers.utils.isAddress(value)) {
                    throw new Error(`Invalid Ethereum address for ${key}: ${value}`);
                }
            }

            // Validate numeric values
            const numericVars = {
                UNISWAP_POOL_FEE: { value: process.env.UNISWAP_POOL_FEE, min: 1, max: 1000000 },
                MAX_SLIPPAGE: { value: process.env.MAX_SLIPPAGE, min: 0.001, max: 0.1 },
                MIN_SPREAD: { value: process.env.MIN_SPREAD, min: 0.001, max: 0.1 },
                TARGET_SPREAD: { value: process.env.TARGET_SPREAD, min: 0.001, max: 0.1 },
                MAX_SPREAD: { value: process.env.MAX_SPREAD, min: 0.001, max: 0.1 }
            };

            for (const [key, config] of Object.entries(numericVars)) {
                const value = parseFloat(config.value);
                if (isNaN(value) || value < config.min || value > config.max) {
                    throw new Error(`Invalid value for ${key}: ${config.value}. Must be between ${config.min} and ${config.max}`);
                }
            }

            // Validate spread relationships
            if (parseFloat(process.env.MIN_SPREAD) > parseFloat(process.env.TARGET_SPREAD)) {
                throw new Error('MIN_SPREAD cannot be greater than TARGET_SPREAD');
            }
            if (parseFloat(process.env.TARGET_SPREAD) > parseFloat(process.env.MAX_SPREAD)) {
                throw new Error('TARGET_SPREAD cannot be greater than MAX_SPREAD');
            }

            // Continue with existing initialization code
            await this.loadState();
            await this.initializeServices();
            
            // Initialize wallets using WalletManager
            await this.walletManager.loadWallets();
            const existingWallets = this.walletManager.getAllWallets();
            
            // Log all wallet addresses clearly
            console.log('\n=== Wallet Addresses ===');
            existingWallets.forEach((wallet, index) => {
                console.log(`Wallet ${index + 1}: ${wallet.address}`);
            });
            console.log('=====================\n');
            
            if (existingWallets.length < 3) {
                const walletsToCreate = 3 - existingWallets.length;
                for (let i = 0; i < walletsToCreate; i++) {
                    await this.walletManager.createWallet();
                }
            }

            // Connect wallets to provider
            this.state.wallets = this.walletManager.getAllWallets().map(
                wallet => wallet.connect(this.provider)
            );

            // Distribute initial ETH if needed
            await this.distributeInitialEth();

            // Check and display final balances
            await this.displayWalletBalances();

            // Approve tokens for each wallet
            for (const wallet of this.state.wallets) {
                await this.approveTokens(wallet);
            }

        } catch (error) {
            console.error('Error in initialization:', error);
            await this.handleError(error);
            throw error;
        }
    }

    // Helper method to display wallet balances
    async displayWalletBalances() {
        console.log('\n=== Final Wallet Balances ===');
        for (const wallet of this.state.wallets) {
            const balance = await this.provider.getBalance(wallet.address);
            const ethBalance = ethers.utils.formatEther(balance);
            console.log(`Wallet ${wallet.address}`);
            console.log(`Balance: ${ethBalance} ETH`);
            console.log('---------------------');
        }
        console.log('=====================\n');
    }

    async approveTokens(wallet) {
        try {
            console.log(`\nApproving tokens for wallet: ${wallet.address}`);
            
            // Check wallet balance first
            const balance = await this.provider.getBalance(wallet.address);
            console.log(`Wallet ETH balance: ${ethers.utils.formatEther(balance)} ETH`);
            
            if (balance.lt(ethers.utils.parseEther('0.001'))) {
                throw new Error('Insufficient ETH balance for approvals');
            }

            // Get current base fee and priority fee
            const [baseFee, priorityFee] = await Promise.all([
                this.provider.getBlock('latest').then(block => block.baseFeePerGas),
                this.provider.getGasPrice().then(price => price.div(10)) // Use 10% of current gas price as priority fee
            ]);

            // Calculate max fee per gas (base fee + priority fee + 20% buffer)
            const maxFeePerGas = baseFee.mul(120).div(100).add(priorityFee);
            const maxPriorityFeePerGas = priorityFee;

            console.log(`Current base fee: ${ethers.utils.formatUnits(baseFee, 'gwei')} gwei`);
            console.log(`Max fee per gas: ${ethers.utils.formatUnits(maxFeePerGas, 'gwei')} gwei`);

            const overrides = {
                maxFeePerGas,
                maxPriorityFeePerGas,
                gasLimit: this.config.gasLimit,
                nonce: await this.provider.getTransactionCount(wallet.address)
            };

            // First approve MXTK
            console.log('Approving MXTK...');
            const mxtkContract = this.mxtkContract.connect(wallet);
            
            // First set approval to 0
            console.log('Resetting MXTK approval...');
            const resetTx = await mxtkContract.approve(
                this.UNISWAP_V3_ROUTER,
                0,
                { ...overrides }
            );
            await resetTx.wait();
            console.log('✅ MXTK approval reset');

            // Increment nonce for next transaction
            overrides.nonce++;

            // Then set to max value
            const mxtkTx = await mxtkContract.approve(
                this.UNISWAP_V3_ROUTER,
                ethers.constants.MaxUint256,
                { ...overrides }
            );
            await mxtkTx.wait();
            console.log('✅ MXTK approved');

            // Then handle USDT
            console.log('Approving USDT...');
            const usdtContract = new ethers.Contract(
                this.USDT_ADDRESS,
                [
                    'function approve(address spender, uint256 amount) public returns (bool)',
                    'function decimals() public view returns (uint8)'
                ],
                wallet
            );

            // Increment nonce for USDT approval
            overrides.nonce++;

            const usdtTx = await usdtContract.approve(
                this.UNISWAP_V3_ROUTER,
                ethers.constants.MaxUint256,
                { ...overrides }
            );
            await usdtTx.wait();
            console.log('✅ USDT approved');

        } catch (error) {
            console.error('Error in approveTokens:', error);
            await this.handleError(error);
            throw error;
        }
    }

    async startProcessManager() {
        try {
            console.log('Starting process manager...');
            
            // Check if pool exists before starting
            const currentPrice = await this.getCurrentPrice();
            if (!currentPrice) {
                console.log('Cannot start process manager: No MXTK-USDT pool exists');
                console.log('Please create the pool first and then restart the bot');
                return;
            }

            // Start the main trading loop
            this.isRunning = true;
            
            // Set up interval for continuous trading
            this.processInterval = setInterval(async () => {
                if (!this._isUpdating && !this.state.isCircuitBroken) {
                    try {
                        // Get random wallet from pool
                        const wallet = this.state.wallets[Math.floor(Math.random() * this.state.wallets.length)];
                        
                        // Randomly decide buy or sell
                        const isBuy = Math.random() > 0.5;
                        
                        // Get random amount within configured range
                        const amount = this.getRandomAmount();
                        
                        // Create the order
                        await this.createOrder(wallet, amount, isBuy);
                        
                        // Random delay before next trade
                        const delay = this.getRandomDelay();
                        console.log(`Next trade in ${delay} seconds`);
                        
                    } catch (error) {
                        console.error('Error in trading cycle:', error);
                        await this.handleError(error);
                    }
                }
            }, this.config.timeRange.min * 1000);

            console.log('Process manager started successfully');
        } catch (error) {
            console.error('Error starting process manager:', error);
            throw error;
        }
    }
}

module.exports = MXTKMarketMaker;