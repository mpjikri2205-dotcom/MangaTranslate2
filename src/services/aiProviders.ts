import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

export interface AIResponse {
  text: string;
}

export interface AIParams {
  model: string;
  contents: any;
  config?: any;
}

export interface AIProvider {
  generateContent: (params: AIParams) => Promise<AIResponse>;
}

export class GeminiProvider implements AIProvider {
  private client: GoogleGenAI;
  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ 
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build'
        }
      }
    });
  }
  async generateContent(params: AIParams): Promise<AIResponse> {
    try {
      const response = await this.client.models.generateContent({
        model: params.model,
        contents: params.contents,
        config: params.config
      });
      return { text: response.text || '' };
    } catch (error: any) {
      const errorStr = (error.message || '') + ' ' + (error.status || '') + ' ' + JSON.stringify(error.error || {});
      const isTransient = errorStr.includes('503') || errorStr.includes('UNAVAILABLE') || errorStr.includes('experiencing high demand') || errorStr.includes('overloaded') || errorStr.includes('Service Unavailable') || errorStr.includes('temporary');
      const isQuota = errorStr.includes('429') || errorStr.includes('quota') || errorStr.includes('Quota exceeded') || errorStr.includes('RESOURCE_EXHAUSTED') || errorStr.includes('exceeded your current quota');

      if (isTransient || isQuota) {
        // Parse retry delay from message (e.g., "Please retry in 9.961798277s.")
        let retrySeconds = 0;
        const matchSeconds = errorStr.match(/retry in\s+([0-9.]+)\s*s/i);
        if (matchSeconds && matchSeconds[1]) {
          retrySeconds = parseFloat(matchSeconds[1]);
        } else {
          const matchDelay = errorStr.match(/"retryDelay"\s*:\s*"(\d+)\s*s?"/i);
          if (matchDelay && matchDelay[1]) {
            retrySeconds = parseFloat(matchDelay[1]);
          }
        }

        // 1. First, attempt fallback to the alternate model
        const fallbackModel = params.model === 'gemini-3.5-flash' ? 'gemini-3.1-flash-lite' : 'gemini-3.5-flash';
        console.warn(`[Server AI Rate Limit/Quota] ${params.model} hit temporary limit (${retrySeconds || 'unknown'}s delay). Attempting fallback model ${fallbackModel}...`);
        
        try {
          const response = await this.client.models.generateContent({
            model: fallbackModel,
            contents: params.contents,
            config: params.config
          });
          return { text: response.text || '' };
        } catch (fallbackErr) {
          console.warn(`[Server AI] Fallback model ${fallbackModel} also hit limit.`);
        }

        // 2. If retrySeconds is reasonable (<= 12 seconds), perform a server-side backoff wait and retry once
        if (retrySeconds > 0 && retrySeconds <= 12) {
          const waitMs = Math.ceil(retrySeconds * 1000 + 500);
          console.warn(`[Server AI] Waiting ${waitMs}ms before server-side retry for ${params.model}...`);
          await new Promise(r => setTimeout(r, waitMs));
          try {
            const response = await this.client.models.generateContent({
              model: params.model,
              contents: params.contents,
              config: params.config
            });
            return { text: response.text || '' };
          } catch (retryErr) {
            console.warn(`[Server AI] Server-side retry for ${params.model} failed. Passing 429 status to client for queue controller handling.`);
          }
        }
      }

      throw error;
    }
  }
}

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL: baseURL || undefined, dangerouslyAllowBrowser: true });
  }
  async generateContent(params: AIParams): Promise<AIResponse> {
    // Convert Gemini-style contents to OpenAI-style messages
    const messages: any[] = [];
    
    // Simple conversion for the manga translation prompt
    // Usually it's { parts: [{ text: prompt }, { inlineData: { mimeType, data } }] }
    const parts = Array.isArray(params.contents) ? params.contents[0].parts : params.contents.parts;
    const textPart = parts.find((p: any) => p.text);
    const imagePart = parts.find((p: any) => p.inlineData);

    const content: any[] = [{ type: 'text', text: textPart.text }];
    if (imagePart) {
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`
        }
      });
    }

    messages.push({ role: 'user', content });

    const response = await this.client.chat.completions.create({
      model: params.model,
      messages,
      response_format: params.config?.responseMimeType === 'application/json' ? { type: 'json_object' } : undefined
    });

    return { text: response.choices[0].message.content || '' };
  }
}

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  }
  async generateContent(params: AIParams): Promise<AIResponse> {
    const parts = Array.isArray(params.contents) ? params.contents[0].parts : params.contents.parts;
    const textPart = parts.find((p: any) => p.text);
    const imagePart = parts.find((p: any) => p.inlineData);

    const content: any[] = [];
    if (imagePart) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: imagePart.inlineData.mimeType,
          data: imagePart.inlineData.data
        }
      });
    }
    content.push({ type: 'text', text: textPart.text });

    const response = await this.client.messages.create({
      model: params.model,
      max_tokens: 4096,
      messages: [{ role: 'user', content }],
      system: "You are a manga translation expert. Always return responses in valid JSON format as requested. Do not include any conversational text, only the JSON object or array."
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    
    // Extract JSON if it's wrapped in markdown code blocks
    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/) || text.match(/```\n([\s\S]*?)\n```/) || [null, text];
    return { text: jsonMatch[1] || text };
  }
}
