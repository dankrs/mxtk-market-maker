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
const util = require('util');
const logger = require('./utils/logger');

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
            lowBalanceThreshold: parseFloat(process.env.LOW_BALANCE_THRESHOLD) || 0.002,
            volumeAlertThreshold: parseFloat(process.env.VOLUME_ALERT_THRESHOLD) || 0.8,
            timeRange: {
                min: parseInt(process.env.MIN_TIME_DELAY) || 30,    // Default to 30s if not set
                max: parseInt(process.env.MAX_TIME_DELAY) || 180    // Default to 180s if not set
            },
            amountRange: {
                min: 0.1,   // 0.1 USDT minimum
                max: 1.0    // 1.0 USDT maximum
            },
            gasLimit: parseInt(process.env.GAS_LIMIT) || 300000,
            maxGasPrice: parseInt(process.env.MAX_GAS_PRICE) || 100,
            requiredEthPerWallet: parseFloat(process.env.REQUIRED_ETH_PER_WALLET) || 0.0002
        };

        // Flag for tracking update operations
        this._isUpdating = false;

        // Initialize provider
        this.provider = new ethers.providers.JsonRpcProvider(process.env.ARBITRUM_MAINNET_RPC);

        // Initialize MXTK contract
        this.mxtkContract = new ethers.Contract(
            this.MXTK_ADDRESS,
            [
                'function approve(address spender, uint256 amount) public returns (bool)',
                'function allowance(address owner, address spender) public view returns (uint256)',
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
                'function allowance(address owner, address spender) public view returns (uint256)',
                'function balanceOf(address account) public view returns (uint256)',
                'function decimals() public view returns (uint8)',
                'function transfer(address recipient, uint256 amount) public returns (bool)'
            ],
            this.provider
        );

        // Initialize Uniswap V3 Router contract
        this.routerContract = new ethers.Contract(
            this.UNISWAP_V3_ROUTER,
            [
                'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
                'function exactOutputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountIn)'
            ],
            this.provider
        );

        // Initialize Uniswap V3 Factory contract
        this.factoryContract = new ethers.Contract(
            this.UNISWAP_V3_FACTORY,
            [
                'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
                'function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool)'
            ],
            this.provider
        );

        // Initialize Uniswap V3 Quoter contract
        this.quoterContract = new ethers.Contract(
            this.UNISWAP_V3_QUOTER,
            [
                'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)',
                'function quoteExactOutputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountOut, uint160 sqrtPriceLimitX96) external returns (uint256 amountIn)'
            ],
            this.provider
        );

        // Initialize token decimals (will be set in initialize())
        this.mxtkDecimals = null;
        this.usdtDecimals = null;

        // Add a flag to track if first trade has been executed
        this.firstTradeExecuted = false;

        // Set up logging
        this.setupLogging();

        // Instantiate the WalletManager (simplified)
        this.walletManager = new WalletManager(this.provider);

        // Initialize state object for tracking operational data
        this.state = this.getInitialState();

        // Initialize master wallet
        if (process.env.MASTER_WALLET_PRIVATE_KEY) {
            this.masterWallet = new ethers.Wallet(
                process.env.MASTER_WALLET_PRIVATE_KEY,
                this.provider
            );
        } else {
            throw new Error('MASTER_WALLET_PRIVATE_KEY not configured');
        }

        // Initialize email transport if SMTP settings are configured
        if (process.env.SMTP_HOST && 
            process.env.SMTP_PORT && 
            process.env.SMTP_USER && 
            process.env.SMTP_PASS) {
            this.emailTransport = nodemailer.createTransport({
                host: process.env.SMTP_HOST,
                port: parseInt(process.env.SMTP_PORT),
                secure: process.env.SMTP_PORT === '465', // true for 465, false for other ports
                auth: {
                    user: process.env.SMTP_USER,
                    pass: process.env.SMTP_PASS
                }
            });
            
            // Verify email transport configuration
            this.emailTransport.verify((error, success) => {
                if (error) {
                    console.error('Email transport verification failed:', error);
                } else {
                    console.log('Email transport ready');
                }
            });
        } else {
            console.warn('Email alerts disabled: SMTP configuration missing');
        }

        this.isShuttingDown = false;

        // Define paths for persistent storage
        this.DATA_DIR = path.join(process.cwd(), 'data');
        this.WALLETS_FILE = path.join(this.DATA_DIR, 'wallets.json');
        
        // Ensure data directory exists
        if (!fs.existsSync(this.DATA_DIR)) {
            fs.mkdirSync(this.DATA_DIR, { recursive: true });
        }
    }

    setupLogging() {
        try {
            // Override console.log and console.error with our logger
            const originalConsoleLog = console.log;
            console.log = (...args) => {
                logger.info(util.format(...args));
                originalConsoleLog.apply(console, args);
            };

            const originalConsoleError = console.error;
            console.error = (...args) => {
                logger.error(util.format(...args));
                originalConsoleError.apply(console, args);
            };

            logger.info('Logging system initialized');

        } catch (error) {
            logger.error('Error setting up logging:', error);
            throw error;
        }
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
                    'function allowance(address owner, address spender) public view returns (uint256)',
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
                    'function allowance(address owner, address spender) public view returns (uint256)',
                    'function balanceOf(address account) public view returns (uint256)',
                    'function decimals() public view returns (uint8)',
                    'function transfer(address recipient, uint256 amount) public returns (bool)'
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

    async sendAlert(subject, message) {
        try {
            if (!this.emailTransport) {
                console.warn('Cannot send alert: Email transport not configured');
                return;
            }

            const mailOptions = {
                from: process.env.ALERT_FROM_EMAIL,
                to: process.env.ALERT_TO_EMAIL,
                subject: `MXTK Market Maker Alert: ${subject}`,
                text: message
            };

            await this.emailTransport.sendMail(mailOptions);
            console.log('Alert email sent successfully');
        } catch (error) {
            console.error('Failed to send alert email:', error);
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
        // Add logging to verify the ranges being used
        console.log(`Generating random delay between ${this.config.timeRange.min}s and ${this.config.timeRange.max}s`);
        const delay = Math.floor(
            Math.random() * 
            (this.config.timeRange.max - this.config.timeRange.min + 1) + 
            this.config.timeRange.min
        );
        console.log(`Selected delay: ${delay}s`);
        return delay * 1000; // Convert seconds to milliseconds for setTimeout
    }

    async getRandomAmount(wallet, isBuy) {
        try {
            // Get current token balances
            const [usdtBalance, mxtkBalance, ethBalance] = await Promise.all([
                this.usdtContract.balanceOf(wallet.address),
                this.mxtkContract.balanceOf(wallet.address),
                this.provider.getBalance(wallet.address)
            ]);

            // Get decimals if not already cached
            if (!this.mxtkDecimals) this.mxtkDecimals = await this.mxtkContract.decimals();
            if (!this.usdtDecimals) this.usdtDecimals = await this.usdtContract.decimals();
            
            // Convert to human readable format with full precision
            const usdtBalanceFormatted = parseFloat(ethers.utils.formatUnits(usdtBalance, this.usdtDecimals));
            const mxtkBalanceFormatted = parseFloat(ethers.utils.formatUnits(mxtkBalance, this.mxtkDecimals));
            const ethBalanceFormatted = parseFloat(ethers.utils.formatEther(ethBalance));
            
            // Log balances before amount calculation
            console.log('\n=== Pre-Trade Balance Check ===');
            console.log(`Wallet: ${wallet.address}`);
            console.log(`ETH Balance: ${ethBalanceFormatted.toFixed(6)} ETH`);
            console.log(`USDT Balance: ${usdtBalanceFormatted.toFixed(6)} USDT`);
            console.log(`MXTK Balance: ${mxtkBalanceFormatted.toFixed(18)} MXTK`); // Use full precision for MXTK
            console.log(`Trade Direction: ${isBuy ? 'USDT → MXTK' : 'MXTK → USDT'}`);
            console.log('============================\n');

            // Check if ETH balance is sufficient for gas
            if (ethBalanceFormatted < this.config.lowBalanceThreshold) {
                console.log(`⚠️ Insufficient ETH for gas. Have: ${ethBalanceFormatted} ETH, Need: ${this.config.lowBalanceThreshold} ETH`);
                return null;
            }

            if (isBuy) {
                // For USDT → MXTK trades (6 decimals precision)
                const maxPossibleAmount = Math.min(
                    usdtBalanceFormatted,
                    parseFloat(process.env.MAX_USDT_TRADE) || 1.0
                );

                if (maxPossibleAmount < (parseFloat(process.env.MIN_USDT_TRADE) || 0.01)) {
                    console.log(`⚠️ Insufficient USDT balance for minimum trade.`);
                    console.log(`Have: ${usdtBalanceFormatted} USDT`);
                    console.log(`Need: ${parseFloat(process.env.MIN_USDT_TRADE) || 0.01} USDT`);
                    return null;
                }

                const amount = Math.random() * 
                    (maxPossibleAmount - (parseFloat(process.env.MIN_USDT_TRADE) || 0.01)) + 
                    (parseFloat(process.env.MIN_USDT_TRADE) || 0.01);

                const finalAmount = Number(amount.toFixed(6)); // USDT uses 6 decimals
                console.log(`Selected USDT amount for buying MXTK: ${finalAmount} USDT`);
                return finalAmount;

            } else {
                // For MXTK → USDT trades (18 decimals precision)
                const minMxtkTrade = parseFloat(process.env.MIN_MXTK_TRADE) || 0.0001;
                const maxMxtkTrade = parseFloat(process.env.MAX_MXTK_TRADE) || 0.002;

                // Convert balance to string to preserve precision
                const mxtkBalanceStr = ethers.utils.formatUnits(mxtkBalance, this.mxtkDecimals);
                
                if (parseFloat(mxtkBalanceStr) === 0) {
                    console.log(`⚠️ No MXTK available for trade`);
                    return null;
                }

                // Use entire MXTK balance for the swap if it's within range
                const finalAmount = Math.min(
                    parseFloat(mxtkBalanceStr),
                    maxMxtkTrade
                );

                if (finalAmount < minMxtkTrade) {
                    console.log(`⚠️ MXTK amount too small for trade`);
                    console.log(`Have: ${mxtkBalanceStr} MXTK`);
                    console.log(`Minimum required: ${minMxtkTrade} MXTK`);
                    return null;
                }

                // Keep full precision for MXTK amounts
                console.log(`Using MXTK amount for swap: ${finalAmount} MXTK`);
                return finalAmount;
            }

        } catch (error) {
            console.error('Error getting random amount:', error);
            return null;
        }
    }

    async createOrder(wallet, amount, isBuy) {
        try {
            // Validate amount before proceeding
            if (!amount || amount <= 0) {
                console.log(`⚠️ Skipping trade: Invalid amount (${amount})`);
                return null;
            }

            console.log(`Creating ${isBuy ? 'USDT → MXTK' : 'MXTK → USDT'} order for ${amount} tokens`);
            
            // Check token balances and ETH for gas
            const [usdtBalance, mxtkBalance, ethBalance] = await Promise.all([
                this.usdtContract.balanceOf(wallet.address),
                this.mxtkContract.balanceOf(wallet.address),
                this.provider.getBalance(wallet.address)
            ]);
            
            const usdtDecimals = await this.usdtContract.decimals();
            const mxtkDecimals = await this.mxtkContract.decimals();
            
            // Convert balances to human readable format
            const usdtBalanceFormatted = parseFloat(ethers.utils.formatUnits(usdtBalance, usdtDecimals));
            const mxtkBalanceFormatted = parseFloat(ethers.utils.formatUnits(mxtkBalance, mxtkDecimals));
            const ethBalanceFormatted = parseFloat(ethers.utils.formatEther(ethBalance));
            
            console.log(`Wallet ${wallet.address} balances:`, {
                ETH: ethBalanceFormatted.toFixed(6),
                USDT: usdtBalanceFormatted.toFixed(6),
                MXTK: mxtkBalanceFormatted.toFixed(6)
            });

            // Enhanced ETH balance check with detailed logging
            if (ethBalanceFormatted < this.config.lowBalanceThreshold) {
                console.log(`⚠️ ETH balance too low for safe trading:`);
                console.log(`Current ETH balance: ${ethBalanceFormatted}`);
                console.log(`Required minimum: ${this.config.lowBalanceThreshold}`);
                console.log(`Skipping trade to prevent failed transactions`);
                
                // Alert if ETH is very low
                if (ethBalanceFormatted < 0.001) {
                    await this.sendAlert(
                        'Low ETH Balance',
                        `Wallet ${wallet.address} has very low ETH: ${ethBalanceFormatted}. Please refill.`
                    );
                }
                return null;
            }

            // Validate sufficient balance for the trade
            if (isBuy) {  // USDT → MXTK
                if (usdtBalanceFormatted < amount) {
                    console.log(`Insufficient USDT balance. Have: ${usdtBalanceFormatted}, Need: ${amount}`);
                    return null; // Skip this trade
                }
            } else {  // MXTK → USDT
                if (mxtkBalanceFormatted < amount) {
                    console.log(`⚠️ Insufficient MXTK balance. Have: ${mxtkBalanceFormatted}, Need: ${amount}`);
                    return null; // Skip this trade
                }
            }
            
            // Convert amount to token units with proper decimals
            const tokenAmount = ethers.utils.parseUnits(
                amount.toString(),
                isBuy ? this.usdtDecimals : this.mxtkDecimals
            ).toString();
            
            // Set up the swap parameters
            const params = {
                tokenIn: isBuy ? this.USDT_ADDRESS : this.MXTK_ADDRESS,
                tokenOut: isBuy ? this.MXTK_ADDRESS : this.USDT_ADDRESS,
                fee: this.UNISWAP_POOL_FEE,
                recipient: wallet.address,
                deadline: Math.floor(Date.now() / 1000) + 300,
                amountIn: tokenAmount,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            };

            // Log the exact amounts being used
            console.log('\nTransaction Details:');
            console.log(`Token In: ${params.tokenIn}`);
            console.log(`Token Out: ${params.tokenOut}`);
            console.log(`Amount In (human readable): ${amount}`);
            console.log(`Amount In (wei): ${tokenAmount}`);
            console.log(`Using decimals: ${isBuy ? this.usdtDecimals : this.mxtkDecimals}`);

            try {
                // Get current gas price and add safety margin
                const feeData = await this.provider.getFeeData();
                const maxFeePerGas = feeData.maxFeePerGas.mul(120).div(100); // 20% safety margin
                const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas.mul(120).div(100);

                // First try to estimate gas
                const gasEstimate = await this.routerContract.estimateGas.exactInputSingle(
                    params,
                    { 
                        from: wallet.address,
                        maxFeePerGas,
                        maxPriorityFeePerGas
                    }
                );

                // Add 50% safety margin to gas estimate for Arbitrum
                const safeGasLimit = gasEstimate.mul(150).div(100);

                console.log('Transaction parameters:');
                console.log(`Gas limit: ${safeGasLimit.toString()}`);
                console.log(`Max fee per gas: ${ethers.utils.formatUnits(maxFeePerGas, 'gwei')} gwei`);
                console.log(`Max priority fee: ${ethers.utils.formatUnits(maxPriorityFeePerGas, 'gwei')} gwei`);

                // Calculate total maximum gas cost
                const maxGasCost = maxFeePerGas.mul(safeGasLimit);
                const maxGasCostInEth = ethers.utils.formatEther(maxGasCost);
                console.log(`Maximum gas cost: ${maxGasCostInEth} ETH`);

                // Check if we have enough ETH for gas with 20% buffer
                const requiredEth = parseFloat(maxGasCostInEth) * 1.2;
                if (ethBalanceFormatted < requiredEth) {
                    console.log(`⚠️ Insufficient ETH for safe transaction:`);
                    console.log(`Required (with buffer): ${requiredEth} ETH`);
                    console.log(`Available: ${ethBalanceFormatted} ETH`);
                    return null;
                }

                // Execute the trade with optimized parameters
                const routerWithSigner = this.routerContract.connect(wallet);
                const tx = await routerWithSigner.exactInputSingle(
                    params,
                    {
                        gasLimit: safeGasLimit,
                        maxFeePerGas,
                        maxPriorityFeePerGas,
                        type: 2 // EIP-1559 transaction
                    }
                );

                console.log(`Transaction sent: ${tx.hash}`);
                const receipt = await tx.wait();
                console.log(`✅ Trade executed: ${receipt.transactionHash}`);
                console.log(`Gas used: ${receipt.gasUsed.toString()}`);
                return receipt;

            } catch (error) {
                if (error.code === 'UNPREDICTABLE_GAS_LIMIT' || error.code === 'INSUFFICIENT_FUNDS') {
                    console.log('⚠️ Transaction failed with error:');
                    console.log(error.reason || error.message);
                    if (error.error?.error?.message) {
                        console.log('Network error message:', error.error.error.message);
                    }
                    
                    // Log transaction parameters for debugging
                    console.log('\nDebug information:');
                    console.log('Token In:', params.tokenIn);
                    console.log('Token Out:', params.tokenOut);
                    console.log('Amount:', ethers.utils.formatUnits(params.amountIn, isBuy ? this.usdtDecimals : this.mxtkDecimals));
                    console.log('Wallet ETH Balance:', ethBalanceFormatted);
                    return null;
                }
                throw error;
            }

        } catch (error) {
            console.error('Error executing trade:', error);
            await this.handleError(error);
            throw error;
        }
    }

    async handleError(error) {
        try {
            logger.error('Critical error encountered:', error);
            
            // Send alert email with more detailed information
            const errorDetails = `
Error Type: ${error.name}
Message: ${error.message}
Code: ${error.code}
Stack: ${error.stack}
Transaction (if any): ${JSON.stringify(error.transaction || {}, null, 2)}
            `;
            
            await this.sendAlertEmail('Critical Error', errorDetails);
            
            // If it's a critical error, initiate shutdown
            if (this.isCriticalError(error)) {
                logger.error('Critical error detected, initiating shutdown...');
                await this.shutdown();
                process.exit(1); // Force exit on critical errors
            }
        } catch (alertError) {
            logger.error('Error handling critical error:', alertError);
            process.exit(1);
        }
    }

    isCriticalError(error) {
        // Define conditions for critical errors
        const criticalConditions = [
            error.message.includes('insufficient funds'),
            error.message.includes('nonce too low'),
            error.message.includes('account not found'),
            error.message.includes('invalid private key'),
            error.message.includes('network disconnected'),
            error.code === 'NETWORK_ERROR',
            error.code === 'UNPREDICTABLE_GAS_LIMIT',
            error.code === 'INSUFFICIENT_FUNDS',
            
            // Add new gas-related conditions
            error.message.includes('intrinsic gas too low'),
            error.message.includes('gas required exceeds allowance'),
            error.message.includes('insufficient funds for gas'),
            error.message.includes('gas limit reached'),
            
            // Check for transaction underpriced
            error.message.includes('transaction underpriced'),
            error.message.includes('replacement fee too low'),
            
            // Check for RPC errors that might indicate gas issues
            error.message.includes('execution reverted'),
            error.message.includes('cannot estimate gas')
        ];
        
        // Also check nested error objects
        if (error.error && error.error.message) {
            criticalConditions.push(
                error.error.message.includes('insufficient funds'),
                error.error.message.includes('intrinsic gas too low')
            );
        }
        
        return criticalConditions.some(condition => condition);
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

    async distributeInitialFunds() {
        try {
            console.log('\n=== Master Wallet Status (Arbitrum) ===');
            
            // Initialize masterWallet if not already done
            if (!this.masterWallet) {
                this.masterWallet = new ethers.Wallet(
                    process.env.MASTER_WALLET_PRIVATE_KEY,
                    this.provider
                );
            }
            
            console.log('Master wallet address:', this.masterWallet.address);

            // Check master wallet balances
            const masterEthBalance = await this.provider.getBalance(this.masterWallet.address);
            const masterUsdtBalance = await this.usdtContract.balanceOf(this.masterWallet.address);
            const usdtDecimals = await this.usdtContract.decimals();
            
            const masterEthBalanceFormatted = ethers.utils.formatEther(masterEthBalance);
            const masterUsdtBalanceFormatted = ethers.utils.formatUnits(masterUsdtBalance, usdtDecimals);
            
            console.log('Master Wallet Balances:');
            console.log(`ETH: ${masterEthBalanceFormatted} ETH`);
            console.log(`USDT: ${masterUsdtBalanceFormatted} USDT`);

            // Calculate minimum required ETH with a small safety margin
            const requiredEthPerWallet = this.config.requiredEthPerWallet;
            const safetyMargin = 1.2; // 20% safety margin
            const totalWallets = this.state.wallets.length;
            const requiredEth = ethers.utils.parseEther(
                (totalWallets * requiredEthPerWallet * safetyMargin).toString()
            );

            console.log(`Required ETH per wallet: ${requiredEthPerWallet} ETH`);
            console.log(`Total wallets: ${totalWallets}`);
            console.log(`Total required ETH (with ${safetyMargin}x safety margin): ${ethers.utils.formatEther(requiredEth)} ETH`);

            const masterBalance = await this.provider.getBalance(this.masterWallet.address);
            
            if (masterBalance.lt(requiredEth)) {
                throw new Error(
                    `Insufficient ETH in master wallet. Need: ${ethers.utils.formatEther(requiredEth)} ETH, ` +
                    `Have: ${ethers.utils.formatEther(masterBalance)} ETH`
                );
            }
            
            if (parseFloat(masterUsdtBalanceFormatted) < 1) {
                throw new Error(`Insufficient USDT in master wallet. Need: 1 USDT, Have: ${masterUsdtBalanceFormatted} USDT`);
            }

            // First approve USDT spending
            console.log('\n=== Approving USDT transfers ===');
            const usdtWithSigner = this.usdtContract.connect(this.masterWallet);

            // Get current network gas prices
            const feeData = await this.provider.getFeeData();
            console.log('\nCurrent network gas prices:');
            console.log(`Base fee: ${ethers.utils.formatUnits(feeData.maxFeePerGas || '0', 'gwei')} gwei`);
            console.log(`Priority fee: ${ethers.utils.formatUnits(feeData.maxPriorityFeePerGas || '0', 'gwei')} gwei`);

            // Distribute funds to trading wallets
            console.log('\n=== Distributing Funds to Trading Wallets ===');
            for (const wallet of this.state.wallets) {
                console.log(`\nProcessing wallet: ${wallet.address}`);
                
                // Check current balances
                const ethBalance = await this.provider.getBalance(wallet.address);
                const usdtBalance = await this.usdtContract.balanceOf(wallet.address);
                
                const ethBalanceFormatted = ethers.utils.formatEther(ethBalance);
                const usdtBalanceFormatted = ethers.utils.formatUnits(usdtBalance, usdtDecimals);
                
                console.log('Current balances:');
                console.log(`ETH: ${ethBalanceFormatted} ETH`);
                console.log(`USDT: ${usdtBalanceFormatted} USDT`);

                // Send ETH if needed
                if (parseFloat(ethBalanceFormatted) < requiredEthPerWallet) {
                    const ethToSend = ethers.utils.parseEther(
                        (requiredEthPerWallet - parseFloat(ethBalanceFormatted)).toFixed(18)
                    );
                    
                    // Estimate gas for ETH transfer
                    const gasLimit = 100000; // Base gas limit for ETH transfers on Arbitrum
                    const gasCost = feeData.maxFeePerGas.mul(gasLimit);
                    const totalCost = ethToSend.add(gasCost);
                    
                    console.log(`Sending ${ethers.utils.formatEther(ethToSend)} ETH...`);
                    console.log(`Estimated gas cost: ${ethers.utils.formatEther(gasCost)} ETH`);
                    
                    const ethTx = await this.masterWallet.sendTransaction({
                        to: wallet.address,
                        value: ethToSend,
                        gasLimit: gasLimit,
                        maxFeePerGas: feeData.maxFeePerGas.mul(120).div(100), // 20% buffer
                        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas.mul(120).div(100),
                        type: 2
                    });
                    
                    await ethTx.wait();
                    console.log('✅ ETH transfer complete');
                }

                // Send USDT if needed
                if (parseFloat(usdtBalanceFormatted) < 1) {
                    const usdtToSend = ethers.utils.parseUnits(
                        (1 - parseFloat(usdtBalanceFormatted)).toFixed(6),
                        usdtDecimals
                    );
                    
                    console.log(`Sending ${ethers.utils.formatUnits(usdtToSend, usdtDecimals)} USDT...`);
                    
                    // Estimate gas for USDT transfer
                    let estimatedGas;
                    try {
                        estimatedGas = await usdtWithSigner.estimateGas.transfer(
                            wallet.address,
                            usdtToSend
                        );
                        console.log(`Estimated gas for USDT transfer: ${estimatedGas.toString()}`);
                    } catch (error) {
                        console.warn('Failed to estimate gas for USDT transfer, using default:', error);
                        estimatedGas = ethers.BigNumber.from('300000'); // Conservative default
                    }

                    // Add 50% buffer to estimated gas
                    const gasLimit = estimatedGas.mul(150).div(100);
                    console.log(`Using gas limit for USDT transfer: ${gasLimit.toString()}`);
                    
                    const usdtTx = await usdtWithSigner.transfer(
                        wallet.address,
                        usdtToSend,
                        {
                            gasLimit: gasLimit,
                            maxFeePerGas: feeData.maxFeePerGas.mul(120).div(100), // 20% buffer
                            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas.mul(120).div(100),
                            type: 2
                        }
                    );
                    
                    console.log('Waiting for USDT transfer confirmation...');
                    await usdtTx.wait();
                    console.log('✅ USDT transfer complete');
                }

                // Verify final balances
                const finalEthBalance = await this.provider.getBalance(wallet.address);
                const finalUsdtBalance = await this.usdtContract.balanceOf(wallet.address);
                
                console.log('\nFinal balances:');
                console.log(`ETH: ${ethers.utils.formatEther(finalEthBalance)} ETH`);
                console.log(`USDT: ${ethers.utils.formatUnits(finalUsdtBalance, usdtDecimals)} USDT`);
            }
            
            console.log('\n✅ Fund distribution completed successfully\n');

        } catch (error) {
            console.error('Error during fund distribution:', error);
            await this.handleError(error);
            throw error;
        }
    }

    async initialize() {
        try {
            // Initialize provider and other services
            await this.initializeProvider();
            await this.initializeContracts();
            await Moralis.start({
                apiKey: process.env.MORALIS_API_KEY
            });

            // Initialize wallet manager with persistence
            this.walletManager = new WalletManager();
            await this.loadWallets();

            // ... rest of initialization code ...
        } catch (error) {
            logger.error('Error during initialization:', error);
            throw error;
        }
    }

    async loadWallets() {
        try {
            if (fs.existsSync(this.WALLETS_FILE)) {
                logger.info('Loading existing wallets from storage...');
                const walletsData = JSON.parse(fs.readFileSync(this.WALLETS_FILE, 'utf8'));
                
                // Validate and restore wallets
                for (const walletData of walletsData) {
                    if (walletData.privateKey) {
                        const wallet = new ethers.Wallet(walletData.privateKey, this.provider);
                        this.walletManager.addWallet(wallet);
                        logger.info(`Restored wallet: ${wallet.address}`);
                    }
                }
                
                logger.info(`Restored ${this.walletManager.getWallets().length} wallets from storage`);
            } else {
                logger.info('No existing wallets found, creating new ones...');
                // Create initial wallets only if none exist
                await this.createInitialWallets();
            }
        } catch (error) {
            logger.error('Error loading wallets:', error);
            throw error;
        }
    }

    async createInitialWallets() {
        try {
            // Create new wallets
            const numWallets = 3; // Or get from config
            for (let i = 0; i < numWallets; i++) {
                const wallet = ethers.Wallet.createRandom().connect(this.provider);
                this.walletManager.addWallet(wallet);
                logger.info(`Created new wallet: ${wallet.address}`);
            }

            // Save wallets immediately after creation
            await this.saveWallets();
            logger.info(`Created and saved ${numWallets} new wallets`);
        } catch (error) {
            logger.error('Error creating initial wallets:', error);
            throw error;
        }
    }

    async saveWallets() {
        try {
            const wallets = this.walletManager.getWallets();
            const walletsData = wallets.map(wallet => ({
                address: wallet.address,
                privateKey: wallet.privateKey
            }));

            fs.writeFileSync(
                this.WALLETS_FILE,
                JSON.stringify(walletsData, null, 2),
                'utf8'
            );
            logger.info(`Saved ${wallets.length} wallets to storage`);
        } catch (error) {
            logger.error('Error saving wallets:', error);
            throw error;
        }
    }

    async shutdown() {
        try {
            logger.info('Shutting down market maker...');
            
            // Save wallets state before shutdown
            await this.saveWallets();
            
            // Save current state
            await this.saveState();
            
            // Close any active connections
            if (this.provider) {
                this.provider.removeAllListeners();
            }
            
            if (this.priceUpdateInterval) {
                clearInterval(this.priceUpdateInterval);
            }
            
            logger.info('Market maker shutdown complete');
        } catch (error) {
            logger.error('Error during shutdown:', error);
            throw error;
        }
    }

    async checkTransactionFeasibility(wallet, estimatedGas, value = 0) {
        try {
            const feeData = await this.provider.getFeeData();
            const walletBalance = await this.provider.getBalance(wallet.address);
            
            // Calculate total cost (gas + value to send)
            const maxFeePerGas = feeData.maxFeePerGas.mul(110).div(100); // 10% buffer
            const gasCost = estimatedGas.mul(maxFeePerGas);
            const totalCost = gasCost.add(value);
            
            console.log('\nTransaction feasibility analysis:');
            console.log(`Gas limit: ${estimatedGas.toString()}`);
            console.log(`Max fee per gas: ${ethers.utils.formatUnits(maxFeePerGas, 'gwei')} gwei`);
            console.log(`Gas cost: ${ethers.utils.formatEther(gasCost)} ETH`);
            console.log(`Value to send: ${ethers.utils.formatEther(value)} ETH`);
            console.log(`Total cost: ${ethers.utils.formatEther(totalCost)} ETH`);
            console.log(`Wallet balance: ${ethers.utils.formatEther(walletBalance)} ETH`);

            if (walletBalance.lt(totalCost)) {
                throw new Error(
                    `Insufficient funds for transaction. ` +
                    `Need: ${ethers.utils.formatEther(totalCost)} ETH, ` +
                    `Have: ${ethers.utils.formatEther(walletBalance)} ETH`
                );
            }

            return {
                maxFeePerGas,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas.mul(110).div(100),
                estimatedGas
            };
        } catch (error) {
            console.error('Error checking transaction feasibility:', error);
            throw error;
        }
    }
}

module.exports = MXTKMarketMaker;