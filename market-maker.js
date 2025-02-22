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

class MXTKMarketMaker {
    constructor(config) {
        // Basic configuration
        this.config = config;
        this.provider = new ethers.providers.JsonRpcProvider(process.env.ARBITRUM_MAINNET_RPC);
        
        // Contract addresses
        this.UNISWAP_V3_ROUTER = process.env.UNISWAP_V3_ROUTER;
        this.UNISWAP_V3_FACTORY = process.env.UNISWAP_V3_FACTORY;
        this.UNISWAP_V3_QUOTER = process.env.UNISWAP_V3_QUOTER;
        this.MXTK_ADDRESS = process.env.MXTK_ADDRESS;
        this.USDT_ADDRESS = process.env.USDT_ADDRESS;

        // Trading parameters
        this.MIN_TRADE_AMOUNT = ethers.utils.parseUnits('0.1', 6);  // 0.1 USDT
        this.MAX_TRADE_AMOUNT = ethers.utils.parseUnits('1', 6);    // 1 USDT
        this.MIN_DELAY = 30;  // 30 seconds
        this.MAX_DELAY = 300; // 5 minutes
        this.SLIPPAGE_TOLERANCE = 200; // 2% (in basis points)

        // Initialize state
        this.lastTradeDirection = null;
        this.isFirstTrade = true;
        
        // Setup logging
        this.setupLogging();
    }

    async initialize() {
        try {
            this.tradingLog('system', 'Initializing MXTK Market Maker...');

            // Initialize master wallet
            this.masterWallet = new ethers.Wallet(process.env.MASTER_WALLET_PRIVATE_KEY, this.provider);
            this.tradingLog('system', 'Master wallet initialized', {
                address: this.masterWallet.address
            });

            // Initialize contracts
            await this.initializeContracts();

            // Check balances and approvals
            await this.checkBalancesAndApprovals();

            this.tradingLog('system', '✅ Initialization complete');
        } catch (error) {
            this.tradingLog('system', '❌ Initialization failed', {
                error: error.message
            });
            throw error;
        }
    }

    async initializeContracts() {
        this.tradingLog('system', 'Initializing contracts...');
        
        // Initialize MXTK contract
        this.mxtkContract = new ethers.Contract(
            this.MXTK_ADDRESS,
            [
                'function approve(address spender, uint256 amount) public returns (bool)',
                'function allowance(address owner, address spender) public view returns (uint256)',
                'function balanceOf(address account) public view returns (uint256)',
                'function decimals() public view returns (uint8)'
            ],
            this.masterWallet
        );

        // Initialize USDT contract
        this.usdtContract = new ethers.Contract(
            this.USDT_ADDRESS,
            [
                'function approve(address spender, uint256 amount) public returns (bool)',
                'function allowance(address owner, address spender) public view returns (uint256)',
                'function balanceOf(address account) public view returns (uint256)',
                'function decimals() public view returns (uint8)'
            ],
            this.masterWallet
        );

        // Initialize Uniswap contracts
        this.quoterContract = new ethers.Contract(
            this.UNISWAP_V3_QUOTER,
            [
                'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)',
                'function quoteExactOutputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountOut, uint160 sqrtPriceLimitX96) external returns (uint256 amountIn)'
            ],
            this.provider
        );

        // Initialize Router contract
        this.routerContract = new ethers.Contract(
            this.UNISWAP_V3_ROUTER,
            [
                'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut)'
            ],
            this.masterWallet
        );

        this.tradingLog('system', '✅ Contracts initialized');
    }

    async checkBalancesAndApprovals() {
        this.tradingLog('system', 'Checking balances and approvals...');

        // Check ETH balance
        const ethBalance = await this.masterWallet.getBalance();
        this.tradingLog('balance', 'ETH balance', {
            amount: `${ethers.utils.formatEther(ethBalance)} ETH`
        });

        // Check USDT balance
        const usdtBalance = await this.usdtContract.balanceOf(this.masterWallet.address);
        this.tradingLog('balance', 'USDT balance', {
            amount: `${ethers.utils.formatUnits(usdtBalance, 6)} USDT`
        });

        // Check MXTK balance
        const mxtkBalance = await this.mxtkContract.balanceOf(this.masterWallet.address);
        this.tradingLog('balance', 'MXTK balance', {
            amount: `${ethers.utils.formatEther(mxtkBalance)} MXTK`
        });

        // Check and set approvals
        await this.checkAndSetApprovals();
    }

