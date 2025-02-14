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
const { WalletManager } = require('./wallet-manager');

class MXTKMarketMaker {
    constructor(config) {
        // Token and router addresses for Arbitrum
        this.MXTK_ADDRESS = '0x3e4ffeb394b371aaaa0998488046ca19d870d9ba';
        this.WETH_ADDRESS = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';  // Arbitrum WETH
        this.UNISWAP_V2_ROUTER = '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506'; // SushiSwap on Arbitrum
        this.SUSHISWAP_FACTORY = '0xc35DADB65012eC5796536bD9864eD8773aBc74C4'; // SushiSwap Factory on Arbitrum
        
        // Merge custom configuration with defaults
        this.config = {
            ...config,
            recoveryFile: path.join(__dirname, 'recovery.json'),
            maxRetries: 3,
            retryDelay: 5000,
            minSpread: 0.02,
            targetSpread: 0.015,
            maxSpread: 0.025,
            minOrders: 10,
            circuitBreakerThreshold: 0.10, // 10% price change triggers circuit breaker
            timeRange: {
                min: 60,
                max: 900
            },
            amountRange: {
                min: 0.05,
                max: 1
            }
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
        // Define the alert email details
        const alert = {
            from: process.env.ALERT_FROM_EMAIL,
            to: process.env.ALERT_TO_EMAIL,
            subject: `MXTK Market Maker Alert: ${type}`,
            text: message
        };

        try {
            await this.mailer.sendMail(alert);
        } catch (error) {
            console.error('Failed to send alert:', error);
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
            // 1) Instantiate the SushiSwap factory on Arbitrum
            const factory = new ethers.Contract(
                this.SUSHISWAP_FACTORY,
                ['function getPair(address, address) external view returns (address)'],
                this.provider
            );

            // 2) Get the pair address (MXTK-WETH). If it's zero, no liquidity pool exists
            const pairAddress = await factory.getPair(this.MXTK_ADDRESS, this.WETH_ADDRESS);
            if (pairAddress === ethers.constants.AddressZero) {
                console.warn('No MXTK–WETH pair found on SushiSwap. Skipping price update.');
                return null;
            }

            // 3) Check liquidity reserves in that pair
            const pairContract = new ethers.Contract(
                pairAddress,
                ['function getReserves() external view returns (uint112,uint112,uint32)'],
                this.provider
            );
            const [reserve0, reserve1] = await pairContract.getReserves();
            if (reserve0.eq(0) || reserve1.eq(0)) {
                console.warn('MXTK–WETH pair has zero reserves. Skipping price update.');
                return null;
            }

            // 4) If the pair exists and has liquidity, safely call getAmountsOut
            const amounts = await this.router.getAmountsOut(
                ethers.utils.parseEther('1'),
                [this.MXTK_ADDRESS, this.WETH_ADDRESS]
            );
            return ethers.utils.formatEther(amounts[1]);
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
        if (this.state.isCircuitBroken) {
            console.log('Order rejected: Circuit breaker active');
            return;
        }

        try {
            const path = isBuy 
                ? [this.WETH_ADDRESS, this.MXTK_ADDRESS]
                : [this.MXTK_ADDRESS, this.WETH_ADDRESS];

            // Check token balances and approvals first
            const tokenContract = new ethers.Contract(
                path[0],
                IERC20.abi,
                wallet
            );
            
            const balance = await tokenContract.balanceOf(wallet.address);
            const amountIn = ethers.utils.parseEther(amount.toString());
            
            if (balance.lt(amountIn)) {
                console.log(`Insufficient ${isBuy ? 'WETH' : 'MXTK'} balance for order`);
                return;
            }

            const allowance = await tokenContract.allowance(wallet.address, this.UNISWAP_V2_ROUTER);
            if (allowance.lt(amountIn)) {
                console.log(`Approving ${isBuy ? 'WETH' : 'MXTK'} for trading...`);
                const approveTx = await tokenContract.approve(
                    this.UNISWAP_V2_ROUTER,
                    ethers.constants.MaxUint256
                );
                await approveTx.wait();
                console.log('Approval successful');
            }

            const deadline = Math.floor(Date.now() / 1000) + 300;
            const amounts = await this.router.getAmountsOut(amountIn, path);
            const amountOutMin = amounts[1].mul(98).div(100); // 2% slippage

            const tx = await this.router.connect(wallet).swapExactTokensForTokens(
                amountIn,
                amountOutMin,
                path,
                wallet.address,
                deadline,
                {
                    gasLimit: 300000,
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
            fs.writeFileSync(
                this.config.recoveryFile,
                JSON.stringify(this.state),
                'utf8'
            );
        } catch (error) {
            console.error('Error saving state:', error);
            await this.sendAlert('State Save Error', error.message);
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

            // Get current gas price and add 20% to ensure transaction goes through
            const gasPrice = (await this.provider.getGasPrice()).mul(120).div(100);
            console.log(`Using gas price: ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei`);

            const overrides = {
                gasLimit: 500000, // Increased gas limit for Arbitrum
                gasPrice: gasPrice,
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

            // Then handle WETH
            console.log('Approving WETH...');
            const wethContract = new ethers.Contract(
                this.WETH_ADDRESS,
                [
                    'function approve(address spender, uint256 amount) public returns (bool)',
                    'function deposit() public payable'
                ],
                wallet
            );

            try {
                // Increment nonce for WETH approval
                overrides.nonce++;

                // Directly try to approve WETH without checking allowance
                console.log('Setting WETH approval...');
                const wethTx = await wethContract.approve(
                    this.UNISWAP_V2_ROUTER,
                    ethers.constants.MaxUint256,
                    { ...overrides }
                );
                await wethTx.wait();
                console.log('✅ WETH approved');
            } catch (wethError) {
                console.log('Note: WETH approval skipped - may already be approved');
                console.log('WETH approval error:', wethError.message);
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
}

module.exports = MXTKMarketMaker;