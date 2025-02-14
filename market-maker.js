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
        this.MXTK_ADDRESS = '0x3e4ffeb394b371aaaa0998488046ca19d870d9ba';
        this.USDT_ADDRESS = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';  // Arbitrum USDT
        
        this.UNISWAP_V2_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
        this.UNISWAP_V2_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
        
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
            // Initialize Moralis with API key
            await Moralis.start({
                apiKey: process.env.MORALIS_API_KEY
            });

            // Set up the Ethereum provider using RPC from configuration
            this.provider = new ethers.providers.JsonRpcProvider(
                process.env.ARBITRUM_MAINNET_RPC,
                {
                    chainId: 42161,
                    name: 'arbitrum',
                    ensAddress: null
                }
            );

            // Test the connection
            try {
                await this.provider.getNetwork();
                console.log('✅ Successfully connected to Arbitrum mainnet');
            } catch (error) {
                throw new Error(`Failed to connect to Arbitrum: ${error.message}`);
            }

            // Initialize the MXTK token contract instance using ERC20 ABI
            this.mxtkContract = new ethers.Contract(
                this.MXTK_ADDRESS,
                IERC20.abi,
                this.provider
            );

            // Initialize the Uniswap V2 router contract instance
            this.router = new ethers.Contract(
                this.UNISWAP_V2_ROUTER,
                IUniswapV2Router02.abi,
                this.provider
            );

            // Set up monitoring systems (price, balance, volume reset)
            await this.initializeMonitoring();
            
            // Set up the email alert system
            this.setupAlertSystem();

        } catch (error) {
            console.error('Error initializing services:', error);
            await this.handleError(error);
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
                this.UNISWAP_V2_FACTORY,
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
                    `Factory Address: ${this.UNISWAP_V2_FACTORY}\n\n` +
                    'Action Required: A liquidity pool needs to be created on Uniswap V2 for MXTK-USDT pair.'
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
                    'Action Required: Liquidity needs to be added to the MXTK-USDT pool on Uniswap V2.'
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
        // Check circuit breaker
        if (this.state.isCircuitBroken) {
            console.log('Order rejected: Circuit breaker active');
            return;
        }

        // Check daily volume limit
        if (this.state.dailyVolume + amount > this.config.maxDailyVolume) {
            console.log(`Order rejected: Would exceed daily volume limit of ${this.config.maxDailyVolume}`);
            
            // Send alert if approaching volume limit
            if (this.state.dailyVolume >= this.config.maxDailyVolume * this.config.volumeAlertThreshold) {
                await this.sendAlert('Volume Limit Warning',
                    `Daily volume (${this.state.dailyVolume}) is approaching the limit (${this.config.maxDailyVolume})`);
            }
            return;
        }

        try {
            const path = isBuy 
                ? [this.USDT_ADDRESS, this.MXTK_ADDRESS]
                : [this.MXTK_ADDRESS, this.USDT_ADDRESS];

            // Get USDT decimals
            const usdtContract = new ethers.Contract(
                this.USDT_ADDRESS,
                ['function decimals() public view returns (uint8)'],
                this.provider
            );
            const decimals = await usdtContract.decimals();

            // Create exact input single params
            const params = {
                tokenIn: path[0],
                tokenOut: path[1],
                fee: 3000, // 0.3% fee tier
                recipient: wallet.address,
                deadline: Math.floor(Date.now() / 1000) + 300,
                amountIn: isBuy 
                    ? ethers.utils.parseUnits(amount.toString(), decimals) // USDT has 6 decimals
                    : ethers.utils.parseEther(amount.toString()), // MXTK has 18 decimals
                amountOutMinimum: 0, // We'll calculate this
                sqrtPriceLimitX96: 0 // No limit
            };

            // Get quote first
            const amounts = await this.router.connect(wallet).quoteExactInputSingle([
                params.tokenIn,
                params.tokenOut,
                params.amountIn,
                params.fee,
                params.sqrtPriceLimitX96
            ]);

            // Set minimum output amount with 2% slippage
            params.amountOutMinimum = amounts.amountOut.mul(98).div(100);

            // Execute the swap
            const tx = await this.router.connect(wallet).exactInputSingle(
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
            // Load master wallet from environment variable
            if (!process.env.MASTER_WALLET_PRIVATE_KEY) {
                throw new Error('MASTER_WALLET_PRIVATE_KEY not found in environment variables');
            }

            // Use Arbitrum provider with better error handling
            const arbitrumRpc = process.env.ARBITRUM_MAINNET_RPC;
            if (!arbitrumRpc) {
                throw new Error('ARBITRUM_MAINNET_RPC not found in environment variables');
            }

            console.log('\nConnecting to Arbitrum mainnet...');
            const arbitrumProvider = new ethers.providers.JsonRpcProvider(
                arbitrumRpc,
                {
                    chainId: 42161,
                    name: 'arbitrum',
                    ensAddress: null
                }
            );

            // Test the connection
            try {
                await arbitrumProvider.getNetwork();
                console.log('✅ Successfully connected to Arbitrum mainnet');
            } catch (error) {
                throw new Error(`Failed to connect to Arbitrum: ${error.message}`);
            }

            const masterWallet = new ethers.Wallet(
                process.env.MASTER_WALLET_PRIVATE_KEY,
                arbitrumProvider
            );

            // Check master wallet balance on Arbitrum
            const masterBalance = await masterWallet.getBalance();
            const requiredBalance = ethers.utils.parseEther('0.005'); // 0.001 ETH per wallet + gas
            
            if (masterBalance.lt(requiredBalance)) {
                console.log('\n=== Master Wallet Status (Arbitrum) ===');
                console.log(`Master wallet address: ${masterWallet.address}`);
                console.log(`Current Arbitrum balance: ${ethers.utils.formatEther(masterBalance)} ETH`);
                console.log(`Required balance: ${ethers.utils.formatEther(requiredBalance)} ETH`);
                throw new Error('Insufficient funds in master wallet on Arbitrum');
            }

            console.log('\n=== Starting ETH Distribution on Arbitrum ===');
            
            // Distribute ETH to each wallet on Arbitrum
            for (const wallet of this.state.wallets) {
                const balance = await arbitrumProvider.getBalance(wallet.address);
                
                if (balance.lt(ethers.utils.parseEther('0.001'))) {
                    console.log(`Sending 0.001 ETH to ${wallet.address} on Arbitrum...`);
                    
                    const tx = await masterWallet.sendTransaction({
                        to: wallet.address,
                        value: ethers.utils.parseEther('0.001'),
                        gasLimit: 100000, // Higher gas limit for Arbitrum
                    });

                    await tx.wait();
                    console.log(`✅ Sent 0.001 ETH to ${wallet.address} on Arbitrum`);
                } else {
                    console.log(`Wallet ${wallet.address} already has sufficient funds on Arbitrum`);
                }
            }

            console.log('=== ETH Distribution Complete on Arbitrum ===\n');

        } catch (error) {
            console.error('Error distributing ETH on Arbitrum:', error);
            throw error;
        }
    }

    async initialize() {
        try {
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
            console.log('\n=== Final Wallet Balances ===');
            for (const wallet of this.state.wallets) {
                const balance = await this.provider.getBalance(wallet.address);
                const ethBalance = ethers.utils.formatEther(balance);
                console.log(`Wallet ${wallet.address}`);
                console.log(`Balance: ${ethBalance} ETH`);
                console.log('---------------------');
            }
            console.log('=====================\n');

            // Approve tokens for each wallet
            for (const wallet of this.state.wallets) {
                await this.approveTokens(wallet);
            }

        } catch (error) {
            console.error('Error in initialization:', error);
            await this.handleError(error);
        }
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

            // Get current gas price and check against max
            const currentGasPrice = await this.provider.getGasPrice();
            if (currentGasPrice.gt(ethers.utils.parseUnits(this.config.maxGasPrice.toString(), 'gwei'))) {
                throw new Error(`Current gas price ${ethers.utils.formatUnits(currentGasPrice, 'gwei')} gwei exceeds maximum ${this.config.maxGasPrice} gwei`);
            }

            const overrides = {
                gasLimit: 500000, // Increased gas limit for Arbitrum
                gasPrice: currentGasPrice,
                nonce: await this.provider.getTransactionCount(wallet.address)
            };

            // First approve MXTK
            console.log('Approving MXTK...');
            const mxtkContract = this.mxtkContract.connect(wallet);
            
            // First set approval to 0 (recommended for some tokens)
            console.log('Resetting MXTK approval...');
            const resetTx = await mxtkContract.approve(
                this.UNISWAP_V2_ROUTER,
                0,
                { ...overrides }
            );
            await resetTx.wait();
            console.log('✅ MXTK approval reset');

            // Increment nonce for next transaction
            overrides.nonce++;

            // Then set to max value
            const mxtkTx = await mxtkContract.approve(
                this.UNISWAP_V2_ROUTER,
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

            try {
                // Increment nonce for USDT approval
                overrides.nonce++;

                // Get USDT decimals
                const decimals = await usdtContract.decimals();
                
                // Directly try to approve USDT without checking allowance
                console.log('Setting USDT approval...');
                const usdtTx = await usdtContract.approve(
                    this.UNISWAP_V2_ROUTER,
                    ethers.constants.MaxUint256,
                    { ...overrides }
                );
                await usdtTx.wait();
                console.log('✅ USDT approved');
            } catch (usdtError) {
                console.log('Note: USDT approval skipped - may already be approved');
                console.log('USDT approval error:', usdtError.message);
            }

            console.log('Token approvals completed successfully');
        } catch (error) {
            console.error('Error in approveTokens:', error);
            if (error.error && error.error.reason) {
                console.error('Reason:', error.error.reason);
            }
            if (error.transaction) {
                console.error('Failed transaction:', {
                    to: error.transaction.to,
                    from: error.transaction.from,
                    data: error.transaction.data,
                    value: error.transaction.value ? 
                        ethers.utils.formatEther(error.transaction.value) + ' ETH' : '0 ETH',
                    gasPrice: error.transaction.gasPrice ? 
                        ethers.utils.formatUnits(error.transaction.gasPrice, 'gwei') + ' gwei' : 'unknown'
                });
            }
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