    async checkAndSetApprovals() {
        const MAX_UINT256 = ethers.constants.MaxUint256;

        // Check USDT approval
        const usdtAllowance = await this.usdtContract.allowance(
            this.masterWallet.address,
            this.UNISWAP_V3_ROUTER
        );

        // Check MXTK approval
        const mxtkAllowance = await this.mxtkContract.allowance(
            this.masterWallet.address,
            this.UNISWAP_V3_ROUTER
        );

        // Set approvals if needed
        if (usdtAllowance.eq(0)) {
            this.tradingLog('system', 'Approving USDT...');
            const tx = await this.usdtContract.approve(this.UNISWAP_V3_ROUTER, MAX_UINT256);
            await tx.wait();
            this.tradingLog('system', '✅ USDT approved');
        }

        if (mxtkAllowance.eq(0)) {
            this.tradingLog('system', 'Approving MXTK...');
            const tx = await this.mxtkContract.approve(this.UNISWAP_V3_ROUTER, MAX_UINT256);
            await tx.wait();
            this.tradingLog('system', '✅ MXTK approved');
        }
    }

    async executeSwap(tokenIn, tokenOut, amountIn, isExactIn = true) {
        try {
            this.tradingLog('trade', 'Starting Swap Execution');
            
            // Get current gas prices from network
            const feeData = await this.provider.getFeeData();
            this.tradingLog('gas', 'Current Gas Prices', {
                baseFee: `${ethers.utils.formatUnits(feeData.lastBaseFeePerGas || feeData.gasPrice, 'gwei')} gwei`,
                maxPriorityFee: `${ethers.utils.formatUnits(feeData.maxPriorityFeePerGas, 'gwei')} gwei`,
                maxFeePerGas: `${ethers.utils.formatUnits(feeData.maxFeePerGas, 'gwei')} gwei`
            });

            // Prepare transaction parameters
            const fee = parseInt(process.env.UNISWAP_POOL_FEE);
            const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

            // Get quote and estimate gas
            console.log('\nEstimating transaction parameters...');
            const params = {
                tokenIn,
                tokenOut,
                fee,
                recipient: this.masterWallet.address,
                deadline,
                amountIn,
                amountOutMinimum: 0, // Temporary for estimation
                sqrtPriceLimitX96: 0
            };

            // Estimate gas for the transaction
            const gasEstimate = await this.routerContract.estimateGas.exactInputSingle(params);
            console.log('Estimated gas units:', gasEstimate.toString());

            // Calculate gas costs
            const maxGasCost = gasEstimate.mul(feeData.maxFeePerGas);
            console.log('Maximum gas cost:', ethers.utils.formatEther(maxGasCost), 'ETH');

            // Check if we have enough ETH for gas
            const ethBalance = await this.masterWallet.getBalance();
            if (ethBalance.lt(maxGasCost.mul(12).div(10))) { // Add 20% buffer
                throw new Error(`Insufficient ETH for gas. Need: ${ethers.utils.formatEther(maxGasCost.mul(12).div(10))} ETH, Have: ${ethers.utils.formatEther(ethBalance)} ETH`);
            }

            // Get actual quote
            console.log('\nGetting Uniswap quote...');
            const amountOut = await this.quoterContract.callStatic.quoteExactInputSingle(
                tokenIn,
                tokenOut,
                fee,
                amountIn,
                0
            );

            // Calculate minimum amount out with slippage tolerance
            const minAmountOut = amountOut.mul(10000 - this.SLIPPAGE_TOLERANCE).div(10000);

            // Update params with real minimum output
            params.amountOutMinimum = minAmountOut;

            // Execute the swap with gas parameters
            console.log('\nExecuting swap with parameters:');
            console.log('Token In:', tokenIn);
            console.log('Token Out:', tokenOut);
            console.log('Amount In:', ethers.utils.formatUnits(amountIn, tokenIn === this.USDT_ADDRESS ? 6 : 18));
            console.log('Min Amount Out:', ethers.utils.formatUnits(minAmountOut, tokenOut === this.USDT_ADDRESS ? 6 : 18));
            console.log('Gas Limit:', gasEstimate.toString());
            console.log('Max Fee Per Gas:', ethers.utils.formatUnits(feeData.maxFeePerGas, 'gwei'), 'gwei');
            console.log('Max Priority Fee:', ethers.utils.formatUnits(feeData.maxPriorityFeePerGas, 'gwei'), 'gwei');

            const tx = await this.routerContract.exactInputSingle(params, {
                gasLimit: gasEstimate.mul(110).div(100), // Add 10% buffer to estimated gas
                maxFeePerGas: feeData.maxFeePerGas,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
                type: 2 // EIP-1559 transaction
            });

            this.tradingLog('trade', 'Transaction sent', { 
                hash: tx.hash,
                gasLimit: gasEstimate.toString(),
                maxFeePerGas: `${ethers.utils.formatUnits(feeData.maxFeePerGas, 'gwei')} gwei`
            });

            console.log('Waiting for confirmation...');

            const receipt = await tx.wait();
            
            this.tradingLog('trade', 'Transaction confirmed', {
                gasUsed: receipt.gasUsed.toString(),
                effectiveGasPrice: `${ethers.utils.formatUnits(receipt.effectiveGasPrice, 'gwei')} gwei`,
                totalGasCost: `${ethers.utils.formatEther(receipt.gasUsed.mul(receipt.effectiveGasPrice))} ETH`
            });

            // Log balance changes
            const balanceAfter = await this.masterWallet.getBalance();
            this.tradingLog('balance', 'ETH balance change', {
                change: `${ethers.utils.formatEther(balanceAfter.sub(ethBalance))} ETH`
            });

            this.tradingLog('trade', 'Swap Execution Complete');
            return receipt;
        } catch (error) {
            this.tradingLog('trade', '❌ Swap execution failed', {
                error: error.message,
                ...(error.transaction && {
                    transaction: {
                        hash: error.transaction.hash,
                        from: error.transaction.from,
                        to: error.transaction.to,
                        value: error.transaction.value.toString()
                    }
                })
            });
            throw error;
        }
    }

