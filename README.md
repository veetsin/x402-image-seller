# X402 Image Seller

An AI-powered image generation service implementing the [X402 Payment Protocol](https://402.foundation/) on the Base blockchain. This service allows users to pay with USDC to generate AI images using Google's Gemini AI.
[click to view](https://x402-image.onrender.com/)

## Features

- 🎨 **AI Image Generation** - Powered by Google Gemini
- 💰 **Cryptocurrency Payments** - Accept USDC payments via X402 protocol
- 🔒 **Blockchain Verification** - Automatic payment verification on Base network
- 🚀 **X402 Protocol Compliant** - Full support for X402 payment standards
- 📱 **Web Interface** - User-friendly HTML interface for image generation
- 🔄 **Duplicate Prevention** - Prevents reuse of payment transactions

## Tech Stack

- **Runtime**: Node.js (≥18.0.0)
- **Language**: TypeScript
- **Framework**: Express.js
- **Blockchain**: Ethereum / Base Network
- **Blockchain Library**: ethers.js v6
- **Payment SDK**: @coinbase/cdp-sdk
- **AI**: Google Gemini API
- **Build Tool**: TypeScript Compiler

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/x402-image-seller.git
cd x402-image-seller
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file from the template:
```bash
cp .env.example .env
```

4. Configure your environment variables in `.env`:
   - Set your `WALLET_ADDRESS` for receiving payments
   - Configure your `GEMINI_API_KEY_X402` for image generation
   - Adjust `PRICE_IN_USDC` if needed (default: 0.1 USDC)
   - Configure network settings

5. Build the project:
```bash
npm run build
```

## Usage

### Development Mode

```bash
npm run dev
```

The server will start on `http://localhost:3000`

### Production Mode

```bash
npm start
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `WALLET_ADDRESS` | Your Base network wallet to receive payments | Yes |
| `BASE_RPC_URL` | RPC endpoint for Base network | Yes |
| `USDC_CONTRACT_ADDRESS` | USDC token contract on Base | Yes |
| `NETWORK_ID` | Network identifier (base/sepolia) | Yes |
| `PRICE_IN_USDC` | Price per image generation in USDC | Yes |
| `GEMINI_API_KEY_X402` | Google Gemini API key | Yes |
| `GEMINI_API_URL` | Gemini API endpoint | Yes |
| `PORT` | Server port (default: 3000) | No |
| `STORAGE_DIR` | Directory for persistent storage | No |

## API Endpoints

### `GET /`
Service information page.

### `GET /generate`
Displays the image generation web interface.

### `POST /generate`
Generates an AI image. Requires X402 payment.

**Request Headers:**
- `X-402-Payment-Tx`: Transaction hash of USDC payment
- `Content-Type`: `application/json`

**Request Body:**
```json
{
  "prompt": "A beautiful sunset over mountains"
}
```

**Response:**
- Content-Type: `image/png`
- Returns the generated image as PNG buffer

### `GET /payment-info`
Returns current payment configuration.

**Response:**
```json
{
  "priceInUSDC": "0.1",
  "networkId": "base",
  "walletAddress": "0x..."
}
```

### `GET /health`
Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "wallet": "0x...",
  "network": "base",
  "uptime": 3600
}
```

## X402 Payment Flow

1. User requests image generation via `/generate`
2. Service returns 402 Payment Required with payment details
3. User submits USDC payment to specified wallet
4. User includes payment transaction hash in subsequent request
5. Service verifies payment on-chain
6. Service generates and returns AI image

## Payment Verification

The service automatically verifies USDC transfers on the Base network by:
- Checking transaction receipt status
- Parsing Transfer events from USDC contract
- Verifying payment amount meets minimum requirement
- Preventing duplicate transaction reuse

## Deployment

### Render.com

1. Connect your GitHub repository to Render
2. Set environment variables in the Render dashboard
3. Set build command: `npm run build`
4. Set start command: `npm start`
5. Set storage directory: Use Render's persistent disk at `/data` and set `STORAGE_DIR=/data`

### Vercel / Railway

Similar process - configure environment variables and deploy as Node.js service.

## Project Structure

```
x402-image-seller/
├── src/
│   ├── server.ts           # Main Express server
│   ├── paymentVerifier.ts  # Payment verification logic
│   ├── imageService.ts     # Gemini AI integration
│   ├── public/
│   │   └── generate.html   # Web interface
│   └── index.html          # Info page
├── dist/                   # Compiled JavaScript (gitignored)
├── .env.example            # Environment template
├── tsconfig.json           # TypeScript config
└── package.json            # Dependencies
```

## Scripts

- `npm run dev` - Start development server with ts-node
- `npm run build` - Compile TypeScript to JavaScript
- `npm start` - Start production server
- `npm run clean` - Remove build directory

## Requirements

- Node.js ≥18.0.0
- npm ≥9.0.0
- Base network USDC for payments
- Gemini API key

## License

MIT

## Author

Veetsin

## Acknowledgments

- [402 Foundation](https://402.foundation/) for the X402 protocol
- Google Gemini for AI image generation
- Base ecosystem for blockchain infrastructure
