import express, { Request, Response, NextFunction } from "express";
import { ImageService } from "./imageService";
import { PaymentVerifier } from "./paymentVerifier";
import dotenv from "dotenv";
import path from "path";

dotenv.config();

const app = express();
app.use(express.json());
// 为静态文件提供服务
app.use(express.static(path.join(__dirname, 'public')));

let walletAddress: string;
let imageService: ImageService;
let paymentVerifier: PaymentVerifier;

// 初始化服务
async function initializeServices() {
    try {
        // 从环境变量获取钱包地址
        walletAddress = process.env.WALLET_ADDRESS!;

        if (!walletAddress) {
            throw new Error("请在 .env 中设置 WALLET_ADDRESS");
        }

        // 验证地址格式
        if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
            throw new Error("钱包地址格式无效,应为 0x 开头的 40 位十六进制字符");
        }

        // 初始化支付验证器
        paymentVerifier = await PaymentVerifier.create(
            process.env.BASE_RPC_URL!,
            process.env.USDC_CONTRACT_ADDRESS!,
            walletAddress,
            parseFloat(process.env.PRICE_IN_USDC || "0.1")
        );

        // 初始化图像服务
        imageService = new ImageService(
            process.env.GEMINI_API_KEY_X402!,
            process.env.GEMINI_API_URL!
        );

        console.log("✅ [DEBUG] Gemini API Key being used:", process.env.GEMINI_API_KEY_X402);
        console.log(`\n=== X402 服务配置 ===`);
        console.log(`收款地址: ${walletAddress}`);
        console.log(`服务价格: ${process.env.PRICE_IN_USDC} USDC`);
        console.log(`网络: ${process.env.NETWORK_ID}`);
        console.log(`USDC 合约: ${process.env.USDC_CONTRACT_ADDRESS}`);
        console.log(`RPC URL: ${process.env.BASE_RPC_URL}`);

    } catch (error) {
        console.error("❌ 服务初始化失败:", error);
        process.exit(1);
    }
}

// 支付验证中间件 (轻量版)
function paymentMiddleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            // 从 header 或 body 获取交易哈希
            const paymentTxHash =
                (req.headers['x-payment-tx'] as string) ||
                (req.body && req.body.tx);

            if (!paymentTxHash) {
                return res.status(402).json({
                    error: "Payment Required",
                    message: "需要提供支付交易哈希 (X-Payment-Tx header 或 body.tx)",
                    priceInUSDC: process.env.PRICE_IN_USDC,
                    networkId: process.env.NETWORK_ID,
                    walletAddress: walletAddress,
                    usdcContract: process.env.USDC_CONTRACT_ADDRESS
                });
            }

            // 验证哈希格式
            const txHashRegex = /^0x[a-fA-F0-9]{64}$/;
            if (!txHashRegex.test(paymentTxHash)) {
                return res.status(402).json({
                    error: "Invalid Transaction Hash",
                    message: '交易哈希格式无效,必须是以 "0x" 开头的 66 位十六进制字符串',
                    providedTxHash: paymentTxHash
                });
            }

            // 验证支付
            console.log(`🔍 验证支付交易: ${paymentTxHash}`);
            const verification = await paymentVerifier.verifyPayment(paymentTxHash);

            if (!verification.valid) {
                return res.status(402).json({
                    error: "Payment Invalid",
                    message: verification.error || "支付验证失败",
                    amount: verification.amount,
                    providedTxHash: paymentTxHash,
                });
            }

            // 支付验证成功
            console.log(`✅ 支付验证成功: ${paymentTxHash}, 金额: ${verification.amount} USDC`);

            (req as any).payment = {
                txHash: paymentTxHash,
                amount: verification.amount,
                verified: true
            };

            next();

        } catch (error: any) {
            console.error("❌ 支付验证错误:", error);
            res.status(500).json({
                error: "Payment Verification Failed",
                message: error.message
            });
        }
    };
}

// ========== 路由定义 ==========

