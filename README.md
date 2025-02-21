# MXTK Market Maker Bot

A professional market making bot designed for the MXTK token on Arbitrum, using Uniswap V3 for trading. The bot implements safety features like circuit breakers, gas optimization, and includes monitoring and alert systems.

## Current Features

- **Trading Strategy**:
  - Alternates between USDT → MXTK and MXTK → USDT trades
  - First trade is always USDT → MXTK
  - Random trade amounts within configured ranges
  - Configurable delays between trades (10-120 seconds)

- **Token Management**:
  - MXTK (18 decimals) and USDT (6 decimals) support
  - Automatic token approvals for Uniswap V3
  - Balance monitoring and validation
  - Minimum trade size enforcement

- **Multi-Wallet Management**:
  - Maintains 3 trading wallets
  - Random wallet selection for trades
  - Automatic ETH and token distribution
  - Balance monitoring across wallets

- **Safety Mechanisms**:
  - Circuit breaker (10% price movement threshold)
  - Daily volume limits
  - Low ETH balance checks (0.0002 ETH minimum)
  - Comprehensive error handling

- **Gas Optimization**:
  - EIP-1559 gas fee model support
  - Dynamic gas estimation with safety margins
  - Configurable gas limits and prices
  - Transaction parameter optimization

- **Monitoring & Logging**:
  - Detailed transaction logging to files
  - Daily log rotation
  - Email notifications for critical events
  - Balance and trade monitoring

## Trading Parameters

- **USDT Trading Range**:
  - Minimum: 0.01 USDT
  - Maximum: 1.0 USDT

- **MXTK Trading Range**:
  - Minimum: 0.0001 MXTK
  - Maximum: 0.002 MXTK

- **Time Delays**:
  - Minimum: 10 seconds
  - Maximum: 120 seconds

- **ETH Requirements**:
  - Minimum per wallet: 0.0002 ETH
  - Gas safety margin: 50%
  - Priority fee adjustment: 20%

## Configuration

Create a `.env` file with the following required parameters:

```env
# Network Configuration
ARBITRUM_MAINNET_RPC=https://arb1.arbitrum.io/rpc

# Network Configuration
NETWORK=mainnet
MORALIS_API_KEY=your_moralis_api_key
ARBITRUM_MAINNET_RPC=https://arb1.arbitrum.io/rpc
ARBITRUM_TESTNET_RPC=https://sepolia-rollup.arbitrum.io/rpc

# Trading Parameters
MAX_DAILY_VOLUME=1
CIRCUIT_BREAKER_THRESHOLD=0.1
LOW_BALANCE_THRESHOLD=0.0002
VOLUME_ALERT_THRESHOLD=0.8

# Trading Ranges
MIN_TIME_DELAY=10
MAX_TIME_DELAY=120

# Spread Configuration  
MIN_SPREAD=0.01
TARGET_SPREAD=0.015
MAX_SPREAD=0.02

# Gas Configuration
MAX_GAS_PRICE=500
GAS_LIMIT=500000

# SMTP Configuration
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_password
ALERT_FROM_EMAIL=your_email@gmail.com
ALERT_TO_EMAIL=your_email@gmail.com

# Wallet Configuration
MASTER_WALLET_PRIVATE_KEY=your_private_key
REQUIRED_ETH_PER_WALLET=0.0002

# Uniswap V3 Configuration
UNISWAP_V3_ROUTER=0xE592427A0AEce92De3Edee1F18E0157C05861564
UNISWAP_V3_FACTORY=0x1F98431c8aD98523631AE4a59f267346ea31F984
UNISWAP_V3_QUOTER=0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6
UNISWAP_POOL_FEE=3000

# Token Addresses
MXTK_ADDRESS=0x3e4Ffeb394B371AAaa0998488046Ca19d870d9Ba
USDT_ADDRESS=0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9

# Slippage Settings
MAX_SLIPPAGE=0.02

# USDT Trading Ranges
MIN_USDT_TRADE=0.01
MAX_USDT_TRADE=1.0

# MXTK Trading Ranges  
MIN_MXTK_TRADE=0.0001
MAX_MXTK_TRADE=0.002
```

## Important Notes

1. The bot maintains detailed logs in the `logs` directory
2. Each wallet requires a minimum of 0.0002 ETH for gas
3. Token approvals are checked and renewed automatically
4. Failed transactions are logged with detailed error information
5. Gas estimation includes safety margins for Arbitrum network

## Security Considerations

1. Keep your `.env` file secure
2. Monitor wallet balances regularly
3. Check logs for any unusual patterns
4. Test thoroughly before deploying to mainnet
