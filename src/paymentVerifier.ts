import { ethers } from "ethers";
import Redis from 'ioredis';

const PROCESSED_TXS_KEY = 'processed_txs';

const USDC_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function decimals() view returns (uint8)"
];

export class PaymentVerifier {
  private provider: ethers.JsonRpcProvider;
  private redis: Redis;
  private usdcContract: ethers.Contract;
  private walletAddress: string;
  private priceInUSDC: number;
  private processedTxs: Set<string>;

  constructor(
    rpcUrl: string,
    usdcContractAddress: string,
    walletAddress: string,
    priceInUSDC: number
  ) {
    this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      // If you are using a service like Upstash, the token may need to be configured here
      password: process.env.REDIS_PASSWORD,
    });

    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.usdcContract = new ethers.Contract(
      usdcContractAddress,
      USDC_ABI,
      this.provider
    );
    this.walletAddress = walletAddress.toLowerCase();
    this.priceInUSDC = priceInUSDC;
    this.processedTxs = new Set<string>();
  }

  /**
   * Creates and asynchronously initializes a PaymentVerifier instance.
   * This is the recommended way to instantiate.
   */
  public static async create(
    rpcUrl: string,
    usdcContractAddress: string,
    walletAddress: string,
    priceInUSDC: number
  ): Promise<PaymentVerifier> {
    const verifier = new PaymentVerifier(rpcUrl, usdcContractAddress, walletAddress, priceInUSDC);
    await verifier.initialize();
    return verifier;
  }

  /**
   * Loads processed transaction hashes from Redis to initialize the in-memory Set.
   */
  private async initialize(): Promise<void> {
    try {
      const txs = await this.redis.smembers(PROCESSED_TXS_KEY);
      this.processedTxs = new Set<string>(txs);
      console.log(`  📂 Loaded ${this.processedTxs.size} processed transactions from Redis.`);
    } catch (error: any) {
      console.error("  ❌ Error loading processed transactions from Redis:", error.message);
      // If the Redis connection fails, the program can still continue, but it cannot prevent transaction replay attacks.
      // You can decide whether to throw an error here to terminate the program based on your business requirements.
    }
  }

  /**
   * Saves a new transaction hash to Redis.
   */
  private async appendTxHash(txHash: string): Promise<void> {
    try {
      await this.redis.sadd(PROCESSED_TXS_KEY, txHash);
    } catch (error: any) {
      console.error(`  ❌ Error saving processed transaction to Redis:`, error.message);
    }
  }

  public async removeProcessedTx(txHash: string): Promise<void> {
    const lowerCaseTxHash = txHash.toLowerCase();

    // Remove from the in-memory Set
    if (this.processedTxs.delete(lowerCaseTxHash)) {
      console.log(`  🗑️ Removed hash from memory: ${lowerCaseTxHash}`);
      try {
        // Remove from Redis
        await this.redis.srem(PROCESSED_TXS_KEY, lowerCaseTxHash);
        console.log(`  ✓ Successfully removed hash from Redis.`);
      } catch (error: any) {
        console.error(`  ❌ Error removing hash from Redis:`, error.message);
      }
    }
  }

  /**
   * Verifies a USDC transfer transaction.
   */
  async verifyPayment(txHash: string): Promise<{
    valid: boolean;
    amount?: number;
    error?: string;
  }> {
    try {
      const lowerCaseTxHash = txHash.toLowerCase();

      // Check if this transaction has already been used
      if (this.processedTxs.has(lowerCaseTxHash)) {
        return {
          valid: false,
          error: "This transaction has already been used."
        };
      }

      console.log(`  📡 Querying transaction: ${txHash}`);

      // Get transaction receipt
      const receipt = await this.provider.getTransactionReceipt(txHash);

      if (!receipt) {
        return {
          valid: false,
          error: "Transaction not found or not yet confirmed. Please wait for block confirmation and try again."
        };
      }

      console.log(`  ✓ Transaction confirmed in block: ${receipt.blockNumber}`);

      // Check if the transaction was successful
      if (receipt.status !== 1) {
        return {
          valid: false,
          error: "Transaction failed (status: 0)."
        };
      }

      // Parse Transfer events
      let transferFound = false;
      let transferAmount = 0;

      for (const log of receipt.logs) {
        try {
          // Only parse logs from the USDC contract
          if (log.address.toLowerCase() !== this.usdcContract.target.toString().toLowerCase()) {
            continue;
          }

          const parsedLog = this.usdcContract.interface.parseLog({
            topics: log.topics as string[],
            data: log.data
          });

          if (parsedLog && parsedLog.name === "Transfer") {
            const to = parsedLog.args.to.toLowerCase();
            const value = parsedLog.args.value;

            console.log(`  🔍 Found Transfer event: to=${to.substring(0, 10)}..., value=${value}`);

            // Check if the recipient address matches
            if (to === this.walletAddress) {
              transferFound = true;
              // USDC has 6 decimals
              transferAmount = parseFloat(ethers.formatUnits(value, 6));
              console.log(`  ✓ Recipient address matched. Amount: ${transferAmount} USDC`);
              break;
            }
          }
        } catch (e) {
          // Ignore logs that cannot be parsed
          continue;
        }
      }

      if (!transferFound) {
        return {
          valid: false,
          error: `USDC transfer to address ${this.walletAddress} not found.`
        };
      }

      if (transferAmount < this.priceInUSDC) {
        return {
          valid: false,
          error: `Insufficient payment amount. Required: ${this.priceInUSDC} USDC, Paid: ${transferAmount} USDC.`,
          amount: transferAmount
        };
      }

      // Verification successful, record this transaction
      this.processedTxs.add(lowerCaseTxHash);
      await this.appendTxHash(lowerCaseTxHash);

      console.log(`  ✅ Payment verification successful! Amount: ${transferAmount} USDC`);

      return {
        valid: true,
        amount: transferAmount
      };

    } catch (error: any) {
      console.error("  ❌ Payment verification error:", error.message);
      return {
        valid: false,
        error: error.message || "An error occurred during verification."
      };
    }
  }

  /**
   * Gets the wallet address.
   */
  getWalletAddress(): string {
    return this.walletAddress;
  }

  /**
   * Clears processed transaction records (for testing purposes).
   */
  async clearProcessedTxs(): Promise<void> {
    this.processedTxs.clear();
    try {
      await this.redis.del(PROCESSED_TXS_KEY);
      console.log(`  🗑️  Cleared processed transaction records in Redis (key: ${PROCESSED_TXS_KEY})`);
    } catch (error: any) {
      console.error("  ❌ Error clearing Redis records:", error.message);
    }
  }

  /**
   * Closes the Redis connection.
   */
  public disconnect(): void {
    this.redis.disconnect();
    console.log("  🔌 Redis connection closed.");
  }

  /**
   * Gets the count of processed transactions.
   */
  getProcessedTxCount(): number {
    return this.processedTxs.size;
  }
}