// 根路由 - 服务信息
app.get("/", (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// GET /generate - 返回支付页面
app.get("/generate", (req: Request, res: Response) => {
    // 检查请求来源
    const acceptHeader = req.get('Accept') || '';
    const userAgent = req.get('User-Agent') || '';

    // 判断是否为浏览器请求
    const isBrowserRequest = acceptHeader.includes('text/html') ||
        userAgent.includes('Mozilla') ||
        userAgent.includes('Chrome') ||
        userAgent.includes('Safari');

    if (isBrowserRequest) {
        // 浏览器请求 - 返回 HTML 页面
        return res.sendFile(path.join(__dirname, "public", "generate.html"), (err) => {
            if (err) {
                console.error("sendFile 错误:", err);
                res.status(500).send("<h1>Internal Server Error</h1>");
            }
        });
    }

    // API 请求 - 返回服务信息
    res.json({
        service: "X402 Nano Banana - AI Image Generator",
        endpoint: "/generate",
        method: "POST",
        price: `${process.env.PRICE_IN_USDC || "0.1"} USDC`,
        network: process.env.NETWORK_ID || "base-sepolia",
        usdcContract: process.env.USDC_CONTRACT_ADDRESS,
        walletAddress: walletAddress,
        description: "Generate AI images by POSTing a prompt with payment proof"
    });
});

// POST /generate - 图像生成端点 (需要支付验证)
app.post(
    "/generate",
    paymentMiddleware(),
    async (req: Request, res: Response) => {
        try {
            const { prompt } = req.body;

            if (!prompt) {
                return res.status(400).json({
                    error: "Missing Parameter",
                    message: "请求体中缺少 'prompt' 字段"
                });
            }

            const txHash = (req as any).payment?.txHash;
            console.log(`🎨 生成图像, 提示词: ${prompt}, 交易: ${txHash}`);

            // 定义失败时的清理操作
            const cleanupOnFailure = async () => {
                console.log(`图像生成失败，正在为 txHash: ${txHash} 执行回滚...`);
                await paymentVerifier.removeProcessedTx(txHash);
            };

            // 调用图像服务生成图像
            const imageBuffer = await imageService.generateImage(prompt, cleanupOnFailure);

            // 返回图像
            res.setHeader("Content-Type", "image/png");
            res.setHeader("Content-Disposition", "inline; filename=generated-image.png");
            res.send(imageBuffer);

            console.log(`✅ 图像生成成功`);
        } catch (error: any) {
            console.error("❌ 图像生成失败:", error);
            res.status(500).json({
                error: "Image Generation Failed",
                message: "图像生成失败，你的支付凭证已回滚，请使用相同的交易哈希重试。"
            });
        }
    }
);

// 向客户端提供支付配置信息
app.get("/payment-info", (req: Request, res: Response) => {
    res.json({
        priceInUSDC: process.env.PRICE_IN_USDC || "0.1",
        networkId: process.env.NETWORK_ID || "base-sepolia",
        walletAddress: walletAddress,
        usdcContract: process.env.USDC_CONTRACT_ADDRESS
    });
});

// 健康检查端点
app.get("/health", (req: Request, res: Response) => {
    res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        wallet: walletAddress,
        network: process.env.NETWORK_ID || "base-sepolia",
        uptime: process.uptime()
    });
});

// 404 处理
app.use((req: Request, res: Response) => {
    res.status(404).json({
        error: "Not Found",
        message: "请求的端点不存在",
        availableEndpoints: {
            info: "GET /",
            generate: "GET /generate (HTML页面) 或 POST /generate (生成图像)",
            health: "GET /health",
            paymentInfo: "GET /payment-info"
        }
    });
});

// 启动服务器
const PORT = process.env.PORT || 3000;

initializeServices().then(() => {
    app.listen(PORT, () => {
        console.log(`\n🚀 X402 Seller 服务已启动,运行在端口 ${PORT}`);
        console.log(`🎨 访问 http://localhost:${PORT}/generate 查看支付页面`);
        console.log(`💰 收款地址: ${walletAddress}\n`);
    });
}).catch((error) => {
    console.error("❌ 服务启动失败:", error);
    process.exit(1);
});