    async getTokenBalance(tokenAddress) {
        try {
            const contract = new ethers.Contract(
                tokenAddress,
                ['function balanceOf(address) view returns (uint256)'],
                this.provider
            );
            const balance = await contract.balanceOf(this.masterWallet.address);
            this.tradingLog('balance', 'Token balance retrieved', {
                token: tokenAddress,
                balance: ethers.utils.formatUnits(balance, 18)
            });
            return balance;
        } catch (error) {
            this.tradingLog('system', '❌ Error getting token balance', {
                token: tokenAddress,
                error: error.message
            });
            throw error;
        }
    }

    async performRandomTrade() {
        try {
            this.tradingLog('system', 'Starting Random Trade');
            
            // Get current balances
            const usdtBalance = await this.usdtContract.balanceOf(this.masterWallet.address);
            const mxtkBalance = await this.mxtkContract.balanceOf(this.masterWallet.address);
            
            this.tradingLog('balance', 'Current balances', {
                USDT: ethers.utils.formatUnits(usdtBalance, 6),
                MXTK: ethers.utils.formatEther(mxtkBalance)
            });

            // Determine trade direction
            let tokenIn, tokenOut, tradeDirection, availableBalance;
            if (this.isFirstTrade) {
                // First trade is always USDT → MXTK
                tokenIn = this.USDT_ADDRESS;
                tokenOut = this.MXTK_ADDRESS;
                tradeDirection = 'USDT_TO_MXTK';
                availableBalance = usdtBalance;
                this.tradingLog('trade', 'Executing first trade: USDT → MXTK');
                this.isFirstTrade = false;
            } else {
                // Random direction for subsequent trades
                const isUsdtToMxtk = Math.random() < 0.5;
                tokenIn = isUsdtToMxtk ? this.USDT_ADDRESS : this.MXTK_ADDRESS;
                tokenOut = isUsdtToMxtk ? this.MXTK_ADDRESS : this.USDT_ADDRESS;
                tradeDirection = isUsdtToMxtk ? 'USDT_TO_MXTK' : 'MXTK_TO_USDT';
                availableBalance = isUsdtToMxtk ? usdtBalance : mxtkBalance;
                this.tradingLog('trade', `Selected direction: ${tradeDirection}`);
            }

            // Calculate maximum possible trade amount based on balance
            const decimals = tokenIn === this.USDT_ADDRESS ? 6 : 18;
            const minAmount = this.MIN_TRADE_AMOUNT;
            const maxAmount = ethers.BigNumber.from(this.MAX_TRADE_AMOUNT);
            
            // Ensure we don't exceed available balance
            const maxPossibleAmount = availableBalance.lt(maxAmount) ? availableBalance : maxAmount;

            // Check if we have enough balance for minimum trade
            if (maxPossibleAmount.lt(minAmount)) {
                throw new Error(`Insufficient ${tokenIn === this.USDT_ADDRESS ? 'USDT' : 'MXTK'} balance for minimum trade. ` +
                    `Need: ${ethers.utils.formatUnits(minAmount, decimals)}, ` +
                    `Have: ${ethers.utils.formatUnits(availableBalance, decimals)}`);
            }

            // Generate random amount within available balance
            const randomAmount = minAmount.add(
                maxPossibleAmount.sub(minAmount)
                    .mul(Math.floor(Math.random() * 1000))
                    .div(1000)
            );

            this.tradingLog('trade', 'Trade parameters', {
                direction: tradeDirection,
                tokenIn: tokenIn === this.USDT_ADDRESS ? 'USDT' : 'MXTK',
                tokenOut: tokenOut === this.USDT_ADDRESS ? 'USDT' : 'MXTK',
                availableBalance: ethers.utils.formatUnits(availableBalance, decimals),
                maxPossible: ethers.utils.formatUnits(maxPossibleAmount, decimals),
                selectedAmount: ethers.utils.formatUnits(randomAmount, decimals)
            });

            // Execute the swap
            await this.executeSwap(tokenIn, tokenOut, randomAmount);

            // Update last trade direction
            this.lastTradeDirection = tradeDirection;

            // Generate random delay for next trade
            const delay = Math.floor(Math.random() * (this.MAX_DELAY - this.MIN_DELAY + 1) + this.MIN_DELAY);
            this.tradingLog('system', `Next trade scheduled`, { delay: `${delay} seconds` });

            this.tradingLog('system', 'Random Trade Complete');
            return delay;
        } catch (error) {
            this.tradingLog('system', '❌ Random trade failed', {
                error: error.message,
                timestamp: new Date().toISOString()
            });
            
            // Log wallet state in case of failure
            try {
                const ethBalance = await this.masterWallet.getBalance();
                const usdtBalance = await this.usdtContract.balanceOf(this.masterWallet.address);
                const mxtkBalance = await this.mxtkContract.balanceOf(this.masterWallet.address);
                
                this.tradingLog('balance', 'Wallet state at error', {
                    ETH: ethers.utils.formatEther(ethBalance),
                    USDT: ethers.utils.formatUnits(usdtBalance, 6),
                    MXTK: ethers.utils.formatEther(mxtkBalance)
                });
            } catch (balanceError) {
                console.error('Failed to get balances during error handling:', balanceError);
            }
            
            throw error;
        }
    }

