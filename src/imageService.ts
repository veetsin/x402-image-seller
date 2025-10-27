import axios from "axios";
import * as fs from "fs";
import * as path from "path";

export class ImageService {
  private apiKey: string;
  private apiUrl: string;

  constructor(apiKey: string, apiUrl: string) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
  }

  async generateImage(
    prompt: string,
    onFailure?: () => Promise<void>
  ): Promise<Buffer> {
    try {
      // 调用 Gemini API
      const response = await axios.post(
        `${this.apiUrl}?key=${this.apiKey}`,
        {
          contents: [
            {
              parts: [
                {
                  text: prompt,
                },
              ],
            },
          ],
        },
        {
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      // 解析响应获取 base64 图片数据
      const imageData = this.extractImageFromResponse(response.data);
      
      if (!imageData) {
        throw new Error("未能从响应中提取图片数据");
      }

      return imageData;
    } catch (error: any) {
      console.error("图像生成失败:", error.response?.data || error.message);
      // 如果提供了失败回调函数，则执行它
      if (onFailure) {
        await onFailure();
      }
      throw new Error("图像生成失败");
    }
  }

  private extractImageFromResponse(data: any): Buffer | null {
    try {
      if (!data) {
        console.error("响应为空或未定义:", data);
        return null;
      }

      const candidates = data.candidates || [];
      if (candidates.length === 0) {
        console.error("响应中 candidates 为空:", JSON.stringify(data, null, 2));
        return null;
      }

      for (const candidate of candidates) {
        const parts = candidate.content?.parts || [];
        for (const part of parts) {
          if (part.inlineData?.data) {
            console.log("解析图片数据成功");
            return Buffer.from(part.inlineData.data, "base64");
          }
        }
      }

      console.error("未找到图片数据，完整响应:", JSON.stringify(data, null, 2));
      return null;
    } catch (error) {
      console.error("解析图片数据失败:", error, "完整响应:", JSON.stringify(data, null, 2));
      return null;
    }
  }
}
