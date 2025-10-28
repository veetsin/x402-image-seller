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
      // 如果你使用像 Upstash 这样的服务，token 可能需要在这里配置
      password: process.env.REDIS_PASSWORD || 'your-password',
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
   * 创建并异步初始化 PaymentVerifier 实例。
   * 这是推荐的实例化方式。
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
   * 从 Redis 加载已处理的交易哈希来初始化内存中的 Set。
   */
  private async initialize(): Promise<void> {
    try {
      const txs = await this.redis.smembers(PROCESSED_TXS_KEY);
      this.processedTxs = new Set<string>(txs);
      console.log(`  📂 已从 Redis 加载 ${this.processedTxs.size} 个已处理的交易。`);
    } catch (error: any) {
      console.error("  ❌ 从 Redis 加载已处理交易时出错:", error.message);
      // 在 Redis 连接失败时，程序仍可继续运行，但无法防止交易重放
      // 你可以根据业务需求决定是否在此处抛出错误以终止程序
    }
  }

  /**
   * 将新的交易哈希保存到 Redis
   */
  private async appendTxHash(txHash: string): Promise<void> {
    try {
      await this.redis.sadd(PROCESSED_TXS_KEY, txHash);
    } catch (error: any) {
      console.error(`  ❌ 保存已处理交易至 Redis 时出错:`, error.message);
    }
  }

  /**
   * 从已处理列表中移除一个交易哈希（用于失败回滚）。
   * @param txHash 要移除的交易哈希。
   */
  public async removeProcessedTx(txHash: string): Promise<void> {
    const lowerCaseTxHash = txHash.toLowerCase();

    // 从内存 Set 中移除
    if (this.processedTxs.delete(lowerCaseTxHash)) {
      console.log(`  🗑️ 从内存中移除哈希: ${lowerCaseTxHash}`);
      try {
        // 从 Redis 中移除
        await this.redis.srem(PROCESSED_TXS_KEY, lowerCaseTxHash);
        console.log(`  ✓ 成功从 Redis 中移除哈希。`);
      } catch (error: any) {
        console.error(`  ❌ 从 Redis 移除哈希时出错:`, error.message);
      }
    }
  }

  /**
   * 验证 USDC 转账交易
   */
  async verifyPayment(txHash: string): Promise<{
    valid: boolean;
    amount?: number;
    error?: string;
  }> {
    try {
      const lowerCaseTxHash = txHash.toLowerCase();

      // 检查是否已经使用过此交易
      if (this.processedTxs.has(lowerCaseTxHash)) {
        return {
          valid: false,
          error: "此交易已被使用"
        };
      }

      console.log(`  📡 查询交易: ${txHash}`);

      // 获取交易收据
      const receipt = await this.provider.getTransactionReceipt(txHash);

      if (!receipt) {
        return {
          valid: false,
          error: "交易未找到或未确认，请等待区块确认后重试"
        };
      }

      console.log(`  ✓ 交易已确认，区块号: ${receipt.blockNumber}`);

      // 检查交易是否成功
      if (receipt.status !== 1) {
        return {
          valid: false,
          error: "交易失败（status: 0）"
        };
      }

      // 解析 Transfer 事件
      let transferFound = false;
      let transferAmount = 0;

      for (const log of receipt.logs) {
        try {
          // 只解析 USDC 合约的日志
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

            console.log(`  🔍 发现 Transfer 事件: to=${to.substring(0, 10)}..., value=${value}`);

            // 检查接收地址是否匹配
            if (to === this.walletAddress) {
              transferFound = true;
              // USDC 有 6 位小数
              transferAmount = parseFloat(ethers.formatUnits(value, 6));
              console.log(`  ✓ 接收地址匹配，金额: ${transferAmount} USDC`);
              break;
            }
          }
        } catch (e) {
          // 忽略无法解析的日志
          continue;
        }
      }

      if (!transferFound) {
        return {
          valid: false,
          error: `未找到向地址 ${this.walletAddress} 的 USDC 转账`
        };
      }

      if (transferAmount < this.priceInUSDC) {
        return {
          valid: false,
          amount: transferAmount,
          error: `支付金额不足。需要 ${this.priceInUSDC} USDC，实际 ${transferAmount} USDC`
        };
      }

      // 验证成功，记录此交易
      this.processedTxs.add(lowerCaseTxHash);
      await this.appendTxHash(lowerCaseTxHash);

      console.log(`  ✅ 支付验证成功！金额: ${transferAmount} USDC`);

      return {
        valid: true,
        amount: transferAmount
      };

    } catch (error: any) {
      console.error("  ❌ 支付验证错误:", error.message);
      return {
        valid: false,
        error: error.message || "验证过程中发生错误"
      };
    }
  }

  /**
   * 获取钱包地址
   */
  getWalletAddress(): string {
    return this.walletAddress;
  }

  /**
   * 清理已处理交易记录（用于测试）
   */
  async clearProcessedTxs(): Promise<void> {
    this.processedTxs.clear();
    try {
      await this.redis.del(PROCESSED_TXS_KEY);
      console.log(`  🗑️  已清理 Redis 中的已处理交易记录 (key: ${PROCESSED_TXS_KEY})`);
    } catch (error: any) {
      console.error("  ❌ 清理 Redis 记录时出错:", error.message);
    }
  }

  /**
   * 关闭 Redis 连接
   */
  public disconnect(): void {
    this.redis.disconnect();
    console.log("  🔌 Redis 连接已关闭。");
  }

  /**
   * 获取已处理交易数量
   */
  getProcessedTxCount(): number {
    return this.processedTxs.size;
  }
}
