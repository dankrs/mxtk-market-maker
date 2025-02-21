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
            maxGasPrice: parseInt(process.env.MAX_GAS_PRICE) || 100
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
        if (!this.emailTransport) {
            console.warn('Cannot send alert: Email transport not configured');
            return;
        }

        try {
            const mailOptions = {
                from: process.env.ALERT_FROM_EMAIL,
                to: process.env.ALERT_TO_EMAIL,
                subject: `MXTK Market Maker: ${subject}`,
                text: message
            };

            await this.emailTransport.sendMail(mailOptions);
            console.log(`✅ Alert sent: ${subject}`);
        } catch (error) {
            console.error('Failed to send email alert:', error);
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

    async distributeInitialFunds() {
        try {
            console.log('\n=== Master Wallet Status (Arbitrum) ===');
            
            // Get master wallet
            const masterWallet = new ethers.Wallet(
                process.env.MASTER_WALLET_PRIVATE_KEY,
                this.provider
            );
            console.log('Master wallet address:', masterWallet.address);

            // Check master wallet balances
            const masterEthBalance = await this.provider.getBalance(masterWallet.address);
            const masterUsdtBalance = await this.usdtContract.balanceOf(masterWallet.address);
            const usdtDecimals = await this.usdtContract.decimals();
            
            const masterEthBalanceFormatted = ethers.utils.formatEther(masterEthBalance);
            const masterUsdtBalanceFormatted = ethers.utils.formatUnits(masterUsdtBalance, usdtDecimals);
            
            console.log('Master Wallet Balances:');
            console.log(`ETH: ${masterEthBalanceFormatted} ETH`);
            console.log(`USDT: ${masterUsdtBalanceFormatted} USDT`);

            // Calculate required balances
            const requiredEthPerWallet = 0.001; // 0.001 ETH per wallet
            const requiredUsdtPerWallet = 1; // 1 USDT per wallet
            const totalWallets = this.state.wallets.length;
            const totalRequiredEth = requiredEthPerWallet * totalWallets;
            const totalRequiredUsdt = requiredUsdtPerWallet * totalWallets;

            // Validate master wallet has sufficient funds
            if (parseFloat(masterEthBalanceFormatted) < totalRequiredEth) {
                throw new Error(`Insufficient ETH in master wallet. Need: ${totalRequiredEth} ETH, Have: ${masterEthBalanceFormatted} ETH`);
            }
            
            if (parseFloat(masterUsdtBalanceFormatted) < totalRequiredUsdt) {
                throw new Error(`Insufficient USDT in master wallet. Need: ${totalRequiredUsdt} USDT, Have: ${masterUsdtBalanceFormatted} USDT`);
            }

            // First approve USDT spending
            console.log('\n=== Approving USDT transfers ===');
            const usdtWithSigner = this.usdtContract.connect(masterWallet);

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
                    
                    console.log(`Sending ${ethers.utils.formatEther(ethToSend)} ETH...`);
                    
                    const ethTx = await masterWallet.sendTransaction({
                        to: wallet.address,
                        value: ethToSend,
                        gasLimit: this.config.gasLimit
                    });
                    
                    await ethTx.wait();
                    console.log('✅ ETH transfer complete');
                }

                // Send USDT if needed
                if (parseFloat(usdtBalanceFormatted) < requiredUsdtPerWallet) {
                    const usdtToSend = ethers.utils.parseUnits(
                        (requiredUsdtPerWallet - parseFloat(usdtBalanceFormatted)).toFixed(6),
                        usdtDecimals
                    );
                    
                    console.log(`Sending ${ethers.utils.formatUnits(usdtToSend, usdtDecimals)} USDT...`);
                    
                    // Use the signer-connected contract for transfer
                    const usdtTx = await usdtWithSigner.transfer(
                        wallet.address,
                        usdtToSend,
                        { gasLimit: this.config.gasLimit }
                    );
                    
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
            
            // Create additional wallets if needed to reach 3 total
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

            // Distribute initial ETH and USDT
            await this.distributeInitialFunds();

            // Check and display final balances
            await this.displayWalletBalances();

            // Approve tokens for each wallet
            for (const wallet of this.state.wallets) {
                await this.approveTokens(wallet);
            }

            // Get and cache token decimals
            this.mxtkDecimals = await this.mxtkContract.decimals();
            this.usdtDecimals = await this.usdtContract.decimals();
            
            console.log('Token decimals initialized:');
            console.log('- MXTK:', this.mxtkDecimals);
            console.log('- USDT:', this.usdtDecimals);

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
            const MAX_UINT256 = ethers.constants.MaxUint256;
            
            // Connect contracts to wallet for signing
            const mxtkWithSigner = this.mxtkContract.connect(wallet);
            const usdtWithSigner = this.usdtContract.connect(wallet);

            console.log(`Checking approvals for wallet ${wallet.address}...`);

            // Check current MXTK allowance
            const mxtkAllowance = await this.mxtkContract.allowance(
                wallet.address,
                this.UNISWAP_V3_ROUTER
            );

            // Check current USDT allowance
            const usdtAllowance = await this.usdtContract.allowance(
                wallet.address,
                this.UNISWAP_V3_ROUTER
            );

            // Approve MXTK if needed
            if (mxtkAllowance.eq(0)) {
                console.log('Approving MXTK...');
                const mxtkApproveTx = await mxtkWithSigner.approve(
                    this.UNISWAP_V3_ROUTER,
                    MAX_UINT256,
                    { gasLimit: 100000 }
                );
                await mxtkApproveTx.wait();
                console.log('✅ MXTK approved');
            } else {
                console.log('MXTK already approved');
            }

            // Approve USDT if needed
            if (usdtAllowance.eq(0)) {
                console.log('Approving USDT...');
                const usdtApproveTx = await usdtWithSigner.approve(
                    this.UNISWAP_V3_ROUTER,
                    MAX_UINT256,
                    { gasLimit: 100000 }
                );
                await usdtApproveTx.wait();
                console.log('✅ USDT approved');
            } else {
                console.log('USDT already approved');
            }

        } catch (error) {
            console.error('Error approving tokens:', error);
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
            
            // Initial trade execution
            this.executeTradeLoop();

        } catch (error) {
            console.error('Error starting process manager:', error);
            throw error;
        }
    }

    async executeTradeLoop() {
        while (this.isRunning) {
            if (!this._isUpdating && !this.state.isCircuitBroken) {
                try {
                    // Get random wallet from pool
                    const wallet = this.state.wallets[Math.floor(Math.random() * this.state.wallets.length)];
                    
                    // Determine trade direction
                    let isBuy;
                    if (!this.firstTradeExecuted) {
                        isBuy = true;
                        this.firstTradeExecuted = true;
                        console.log('Executing first trade: USDT → MXTK');
                    } else {
                        isBuy = Math.random() > 0.5;
                    }
                    
                    // Get random amount within configured range and check balance
                    const amount = await this.getRandomAmount(wallet, isBuy);
                    
                    // Only proceed if we have a valid amount
                    if (amount !== null) {
                        await this.createOrder(wallet, amount, isBuy);
                    }
                    
                    // Random delay before next trade
                    const delay = this.getRandomDelay();
                    console.log(`Next trade in ${delay/1000} seconds`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    
                } catch (error) {
                    console.error('Error in trading cycle:', error);
                    await this.handleError(error);
                }
            }
        }
    }
}

module.exports = MXTKMarketMaker;