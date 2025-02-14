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
ARBITRUM_MAINNET_RPC=https://arb1.arbitrum.io/rpc

# API Keys
MORALIS_API_KEY=your_moralis_api_key

# SMTP Configuration
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_smtp_password

# Alert Configuration
ALERT_FROM_EMAIL=your_email@gmail.com
ALERT_TO_EMAIL=your_email@gmail.com

# Wallet Configuration
MASTER_WALLET_PRIVATE_KEY=your_master_wallet_private_key
```

## Configuration

The market maker can be configured through environment variables and the constructor config object in `market-maker.js`. Key configuration parameters include:

- `maxDailyVolume`: Maximum trading volume per day
- `circuitBreakerThreshold`: Price change threshold for halting trading
- `timeRange`: Min/max delay between trades
- `amountRange`: Min/max trade amounts
- `minSpread/maxSpread`: Trading spread limits

## Usage

Start the market maker:

```bash
node index.js
```

## Architecture

### Key Components

1. **WalletManager (`wallet-manager.js`)**
   - Manages wallet creation and storage
   - Handles secure storage of private keys
   - Provides wallet loading and retrieval

2. **MarketMaker (`market-maker.js`)**
   - Core trading logic
   - Price monitoring and circuit breaker
   - Order creation and execution
   - State management and recovery

3. **API Server (`index.js`)**
   - Status endpoint
   - Health monitoring

### Security Features

- Secure wallet storage
- Circuit breaker protection
- Balance monitoring
- Error recovery system
- Email alerts for critical events

## Monitoring

The bot provides several monitoring features:

1. **Status Endpoint** (`/status`):
   - Current trading status
   - Daily volume
   - Circuit breaker status
   - Last price and update time

2. **Email Alerts**:
   - Low balance warnings
   - Circuit breaker activation
   - Error notifications
   - Trading anomalies

## Development

### Project Structure

```
├── index.js           # Entry point and API server
├── market-maker.js    # Core market making logic
├── wallet-manager.js  # Wallet management system
├── .env              # Environment configuration
└── recovery.json     # State persistence file
```

### Adding New Features

1. Fork the repository
2. Create a feature branch
3. Implement changes
4. Add tests if applicable
5. Submit a pull request

## Troubleshooting

Common issues and solutions:

1. **Connection Issues**:
   - Verify RPC endpoint in `.env`
   - Check network connectivity
   - Ensure sufficient ETH for gas

2. **Wallet Issues**:
   - Verify master wallet private key
   - Check wallet balances
   - Ensure proper permissions

3. **Trading Issues**:
   - Check circuit breaker status
   - Verify token approvals
   - Monitor gas prices

## License

ICS

## Support

For support, please [create an issue](https://github.com/yourusername/mxtk-market-maker/issues)
