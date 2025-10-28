import express, { Request, Response, NextFunction } from "express";
import { ImageService } from "./imageService";
import { PaymentVerifier } from "./paymentVerifier";
import dotenv from "dotenv";
import path from "path";

dotenv.config();

const app = express();
app.use(express.json());
// 为 generate.html 提供静态文件服务
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

// X402 Payment Middleware
function paymentMiddleware(priceInUSDC: string) {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            // 优先从 header 获取 (API), 其次从 body (POST), 最后从 query (GET)
            const paymentTxHash =
                (req.headers['x-402-payment-tx'] as string) ||
                (req.body && req.body.tx) ||
                (req.query.tx as string);

            // 如果没有支付信息,返回 402 或 HTML 页面
            if (!paymentTxHash) {
                // *** 内容协商 ***
                // 如果客户端(如浏览器)接受 HTML,则显示 UI 页面
                if (req.accepts('html')) {
                    // 直接发送 HTML 文件并结束响应
                    return res.sendFile(path.join(__dirname, "public", "generate.html"));
                }

                // 对于 API 客户端(如 X402 平台),返回 402 JSON
                const amountInSmallestUnit = (parseFloat(priceInUSDC) * 1e6).toString();

                // 402 响应中的资源 URL 应指向 API 端点
                // 动态构建 resourceUrl,保留原始查询参数(除了 'tx')
                const queryParams = new URLSearchParams(req.query as Record<string, string>);
                queryParams.delete('tx');
                const queryString = queryParams.toString();
                const resourceUrl = `${req.protocol}://${req.get('host')}${req.path}?${queryString ? queryString + '&' : ''}tx={txHash}`;

                return res.status(402).json({
                    x402Version: 1,
                    error: "X-PAYMENT header is required",
                    accepts: [
                        {
                            scheme: "exact",
                            network: process.env.NETWORK_ID,
                            maxAmountRequired: amountInSmallestUnit,
                            resource: resourceUrl,
                            description: `X402 AI Image Generation Service. Price: ${priceInUSDC} USDC.`,
                            mimeType: "image/png",
                            payTo: walletAddress,
                            maxTimeoutSeconds: 60,
                            asset: process.env.USDC_CONTRACT_ADDRESS,
                            extra: {
                                name: "USD Coin",
                                version: "2"
                            },
                            outputSchema: {
                                input: {
                                    type: "http",
                                    method: req.method, // 动态使用当前请求的方法 (GET 或 POST)
                                    discoverable: true
                                },
                                output: {
                                    type: "image/png"
                                }
                            }
                        }
                    ]
                });
            }

            // 在调用 RPC 之前,先在后端验证哈希格式
            const txHashRegex = /^0x[a-fA-F0-9]{64}$/;
            if (!txHashRegex.test(paymentTxHash)) {
                console.log(`❌ 交易哈希格式无效: ${paymentTxHash}`);
                return res.status(402).json({
                    error: "Payment Invalid",
                    message: '交易哈希格式无效,必须是以 "0x" 开头的 66 位十六进制字符串。',
                    providedTxHash: paymentTxHash
                });
            }

            // 验证支付
            console.log(`🔍 验证支付交易: ${paymentTxHash}`);

            const verification = await paymentVerifier.verifyPayment(paymentTxHash);

            if (!verification.valid) {
                res.setHeader('X-402-Accept-Payment', 'base-usdc');
                res.setHeader('X-402-Price', priceInUSDC);
                res.setHeader('X-402-Wallet-Address', walletAddress);

                return res.status(402).json({
                    error: "Payment Invalid",
                    message: verification.error || "支付验证失败",
                    amount: verification.amount,
                    providedTxHash: paymentTxHash,
                    data: [] // 关键: 在API响应层添加空数组以适配前端
                });
            }

            // 支付验证成功
            console.log(`✅ 支付验证成功: ${paymentTxHash}, 金额: ${verification.amount} USDC`);
            res.setHeader('X-402-Payment-Verified', 'true');

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

// 主图像生成端点 - GET 请求用于显示 HTML 页面(不需要支付)
app.get("/generate", (req: Request, res: Response) => {
    // 检查请求来源：浏览器 vs API 客户端
    const acceptHeader = req.get('Accept') || '';
    const userAgent = req.get('User-Agent') || '';

    // 判断是否为浏览器请求
    const isBrowserRequest = acceptHeader.includes('text/html') ||
        userAgent.includes('Mozilla') ||
        userAgent.includes('Chrome') ||
        userAgent.includes('Safari');

    if (isBrowserRequest) {
        // 浏览器请求 - 返回 HTML 页面
        res.status(402);
        return res.sendFile(path.join(__dirname, "public", "generate.html"), (err) => {
            if (err) {
                console.error("sendFile 错误:", err);
                res.send("<h1>Payment Required</h1>");
            }
        });
    }

    // API 请求 - 返回 X402 协议 JSON
    const priceInUSDC = process.env.PRICE_IN_USDC || "0.1";
    const amountInSmallestUnit = (parseFloat(priceInUSDC) * 1e6).toString();

    // 动态构建 resource URL
    const protocol = req.protocol;
    const host = req.get('host');
    const resourceUrl = `${protocol}://${host}/generate`;

    res.status(402).json({
        x402Version: 1,
        accepts: [{
            scheme: "exact",
            network: process.env.NETWORK_ID || "base",
            maxAmountRequired: amountInSmallestUnit,
            resource: resourceUrl,
            description: "X402 Nano Banana - Pay with crypto to generate images with Nano Banana",
            mimeType: "image/png",
            payTo: walletAddress,
            maxTimeoutSeconds: 3600,
            asset: process.env.USDC_CONTRACT_ADDRESS || "USDC",

            outputSchema: {
                input: {
                    type: "http",
                    method: "POST",
                    bodyType: "json",
                    bodyFields: {
                        tx: {
                            type: "string",
                            description: "Payment transaction hash",
                            required: true,
                            pattern: "^0x[a-fA-F0-9]{64}$"
                        },
                        prompt: {
                            type: "string",
                            description: "Image generation prompt",
                            required: true,
                            minLength: 1,
                            maxLength: 1000
                        }
                    }
                },
                output: {
                    type: "binary",
                    contentType: "image/png",
                    description: "Generated image in PNG format"
                }
            },

            extra: {
                apiVersion: "1.0",
                provider: "X402 Nano Banana",
                supportedModels: ["gemini-2.5-flash-image"],
                imageSize: "1024x1024"
            }
        }]
    });
});

// POST 请求用于实际生成图像(需要支付验证)
app.post(
    "/generate",
    paymentMiddleware(process.env.PRICE_IN_USDC || "0.1"),
    async (req: Request, res: Response) => {
        try {
            const { prompt } = req.body; // 从请求体中获取 prompt

            if (!prompt) {
                return res.status(400).json({
                    error: "Missing Parameter",
                    message: "请求体中缺少 'prompt' 字段"
                });
            }

            // 从 paymentMiddleware 注入的 req.payment 中获取 txHash
            const txHash = (req as any).payment?.txHash;
            if (!txHash) {
                // 这是一个安全检查，理论上 paymentMiddleware 会保证 txHash 存在
                console.error("❌ 严重错误: 支付验证通过但未找到交易哈希!");
                return res.status(500).json({ error: "Internal Server Error", message: "无法在请求中找到交易凭证" });
            }

            console.log(`🎨 [POST] 生成图像, 提示词: ${prompt}, 交易: ${txHash}`);

            // 定义失败时的清理操作
            const cleanupOnFailure = async () => {
                console.log(`图像生成失败，正在为 txHash: ${txHash} 执行回滚...`);
                await paymentVerifier.removeProcessedTx(txHash);
            };

            // 调用 generateImage 并传入清理函数
            const imageBuffer = await imageService.generateImage(prompt, cleanupOnFailure);

            res.setHeader("Content-Type", "image/png");
            res.send(imageBuffer);
            console.log(`✅ [POST] 图像生成成功`);
        } catch (error: any) {
            console.error("❌ [POST] 图像生成失败:", error);
            // 返回一个更友好的错误信息，告知用户可以重试
            res.status(500).json({ error: "Image Generation Failed", message: "图像生成失败，你的支付凭证已回滚，请使用相同的交易哈希重试。" });
        }
    }
);

// 新增:向客户端 JS 提供支付信息的端点
app.get("/payment-info", (req: Request, res: Response) => {
    res.json({
        priceInUSDC: process.env.PRICE_IN_USDC || "0.1",
        networkId: process.env.NETWORK_ID,
        walletAddress: walletAddress,
    });
});

// 健康检查端点
app.get("/health", (req: Request, res: Response) => {
    res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        wallet: walletAddress,
        network: process.env.NETWORK_ID,
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
        console.log(`🎨 访问 http://localhost:${PORT}/generate 查看表单页面`);
        console.log(`💰 收款地址: ${walletAddress}\n`);
    });
}).catch((error) => {
    console.error("❌ 服务启动失败:", error);
    process.exit(1);
});