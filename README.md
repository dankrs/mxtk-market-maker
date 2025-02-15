# MXTK Market Maker Bot

A professional market making bot designed for the MXTK token on Arbitrum, using Uniswap V3 for trading. The bot maintains a balanced order book with multiple standing orders, implements safety features like circuit breakers, and includes monitoring and alert systems.

## Features

- **Advanced Order Book Management**:
  - Maintains 10 orders on each side (10 buy/10 sell)
  - Total spread maintained under 2%
  - Even spacing between orders (0.1% minimum)
  - Automatic order rebalancing based on price movements

- **Natural Trading Patterns**:
  - Random wallet selection for trade distribution
  - Randomized order amounts (±20% of base amount)
  - Dynamic order placement and adjustment
  - Automatic price tracking and adjustment

- **Advanced Trading Features**:
  - Uniswap V3 integration with 0.3% fee tier
  - Dynamic spread adjustment based on volatility
  - Gas optimization with EIP-1559 support
  - Configurable trade amount ranges
  
- **Multi-Wallet Management**:
  - Secure creation and management of trading wallets
  - Random wallet selection for order placement
  - Balance monitoring across all wallets
  
- **Safety Mechanisms**:
  - Circuit breaker (10% price movement threshold)
  - Daily volume limits (1 MXTK per 24 hours)
  - Dynamic spread adjustment (0.1% - 2% range)
  - Comprehensive error handling and recovery

- **Gas Optimization**:
  - EIP-1559 gas fee model support
  - Maximum gas price of 500 GWEI
  - Gas limit of 500,000 for Arbitrum
  - Transaction optimization

- **Monitoring & Alerts**:
  - Email notifications for critical events
  - Low balance alerts (0.1 ETH threshold)
  - Volume alerts (80% of daily limit)
  - Trading pattern analytics

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Access to Arbitrum network
- Email account for alerts (SMTP access)

## Installation

1. Clone the repository:

```bash
git clone [repository-url]
cd mxtk-market-maker
```

2.Install dependencies:

```bash
npm install
```

3.Configure Environment Variables:
Create a `.env` file in the root directory with the following configuration:

```env
# Network Configuration
NETWORK=mainnet
ARBITRUM_MAINNET_RPC=https://arb1.arbitrum.io/rpc
ARBITRUM_TESTNET_RPC=https://sepolia-rollup.arbitrum.io/rpc

# Uniswap V3 Configuration
UNISWAP_V3_ROUTER=0xE592427A0AEce92De3Edee1F18E0157C05861564    # V3 SwapRouter
UNISWAP_V3_FACTORY=0x1F98431c8aD98523631AE4a59f267346ea31F984   # V3 Factory
UNISWAP_V3_QUOTER=0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6    # V3 Quoter
UNISWAP_POOL_FEE=3000                                           # 0.3% fee tier

# Token Addresses (Arbitrum Mainnet)
MXTK_ADDRESS=0x3e4Ffeb394B371AAaa0998488046Ca19d870d9Ba        # MXTK token address
USDT_ADDRESS=0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9        # USDT on Arbitrum

# Order Book Configuration
MIN_SPREAD=0.001                         # Minimum spacing between orders (0.1%)
TARGET_SPREAD=0.01                       # Target total spread (1%)
MAX_SPREAD=0.02                          # Maximum total spread (2%)
BASE_ORDER_AMOUNT=0.01                   # Base amount for each order
ORDER_AMOUNT_VARIANCE=0.2                # Order amount randomization (±20%)

# Trading Parameters
MAX_DAILY_VOLUME=1                       # Maximum trading volume per 24 hours
CIRCUIT_BREAKER_THRESHOLD=0.1            # 10% price movement triggers halt
LOW_BALANCE_THRESHOLD=0.1                # ETH balance warning threshold
VOLUME_ALERT_THRESHOLD=0.8               # Alert at 80% of max daily volume

# Gas Configuration
MAX_GAS_PRICE=500                        # Maximum gas price in GWEI
GAS_LIMIT=500000                         # Gas limit for Arbitrum

# SMTP Configuration
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_smtp_password

# Alert Configuration
ALERT_FROM_EMAIL=your_email@gmail.com
ALERT_TO_EMAIL=your_email@gmail.com

# Master Wallet Configuration
MASTER_WALLET_PRIVATE_KEY=your_master_wallet_private_key
```

## Configuration Details

### Network Settings

- Supports both Arbitrum mainnet and testnet
- Configurable RPC endpoints for both networks

### Order Book Parameters

- Minimum order spacing: 0.1% (0.001)
- Target spread: 1% (0.01)
- Maximum spread: 2% (0.02)
- Base order size: 0.01 MXTK
- Order size variance: ±20%

### Trading Limits

- Maximum daily volume: 1 MXTK
- Circuit breaker threshold: 10% price movement
- Volume alert threshold: 80% of daily limit
- Minimum ETH balance: 0.1 ETH

### Gas Optimization

- Maximum gas price: 500 GWEI
- Gas limit: 500,000 units
- EIP-1559 compatible fee calculation

### Alert System

- SMTP-based email alerts
- Configurable alert thresholds
- Critical event notifications
- Balance and volume monitoring

## Security Considerations

1. Keep your `.env` file secure and never commit it to version control
2. Use a dedicated email for alerts
3. Secure your master wallet private key
4. Regularly monitor wallet balances and trading patterns
5. Test thoroughly on testnet before deploying to mainnet

Would you like me to explain any specific configuration in more detail?
