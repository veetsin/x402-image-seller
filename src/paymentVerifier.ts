import { ethers } from "ethers";
import * as fs from 'fs';
import * as path from 'path';



const USDC_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function decimals() view returns (uint8)"
];

export class PaymentVerifier {
  private provider: ethers.JsonRpcProvider;
  private usdcContract: ethers.Contract;
  private walletAddress: string;
  private priceInUSDC: number;
  private processedTxs: Set<string>;
  private txsFilePath: string;

  constructor(
    rpcUrl: string,
    usdcContractAddress: string,
    walletAddress: string,
    priceInUSDC: number
  ) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.usdcContract = new ethers.Contract(
      usdcContractAddress,
      USDC_ABI,
      this.provider
    );
    this.walletAddress = walletAddress.toLowerCase();
    this.priceInUSDC = priceInUSDC;
    this.processedTxs = new Set<string>();
    
    // 确定存储路径。在 Render 上，应将 STORAGE_DIR 环境变量设置为持久化磁盘的挂载路径（例如 /data）。
    // 如果环境变量未设置，则默认为当前工作目录，适用于本地开发。
    const storageDirectory = process.env.STORAGE_DIR || process.cwd();
    this.txsFilePath = path.join(storageDirectory, 'processed_txs.txt');

    // 确保目录存在 (主要用于本地开发，Render 的挂载点会自动存在)
    const dir = path.dirname(this.txsFilePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    
    this.loadProcessedTxs();
  }

  /**
   * 从文件中加载已处理的交易哈希
   */
  private loadProcessedTxs(): void {
    try {
      if (fs.existsSync(this.txsFilePath)) {
        const data = fs.readFileSync(this.txsFilePath, 'utf8');
        const txs = data.split('\n').filter(tx => tx.length > 0);
        this.processedTxs = new Set<string>(txs);
        console.log(`  📂 已从 ${this.txsFilePath} 加载 ${this.processedTxs.size} 个已处理的交易。`);
      } else {
        console.log(`  📂 未找到交易记录文件 ${this.txsFilePath}，将在需要时创建新文件。`);
      }
    } catch (error: any) {
      console.error("  ❌ 加载已处理交易时出错:", error.message);
    }
  }

  /**
   * 将新的交易哈希追加到文件
   */
  private async appendTxHash(txHash: string): Promise<void> {
    try {
      await fs.promises.appendFile(this.txsFilePath, `${txHash}\n`);
    } catch (error: any) {
      console.error(`  ❌ 保存已处理交易至 ${this.txsFilePath} 时出错:`, error.message);
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
      console.log(`从内存中移除哈希: ${lowerCaseTxHash}`);
      try {
        // 从文件中移除
        const data = await fs.promises.readFile(this.txsFilePath, 'utf8');
        const txs = data.split('\n').filter(tx => tx.toLowerCase() !== lowerCaseTxHash);
        await fs.promises.writeFile(this.txsFilePath, txs.join('\n'));
        console.log(`成功从文件 ${this.txsFilePath} 中移除哈希。`);
      } catch (error: any) {
        console.error(`  ❌ 从文件 ${this.txsFilePath} 移除哈希时出错:`, error.message);
        // 即使文件操作失败，内存中的记录也已移除，下次服务重启时会从文件重新加载。
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
      if (fs.existsSync(this.txsFilePath)) {
        await fs.promises.writeFile(this.txsFilePath, '');
      }
      console.log(`  🗑️  已清理处理记录（包括文件 ${this.txsFilePath}）`);
    } catch (error: any) {
      console.error("  ❌ 清理已处理交易文件时出错:", error.message);
    }
  }

  /**
   * 获取已处理交易数量
   */
  getProcessedTxCount(): number {
    return this.processedTxs.size;
  }
}
