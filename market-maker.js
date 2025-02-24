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
        
        // Setup logging first
        this.setupLogging();
        
        // Now we can use this.tradingLog
        this.tradingLog('system', 'Initializing market maker...');
        
        // Validate MXTK address format
        if (!process.env.MXTK_ADDRESS) {
            throw new Error('MXTK_ADDRESS not found in environment variables');
        }
        try {
            this.MXTK_ADDRESS = ethers.utils.getAddress(process.env.MXTK_ADDRESS);
            this.tradingLog('system', '✅ MXTK address validated', { address: this.MXTK_ADDRESS });
        } catch (error) {
            throw new Error(`Invalid MXTK address format: ${process.env.MXTK_ADDRESS}`);
        }

        // Validate USDT address format
        if (!process.env.USDT_ADDRESS) {
            throw new Error('USDT_ADDRESS not found in environment variables');
        }
        try {
            this.USDT_ADDRESS = ethers.utils.getAddress(process.env.USDT_ADDRESS);
            this.tradingLog('system', '✅ USDT address validated', { address: this.USDT_ADDRESS });
        } catch (error) {
            throw new Error(`Invalid USDT address format: ${process.env.USDT_ADDRESS}`);
        }
        
        // Validate Uniswap V3 Router address
        if (!process.env.UNISWAP_V3_ROUTER) {
            throw new Error('UNISWAP_V3_ROUTER not found in environment variables');
        }
        try {
            this.UNISWAP_V3_ROUTER = ethers.utils.getAddress(process.env.UNISWAP_V3_ROUTER);
            this.tradingLog('system', '✅ Uniswap V3 Router address validated', { address: this.UNISWAP_V3_ROUTER });
        } catch (error) {
            throw new Error(`Invalid Uniswap V3 Router address format: ${process.env.UNISWAP_V3_ROUTER}`);
        }

        // Validate Uniswap V3 Factory address
        if (!process.env.UNISWAP_V3_FACTORY) {
            throw new Error('UNISWAP_V3_FACTORY not found in environment variables');
        }
        try {
            this.UNISWAP_V3_FACTORY = ethers.utils.getAddress(process.env.UNISWAP_V3_FACTORY);
            this.tradingLog('system', '✅ Uniswap V3 Factory address validated', { address: this.UNISWAP_V3_FACTORY });
        } catch (error) {
            throw new Error(`Invalid Uniswap V3 Factory address format: ${process.env.UNISWAP_V3_FACTORY}`);
        }

        // Validate Uniswap V3 Quoter address
        if (!process.env.UNISWAP_V3_QUOTER) {
            throw new Error('UNISWAP_V3_QUOTER not found in environment variables');
        }
        try {
            this.UNISWAP_V3_QUOTER = ethers.utils.getAddress(process.env.UNISWAP_V3_QUOTER);
            this.tradingLog('system', '✅ Uniswap V3 Quoter address validated', { address: this.UNISWAP_V3_QUOTER });
        } catch (error) {
            throw new Error(`Invalid Uniswap V3 Quoter address format: ${process.env.UNISWAP_V3_QUOTER}`);
        }

        // Log contract addresses
        this.tradingLog('system', 'Contract addresses verified', {
            MXTK: this.MXTK_ADDRESS,
            USDT: this.USDT_ADDRESS,
            Router: this.UNISWAP_V3_ROUTER,
            Factory: this.UNISWAP_V3_FACTORY,
            Quoter: this.UNISWAP_V3_QUOTER
        });

        // Trading parameters - use environment variables for both tokens
        const minUsdtTrade = parseFloat(process.env.MIN_USDT_TRADE);
        const maxUsdtTrade = parseFloat(process.env.MAX_USDT_TRADE);
        const minMxtkTrade = parseFloat(process.env.MIN_MXTK_TRADE);
        const maxMxtkTrade = parseFloat(process.env.MAX_MXTK_TRADE);
        
        // Validate USDT trade amounts
        if (isNaN(minUsdtTrade) || minUsdtTrade <= 0) {
            throw new Error(`Invalid MIN_USDT_TRADE value: ${process.env.MIN_USDT_TRADE}`);
        }
        if (isNaN(maxUsdtTrade) || maxUsdtTrade <= minUsdtTrade) {
            throw new Error(`Invalid MAX_USDT_TRADE value: ${process.env.MAX_USDT_TRADE}. Must be greater than MIN_USDT_TRADE`);
        }

        // Validate MXTK trade amounts
        if (isNaN(minMxtkTrade) || minMxtkTrade <= 0) {
            throw new Error(`Invalid MIN_MXTK_TRADE value: ${process.env.MIN_MXTK_TRADE}`);
        }
        if (isNaN(maxMxtkTrade) || maxMxtkTrade <= minMxtkTrade) {
            throw new Error(`Invalid MAX_MXTK_TRADE value: ${process.env.MAX_MXTK_TRADE}. Must be greater than MIN_MXTK_TRADE`);
        }

        // Convert to proper units for both tokens
        this.MIN_USDT_AMOUNT = ethers.utils.parseUnits(minUsdtTrade.toString(), 6);  // USDT has 6 decimals
        this.MAX_USDT_AMOUNT = ethers.utils.parseUnits(maxUsdtTrade.toString(), 6);
        this.MIN_MXTK_AMOUNT = ethers.utils.parseUnits(minMxtkTrade.toString(), 18); // MXTK has 18 decimals
        this.MAX_MXTK_AMOUNT = ethers.utils.parseUnits(maxMxtkTrade.toString(), 18);

        this.tradingLog('system', 'Trade amount configuration', {
            USDT: {
                min: `${minUsdtTrade} USDT`,
                max: `${maxUsdtTrade} USDT`,
            },
            MXTK: {
                min: `${minMxtkTrade} MXTK`,
                max: `${maxMxtkTrade} MXTK`,
            }
        });

        // Trading parameters
        this.MIN_DELAY = 30;  // 30 seconds
        this.MAX_DELAY = 300; // 5 minutes
        
        // Convert MAX_SLIPPAGE from percentage to basis points
        const maxSlippagePercent = parseFloat(process.env.MAX_SLIPPAGE);
        this.SLIPPAGE_TOLERANCE = Math.floor(maxSlippagePercent * 100); // Convert 0.02 (2%) to 200 basis points
        
        if (isNaN(this.SLIPPAGE_TOLERANCE) || this.SLIPPAGE_TOLERANCE <= 0) {
            throw new Error(`Invalid MAX_SLIPPAGE value: ${process.env.MAX_SLIPPAGE}. Expected a decimal value like 0.02 for 2%`);
        }

        this.tradingLog('system', 'Slippage configuration', {
            maxSlippagePercent: `${maxSlippagePercent * 100}%`,
            basisPoints: this.SLIPPAGE_TOLERANCE
        });

        // Initialize state
        this.lastTradeDirection = null;
        this.isFirstTrade = true;
        
        // Initialize email transporter
        this.emailTransporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT),
            secure: false, // true for 465, false for other ports
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });

        // Validate email configuration
        this.validateEmailConfig();

        // Validate UNISWAP_POOL_FEE
        const validFeeTiers = [100, 500, 3000, 10000]; // 0.01%, 0.05%, 0.3%, 1%
        const poolFee = parseInt(process.env.UNISWAP_POOL_FEE);
        
        if (!validFeeTiers.includes(poolFee)) {
            throw new Error(`Invalid UNISWAP_POOL_FEE value: ${poolFee}. Must be one of: ${validFeeTiers.join(', ')} (representing 0.01%, 0.05%, 0.3%, 1%)`);
        }

        this.POOL_FEE = poolFee;  // Store validated fee

        this.tradingLog('system', 'Pool fee configuration', {
            fee: `${poolFee/10000}%`,
            basisPoints: poolFee
        });
    }

    async validateEmailConfig() {
        try {
            // Validate all required email variables exist
            const requiredVars = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'ALERT_FROM_EMAIL', 'ALERT_TO_EMAIL'];
            const missing = requiredVars.filter(varName => !process.env[varName]);
            
            if (missing.length > 0) {
                throw new Error(`Missing required email configuration: ${missing.join(', ')}`);
            }

            // Verify email configuration
            await this.emailTransporter.verify();
            this.tradingLog('system', '✅ Email service configured successfully');

            // Send test email
            await this.sendErrorEmail('Bot Started - Email Test', {
                type: 'System Test',
                message: 'Email notification system is working correctly',
                additional: {
                    botStartTime: new Date().toISOString(),
                    environment: process.env.NETWORK
                }
            });

        } catch (error) {
            this.tradingLog('system', '❌ Email service configuration failed', {
                error: error.message
            });
            // Make this a fatal error
            throw new Error(`Email configuration failed: ${error.message}`);
        }
    }

    async sendErrorEmail(subject, errorDetails) {
        try {
            const emailBody = `
                <h2>MXTK Market Maker Error Alert</h2>
                <p><strong>Time:</strong> ${new Date().toISOString()}</p>
                <p><strong>Error Type:</strong> ${errorDetails.type || 'Unknown'}</p>
                <p><strong>Error Message:</strong> ${errorDetails.message}</p>
                ${errorDetails.stack ? `<p><strong>Stack Trace:</strong><br/><pre>${errorDetails.stack}</pre></p>` : ''}
                ${errorDetails.additional ? `<p><strong>Additional Info:</strong><br/>${JSON.stringify(errorDetails.additional, null, 2)}</p>` : ''}
            `;

            await this.emailTransporter.sendMail({
                from: process.env.ALERT_FROM_EMAIL,
                to: process.env.ALERT_TO_EMAIL,
                subject: `MXTK Market Maker Alert: ${subject}`,
                html: emailBody
            });

            this.tradingLog('system', '✅ Error notification email sent', { subject });
        } catch (error) {
            this.tradingLog('system', '❌ Failed to send error email', {
                error: error.message
            });
        }
    }

    async initialize() {
        try {
            this.tradingLog('system', '=== Initializing MXTK Market Maker ===');

            // Initialize master wallet
            this.masterWallet = new ethers.Wallet(process.env.MASTER_WALLET_PRIVATE_KEY, this.provider);
            this.tradingLog('system', 'Master wallet initialized', {
                address: this.masterWallet.address
            });

            // Initialize contracts
            await this.initializeContracts();

            // Check balances and approvals
            await this.checkBalancesAndApprovals();

            this.tradingLog('system', '=== Initialization Complete ===');
        } catch (error) {
            this.tradingLog('system', '❌ Initialization failed', {
                error: error.message
            });
            throw error;
        }
    }

    async initializeContracts() {
        this.tradingLog('system', '=== Initializing contracts ===');
        
        // Normalize addresses during initialization
        this.MXTK_ADDRESS = await this.normalizeAddress(this.MXTK_ADDRESS);
        this.USDT_ADDRESS = await this.normalizeAddress(this.USDT_ADDRESS);
        this.UNISWAP_V3_ROUTER = await this.normalizeAddress(this.UNISWAP_V3_ROUTER);
        this.UNISWAP_V3_FACTORY = await this.normalizeAddress(this.UNISWAP_V3_FACTORY);
        this.UNISWAP_V3_QUOTER = await this.normalizeAddress(this.UNISWAP_V3_QUOTER);
        
        // Initialize contracts with normalized addresses
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

        this.quoterContract = new ethers.Contract(
            this.UNISWAP_V3_QUOTER,
            [
                'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)',
                'function quoteExactOutputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountOut, uint160 sqrtPriceLimitX96) external returns (uint256 amountIn)'
            ],
            this.provider
        );

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
        this.tradingLog('system', '=== Checking balances and approvals ===');

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

    async normalizeAddress(address) {
        try {
            // Use ethers.utils.getAddress to get checksummed address
            return ethers.utils.getAddress(address);
        } catch (error) {
            this.tradingLog('system', '❌ Invalid address format', {
                address,
                error: error.message
            });
            throw new Error(`Invalid address format: ${address}`);
        }
    }

    async executeSwap(tokenIn, tokenOut, amountIn, isExactIn = true) {
        try {
            this.tradingLog('trade', '=== Starting Swap Execution ===');
            
            // Normalize token addresses
            const normalizedTokenIn = await this.normalizeAddress(tokenIn);
            const normalizedTokenOut = await this.normalizeAddress(tokenOut);
            
            // Log the pool we're using
            const fee = this.POOL_FEE;
            this.tradingLog('trade', 'Pool Details', {
                tokenIn: normalizedTokenIn === this.USDT_ADDRESS ? 'USDT' : 'MXTK',
                tokenOut: normalizedTokenOut === this.USDT_ADDRESS ? 'USDT' : 'MXTK',
                fee: `${fee/10000}%`,
                poolAddress: `${this.UNISWAP_V3_FACTORY}/${normalizedTokenIn}/${normalizedTokenOut}/${fee}`
            });

            // Get quote first to verify pool exists and has liquidity
            try {
                const quoteResult = await this.quoterContract.callStatic.quoteExactInputSingle(
                    normalizedTokenIn,
                    normalizedTokenOut,
                    fee,
                    amountIn,
                    0
                );
                this.tradingLog('trade', 'Quote received', {
                    amountIn: ethers.utils.formatUnits(amountIn, normalizedTokenIn === this.USDT_ADDRESS ? 6 : 18),
                    expectedOut: ethers.utils.formatUnits(quoteResult, normalizedTokenOut === this.USDT_ADDRESS ? 6 : 18)
                });
            } catch (error) {
                throw new Error(`Failed to get quote: ${error.message}. This might indicate no pool exists or has no liquidity for the selected fee tier.`);
            }

            // Get current gas prices from network
            const feeData = await this.provider.getFeeData();
            this.tradingLog('gas', 'Current Gas Prices', {
                baseFee: `${ethers.utils.formatUnits(feeData.lastBaseFeePerGas || feeData.gasPrice, 'gwei')} gwei`,
                maxPriorityFee: `${ethers.utils.formatUnits(feeData.maxPriorityFeePerGas, 'gwei')} gwei`,
                maxFeePerGas: `${ethers.utils.formatUnits(feeData.maxFeePerGas, 'gwei')} gwei`
            });

            // Prepare transaction parameters
            const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

            // Get quote and estimate gas
            console.log('\n=== Estimating transaction parameters ===');
            const params = {
                tokenIn: normalizedTokenIn,
                tokenOut: normalizedTokenOut,
                fee: fee,
                recipient: this.masterWallet.address,
                deadline,
                amountIn,
                amountOutMinimum: 0,
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
            console.log('\n=== Getting Uniswap quote ===');
            const amountOut = await this.quoterContract.callStatic.quoteExactInputSingle(
                normalizedTokenIn,
                normalizedTokenOut,
                fee,
                amountIn,
                0
            );

            // Calculate minimum amount out with slippage tolerance
            const minAmountOut = amountOut.mul(10000 - this.SLIPPAGE_TOLERANCE).div(10000);

            this.tradingLog('trade', 'Slippage protection', {
                expectedOutput: ethers.utils.formatUnits(amountOut, normalizedTokenOut === this.USDT_ADDRESS ? 6 : 18),
                minimumOutput: ethers.utils.formatUnits(minAmountOut, normalizedTokenOut === this.USDT_ADDRESS ? 6 : 18),
                slippagePercent: `${this.SLIPPAGE_TOLERANCE / 100}%`
            });

            // Update params with real minimum output
            params.amountOutMinimum = minAmountOut;

            // Execute the swap with gas parameters
            console.log('\n=== Executing swap with parameters ===');
            console.log('Token In:', normalizedTokenIn);
            console.log('Token Out:', normalizedTokenOut);
            console.log('Amount In:', ethers.utils.formatUnits(amountIn, normalizedTokenIn === this.USDT_ADDRESS ? 6 : 18));
            console.log('Min Amount Out:', ethers.utils.formatUnits(minAmountOut, normalizedTokenOut === this.USDT_ADDRESS ? 6 : 18));
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

            this.tradingLog('trade', '=== Swap Execution Complete ===');
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

            // Send email for swap failures
            await this.sendErrorEmail('Swap Execution Failed', {
                type: 'Swap Error',
                message: error.message,
                additional: error.transaction ? {
                    transaction: {
                        hash: error.transaction.hash,
                        from: error.transaction.from,
                        to: error.transaction.to
                    }
                } : undefined
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

    async verifyPool(tokenA, tokenB, fee) {
        let normalizedTokenA, normalizedTokenB;
        try {
            // Normalize addresses first
            normalizedTokenA = await this.normalizeAddress(tokenA);
            normalizedTokenB = await this.normalizeAddress(tokenB);
            
            // Ensure tokens are in correct order (lower address first)
            if (normalizedTokenA.toLowerCase() > normalizedTokenB.toLowerCase()) {
                [normalizedTokenA, normalizedTokenB] = [normalizedTokenB, normalizedTokenA];
            }
            
            this.tradingLog('system', 'Verifying pool with ordered tokens', {
                token0: normalizedTokenA === this.USDT_ADDRESS ? 'USDT' : 'MXTK',
                token1: normalizedTokenB === this.USDT_ADDRESS ? 'USDT' : 'MXTK',
                fee: `${fee/10000}%`
            });

            // Get pool address from factory
            const factoryContract = new ethers.Contract(
                this.UNISWAP_V3_FACTORY,
                ['function getPool(address,address,uint24) external view returns (address)'],
                this.provider
            );
            
            const poolAddress = await factoryContract.getPool(normalizedTokenA, normalizedTokenB, fee);
            
            // Check if pool exists
            if (poolAddress === ethers.constants.AddressZero) {
                throw new Error(`No pool exists for ${normalizedTokenA}/${normalizedTokenB} with fee ${fee/10000}%`);
            }

            // Initialize pool contract to check its state
            const poolContract = new ethers.Contract(
                poolAddress,
                [
                    'function token0() external view returns (address)',
                    'function token1() external view returns (address)',
                    'function liquidity() external view returns (uint128)',
                    'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'
                ],
                this.provider
            );

            // Get pool data
            const [actualToken0, actualToken1, liquidity, slot0] = await Promise.all([
                poolContract.token0(),
                poolContract.token1(),
                poolContract.liquidity(),
                poolContract.slot0()
            ]);

            // Verify token ordering matches
            if (actualToken0.toLowerCase() !== normalizedTokenA.toLowerCase() ||
                actualToken1.toLowerCase() !== normalizedTokenB.toLowerCase()) {
                throw new Error('Pool token ordering mismatch');
            }

            // Check liquidity
            if (liquidity.eq(0)) {
                throw new Error(`Pool ${poolAddress} exists but has no liquidity`);
            }

            // Log pool verification success
            this.tradingLog('system', '✅ Pool verification successful', {
                poolAddress: ethers.utils.getAddress(poolAddress),
                token0: normalizedTokenA === this.USDT_ADDRESS ? 'USDT' : 'MXTK',
                token1: normalizedTokenB === this.USDT_ADDRESS ? 'USDT' : 'MXTK',
                liquidity: liquidity.toString(),
                sqrtPriceX96: slot0.sqrtPriceX96.toString(),
                tick: slot0.tick.toString()
            });

            return {
                poolAddress: ethers.utils.getAddress(poolAddress),
                token0: normalizedTokenA,
                token1: normalizedTokenB,
                liquidity: liquidity.toString(),
                sqrtPriceX96: slot0.sqrtPriceX96.toString(),
                tick: slot0.tick
            };

        } catch (error) {
            this.tradingLog('system', '❌ Pool verification failed', {
                tokenA: tokenA,
                tokenB: tokenB,
                normalizedTokenA: normalizedTokenA || 'normalization failed',
                normalizedTokenB: normalizedTokenB || 'normalization failed',
                fee: `${fee/10000}%`,
                error: error.message
            });
            
            throw error;
        }
    }

    async performRandomTrade() {
        try {
            this.tradingLog('system', '=== Starting Random Trade ===');
            
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
                
                // If previous trade was in the same direction, force opposite direction
                if (this.lastTradeDirection === 'USDT_TO_MXTK' && isUsdtToMxtk) {
                    tokenIn = this.MXTK_ADDRESS;
                    tokenOut = this.USDT_ADDRESS;
                    tradeDirection = 'MXTK_TO_USDT';
                } else if (this.lastTradeDirection === 'MXTK_TO_USDT' && !isUsdtToMxtk) {
                    tokenIn = this.USDT_ADDRESS;
                    tokenOut = this.MXTK_ADDRESS;
                    tradeDirection = 'USDT_TO_MXTK';
                } else {
                    tokenIn = isUsdtToMxtk ? this.USDT_ADDRESS : this.MXTK_ADDRESS;
                    tokenOut = isUsdtToMxtk ? this.MXTK_ADDRESS : this.USDT_ADDRESS;
                    tradeDirection = isUsdtToMxtk ? 'USDT_TO_MXTK' : 'MXTK_TO_USDT';
                }
                
                availableBalance = isUsdtToMxtk ? usdtBalance : mxtkBalance;
                this.tradingLog('trade', `Selected direction: ${tradeDirection}`, {
                    reason: this.lastTradeDirection ? 'Random selection' : 'Forced opposite direction'
                });
            }

            // Calculate maximum possible trade amount based on balance
            const decimals = tokenIn === this.USDT_ADDRESS ? 6 : 18;
            const minAmount = tokenIn === this.USDT_ADDRESS ? this.MIN_USDT_AMOUNT : this.MIN_MXTK_AMOUNT;
            const maxAmount = tokenIn === this.USDT_ADDRESS ? this.MAX_USDT_AMOUNT : this.MAX_MXTK_AMOUNT;
            
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
                limits: {
                    min: ethers.utils.formatUnits(minAmount, decimals),
                    max: ethers.utils.formatUnits(maxAmount, decimals),
                    selected: ethers.utils.formatUnits(randomAmount, decimals)
                }
            });

            // Verify pool exists and has liquidity before attempting swap
            const poolInfo = await this.verifyPool(tokenIn, tokenOut, this.POOL_FEE);
            
            // Execute the swap
            await this.executeSwap(tokenIn, tokenOut, randomAmount);

            // Update last trade direction
            this.lastTradeDirection = tradeDirection;

            // Generate random delay for next trade
            const delay = Math.floor(Math.random() * (this.MAX_DELAY - this.MIN_DELAY + 1) + this.MIN_DELAY);
            this.tradingLog('system', `Next trade scheduled`, { 
                delay: `${delay} seconds`,
                nextTradeAt: new Date(Date.now() + delay * 1000).toISOString()
            });

            this.tradingLog('system', '=== Random Trade Complete ===');
            return delay;
        } catch (error) {
            this.tradingLog('system', '❌ Random trade failed', {
                error: error.message,
                timestamp: new Date().toISOString()
            });
            
            // Send detailed error email
            await this.sendErrorEmail('Trade Execution Failed', {
                type: 'Trade Execution Error',
                message: error.message,
                stack: error.stack,
                additional: {
                    lastTradeDirection: this.lastTradeDirection,
                    isFirstTrade: this.isFirstTrade
                }
            });
            
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
                trade: message.includes('Complete') || message.includes('confirmed') ? '✅' : '💱',
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
            
            this.tradingLog('system', '=== Starting trading loop ===');
            
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

            // Send email for fatal errors
            await this.sendErrorEmail('Fatal Error - Bot Stopped', {
                type: 'Fatal Error',
                message: error.message,
                stack: error.stack
            });

            throw error;
        }
    }
}

module.exports = MXTKMarketMaker;