    setupLogging() {
        const originalLog = console.log;
        const originalError = console.error;
        const originalWarn = console.warn;

        // Enhanced logging with categories and emojis - without timestamps
        console.log = (...args) => {
            originalLog.apply(console, ['📝', ...args]);
        };

        console.error = (...args) => {
            originalError.apply(console, ['❌', ...args]);
        };

        console.warn = (...args) => {
            originalWarn.apply(console, ['⚠️', ...args]);
        };

        // Add custom trading logger without timestamps
        this.tradingLog = (type, message, data = {}) => {
            const icons = {
                trade: '💱',
                balance: '💰',
                gas: '⛽',
                system: '🔧'
            };
            console.log(`${icons[type] || '📝'} [${type.toUpperCase()}] ${message}`, data);
        };
    }

    async start() {
        try {
            await this.initialize();
            
            this.tradingLog('system', 'Starting trading loop...');
            
            // Main trading loop
            while (true) {
                try {
                    // Check balances before trade
                    await this.checkBalancesAndApprovals();

                    // Execute random trade
                    const delay = await this.performRandomTrade();

                    this.tradingLog('system', 'Waiting for next trade', {
                        delay: `${delay} seconds`,
                        nextTradeAt: new Date(Date.now() + delay * 1000).toISOString()
                    });

                    // Wait for random delay before next trade
                    await new Promise(resolve => setTimeout(resolve, delay * 1000));
                } catch (error) {
                    this.tradingLog('system', '❌ Error in trading loop', {
                        error: error.message,
                        errorType: error.constructor.name,
                        // Add retry information
                        retryIn: '60 seconds',
                        retryAt: new Date(Date.now() + 60000).toISOString()
                    });
                    // Wait 1 minute before retrying
                    await new Promise(resolve => setTimeout(resolve, 60000));
                }
            }
        } catch (error) {
            this.tradingLog('system', '❌ Fatal error in market maker', {
                error: error.message,
                errorType: error.constructor.name,
                stack: error.stack
            });
            throw error;
        }
    }
}

module.exports = MXTKMarketMaker;