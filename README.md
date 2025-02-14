# MXTK Market Maker Bot

A professional market making bot designed for the MXTK token on Arbitrum, using Uniswap for trading. The bot manages multiple wallets, implements safety features like circuit breakers, and includes monitoring and alert systems.

## Features

- **Natural Trading Patterns**:
  - Random wallet selection for trade distribution
  - Alternating buy/sell orders with random sizing
  - Variable delays between trades
  - Dynamic behavior adjustment based on market conditions

- **Advanced Trading Features**:
  - 2% slippage protection on all trades
  - Dynamic spread adjustment based on volatility
  - Gas optimization with automatic price adjustment
  - Configurable trade amount ranges
  
- **Multi-Wallet Management**:
  - Secure creation and management of trading wallets
  - Random wallet selection for each trade
  - Balance monitoring across all wallets
  
- **Safety Mechanisms**:
  - Circuit breaker (10% price movement threshold)
  - Daily volume limits
  - Dynamic spread adjustment based on volatility
  - Comprehensive error handling and recovery

- **Gas Optimization**:
  - Automatic gas price adjustment
  - Configurable gas limits
  - Transaction optimization

- **Monitoring & Alerts**:
  - Email notifications for critical events
  - Status endpoint for monitoring
  - Balance and price monitoring
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

3.Create a `.env` file based on the provided template:

```env
# Network configuration
NETWORK=mainnet
# Mainnet RPC endpoint
ARBITRUM_MAINNET_RPC=https://arb1.arbitrum.io/rpc
# Testnet RPC endpoint (for testing)
ARBITRUM_TESTNET_RPC=https://sepolia-rollup.arbitrum.io/rpc

# API Keys
MORALIS_API_KEY=your_moralis_api_key

# Trading Parameters
MAX_DAILY_VOLUME=1                       # Maximum MXTK tokens that can be traded in 24 hours
                                         # Bot stops trading when this limit is reached
                                         # Resets at UTC midnight

CIRCUIT_BREAKER_THRESHOLD=0.1            # If price moves by 10% (0.1), trading halts
                                         # Protects against sudden market movements
                                         # Trading resumes after 15 minutes if price stabilizes

LOW_BALANCE_THRESHOLD=0.1                # Minimum ETH balance (in ETH) for each wallet
                                         # Triggers alert when wallet balance falls below this
                                         # Used to ensure wallets have enough ETH for gas

VOLUME_ALERT_THRESHOLD=0.8               # Alerts when daily volume reaches 80% (0.8) of MAX_DAILY_VOLUME
                                         # Early warning system for volume limits
                                         # Example: Alert at 8 MXTK if MAX_DAILY_VOLUME is 10

# Trading Ranges
MIN_TRADE_AMOUNT=0.0005                  # Minimum amount of MXTK per trade
MAX_TRADE_AMOUNT=0.05                    # Maximum amount of MXTK per trade
                                         # Bot randomly selects amount between these values
                                         # Helps create natural trading patterns

MIN_TIME_DELAY=60                        # Minimum seconds between trades (1 minute)
MAX_TIME_DELAY=900                       # Maximum seconds between trades (15 minutes)
                                         # Bot randomly waits between these times
                                         # Prevents predictable trading patterns

# Spread Configuration
MIN_SPREAD=0.02                          # Minimum acceptable price spread (2%)
TARGET_SPREAD=0.015                      # Target price spread for trades (1.5%)
MAX_SPREAD=0.025                         # Maximum acceptable price spread (2.5%)
                                         # Bot adjusts orders based on these spreads
                                         # Helps maintain market liquidity

# Gas Configuration
MAX_GAS_PRICE=100                        # Maximum gas price in GWEI
                                         # Bot won't trade if gas price exceeds this
                                         # Prevents trading during high gas periods

GAS_LIMIT=300000                         # Maximum gas units per transaction
                                         # Safety limit for transaction execution
                                         # Prevents unexpectedly high gas usage

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
