# MXTK Market Maker Bot

A professional market making bot designed for the MXTK token on Arbitrum, using Uniswap V3 for trading. The bot implements safety features like dynamic gas optimization and comprehensive monitoring systems.

## Current Features

- **Trading Strategy**:
  - First trade is always USDT → MXTK
  - Subsequent trades alternate randomly between USDT → MXTK and MXTK → USDT
  - Random trade amounts within configured ranges
  - Configurable delays between trades (30-600 seconds)

- **Token Management**:
  - MXTK (18 decimals) and USDT (6 decimals) support
  - Automatic token approvals for Uniswap V3
  - Real-time balance monitoring
  - Minimum trade size enforcement

- **Single Wallet Architecture**:
  - Uses one master wallet for all operations
  - Dynamic ETH balance checking
  - Real-time gas cost estimation
  - Automatic approval management

- **Safety Mechanisms**:
  - Circuit breaker (10% price movement threshold)
  - Daily volume limits
  - Dynamic gas price monitoring
  - Comprehensive error handling

- **Gas Optimization**:
  - EIP-1559 gas fee model support
  - Real-time gas estimation from network
  - Dynamic gas limit calculation
  - 10% gas limit buffer for safety

- **Monitoring & Logging**:
  - Detailed transaction logging with timestamps
  - WebSocket monitoring of pending transactions
  - Real-time block monitoring
  - Comprehensive error state logging

## Trading Parameters

- **USDT Trading Range**:
  - Minimum: 0.01 USDT
  - Maximum: 0.5 USDT

- **MXTK Trading Range**:
  - Minimum: 0.0001 MXTK
  - Maximum: 0.002 MXTK

- **Time Delays**:
  - Minimum: 30 seconds
  - Maximum: 600 seconds

- **Slippage Settings**:
  - Maximum slippage: 2%
  - Pool fee: 0.3%

## Configuration

Create a `.env` file with the following parameters:

```env
# Network Configuration
NETWORK=mainnet
ARBITRUM_MAINNET_RPC=https://arb1.arbitrum.io/rpc
ARBITRUM_TESTNET_RPC=https://sepolia-rollup.arbitrum.io/rpc

# Trading Parameters
# MAX_DAILY_VOLUME=1                       # Maximum trading volume per day
# CIRCUIT_BREAKER_THRESHOLD=0.1            # 10% price movement triggers halt
# LOW_BALANCE_THRESHOLD=0.0002             # ETH balance warning threshold
# VOLUME_ALERT_THRESHOLD=0.8               # Alert at 80% of max daily volume

# Trading Ranges
MIN_TIME_DELAY=30                        # Minimum seconds between trades (30s)
MAX_TIME_DELAY=600                       # Maximum seconds between trades (10min)

# Spread Configuration
# MIN_SPREAD=0.01                          # Minimum acceptable price spread (1%)
# TARGET_SPREAD=0.015                      # Target price spread for trades (1.5%)
# MAX_SPREAD=0.02                          # Maximum acceptable price spread (2%)

# Gas Configuration
# MAX_GAS_PRICE=500                        # Maximum gas price in GWEI
# GAS_LIMIT=500000                         # Gas limit for Arbitrum

# SMTP Configuration
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password

# Email addresses for alerts
ALERT_FROM_EMAIL=your_email@gmail.com
ALERT_TO_EMAIL=your_email@gmail.com

# Master Wallet
MASTER_WALLET_PRIVATE_KEY=your_private_key

# Uniswap V3 Configuration
UNISWAP_V3_ROUTER=0xE592427A0AEce92De3Edee1F18E0157C05861564
UNISWAP_V3_FACTORY=0x1F98431c8aD98523631AE4a59f267346ea31F984
UNISWAP_V3_QUOTER=0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6
UNISWAP_POOL_FEE=3000                                               # 0.3% fee tier

# Token Addresses (Arbitrum Mainnet)
MXTK_ADDRESS=0x3e4Ffeb394B371AAaa0998488046Ca19d870d9Ba
USDT_ADDRESS=0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9

# Slippage Settings
MAX_SLIPPAGE=0.02                        # Maximum allowed slippage (2%)

# USDT Trading Ranges (in USDT)
MIN_USDT_TRADE=0.01                     # Minimum USDT trade amount
MAX_USDT_TRADE=0.5                      # Maximum USDT trade amount

# MXTK Trading Ranges (in MXTK)
MIN_MXTK_TRADE=0.0001                    # Minimum MXTK trade amount
MAX_MXTK_TRADE=0.002                     # Maximum MXTK trade amount
```

## Important Notes

1. The bot uses real-time gas estimation from the Arbitrum network
2. Gas costs include a 10% buffer for safety
3. Token approvals are checked and renewed automatically
4. Failed transactions are logged with detailed error information
5. All operations are performed from a single master wallet

## Security Considerations

1. Keep your `.env` file secure and never share your private keys
2. Monitor master wallet balance regularly
3. Check logs for any unusual patterns or errors
4. Test thoroughly before deploying to mainnet
5. Ensure sufficient ETH balance for gas fees

## Monitoring Features

1. Real-time transaction monitoring via WebSocket
2. Block-by-block gas price monitoring
3. Detailed logging of all operations with timestamps
4. Balance tracking before and after each trade
5. Comprehensive error state logging with wallet status
