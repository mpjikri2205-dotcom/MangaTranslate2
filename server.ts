import "dotenv/config";
import { Agent, setGlobalDispatcher } from "undici";

// Configure undici global dispatcher to prevent HeadersTimeoutError (default is 30s)
setGlobalDispatcher(
  new Agent({
    connect: {
      timeout: 120000, // 120s connection timeout
    },
    headersTimeout: 180000, // 180s headers timeout
    bodyTimeout: 180000,    // 180s body timeout
  })
);

import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import https from "https";
import { GeminiProvider, OpenAIProvider, AnthropicProvider, AIProvider } from "./src/services/aiProviders.js";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  // Temporary file storage map for sandbox-bypassing secure downloads
  const tempFiles = new Map<string, { base64: string, mimeType: string, filename: string }>();

  // Chunked upload trackers to completely bypass reverse proxy/nginx body constraints
  const activeUploads = new Map<string, { chunks: string[], mimeType: string, filename: string }>();

  app.post("/api/download-chunk/start", (req, res) => {
    const { mimeType, filename } = req.body;
    if (!mimeType || !filename) {
      return res.status(400).json({ error: "Missing mimeType or filename" });
    }
    const uploadId = Math.random().toString(36).substr(2, 15);
    activeUploads.set(uploadId, { chunks: [], mimeType, filename });
    res.json({ uploadId });
  });

  app.post("/api/download-chunk/upload", (req, res) => {
    const { uploadId, chunkIndex, chunkBase64 } = req.body;
    if (!uploadId || typeof chunkIndex !== 'number' || !chunkBase64) {
      return res.status(400).json({ error: "Missing uploadId, chunkIndex, or chunkBase64" });
    }
    const upload = activeUploads.get(uploadId);
    if (!upload) {
      return res.status(404).json({ error: "Upload session expired or not found" });
    }
    upload.chunks[chunkIndex] = chunkBase64;
    res.json({ success: true });
  });

  app.post("/api/download-chunk/complete", (req, res) => {
    const { uploadId } = req.body;
    if (!uploadId) {
      return res.status(400).json({ error: "Missing uploadId" });
    }
    const upload = activeUploads.get(uploadId);
    if (!upload) {
      return res.status(404).json({ error: "Upload session expired or not found" });
    }
    
    // Assemble chunks
    const base64 = upload.chunks.join('');
    activeUploads.delete(uploadId);

    const token = Math.random().toString(36).substr(2, 15);
    tempFiles.set(token, { base64, mimeType: upload.mimeType, filename: upload.filename });
    
    // Automatically delete after 10 minutes to release RAM
    setTimeout(() => {
      tempFiles.delete(token);
    }, 10 * 60 * 1000);

    res.json({ token, downloadUrl: `/api/download/${token}` });
  });

  app.post("/api/download-temp", (req, res) => {
    const { base64, mimeType, filename } = req.body;
    if (!base64 || !mimeType || !filename) {
      return res.status(400).json({ error: "Missing base64, mimeType, or filename" });
    }
    const token = Math.random().toString(36).substr(2, 15);
    tempFiles.set(token, { base64, mimeType, filename });
    
    // Automatically delete after 10 minutes to release RAM
    setTimeout(() => {
      tempFiles.delete(token);
    }, 10 * 60 * 1000);

    res.json({ token, downloadUrl: `/api/download/${token}` });
  });

  app.get("/api/download/:token", (req, res) => {
    const { token } = req.params;
    const fileData = tempFiles.get(token);
    if (!fileData) {
      return res.status(404).send(`
        <html>
          <head>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #FAF9F6; margin: 0; color: #1A1A1A; }
              .card { background: white; padding: 2.5rem; border-radius: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.05); text-align: center; max-width: 400px; border: 1px border #E5E5E5; }
              h1 { font-size: 1.25rem; margin-bottom: 0.5rem; font-weight: 700; }
              p { font-size: 0.85rem; color: #666; line-height: 1.5; margin-bottom: 1.5rem; }
              button { background: black; color: white; border: none; padding: 0.75rem 1.5rem; font-size: 0.85rem; font-weight: 600; border-radius: 12px; cursor: pointer; }
            </style>
          </head>
          <body>
            <div class="card">
              <h1>File Expired or Not Found</h1>
              <p>Masa berlaku file unduhan sementara telah habis (10 menit) atau server di-restart. Silakan lakukan ekspor ulang dari aplikasi.</p>
              <button onclick="window.close()">Tutup Halaman</button>
            </div>
          </body>
        </html>
      `);
    }
    
    // Convert base64 back to binary Buffer
    const buffer = Buffer.from(fileData.base64, 'base64');
    
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileData.filename)}"`);
    res.setHeader('Content-Type', fileData.mimeType);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  });

  // Helper for Free Translation API with sequential multi-engine fallback to guarantee local/offline mode translations succeed
  const detectLanguageFromText = (text: string): string => {
    if (/[\uAC00-\uD7AF]/.test(text)) return 'ko';
    if (/[\u4E00-\u9FAF]/.test(text)) {
      if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return 'ja';
      return 'zh';
    }
    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return 'ja';
    if (/[a-zA-Z]{3,}/.test(text)) return 'en';
    return 'ja'; // default fallback for manga content
  };

  const fetchGoogleTranslate = (url: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const req = https.get(url, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          try {
            if (response.statusCode && response.statusCode >= 400) {
              reject(new Error(`Status ${response.statusCode}`));
              return;
            }
            const parsed = JSON.parse(data);
            if (parsed && parsed[0]) {
              const translated = parsed[0].map((item: any) => item[0]).join('');
              resolve(translated);
            } else {
              reject(new Error('Invalid format'));
            }
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  };

  const fetchGoogleTranslateChrome = (url: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const req = https.get(url, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          try {
            if (response.statusCode && response.statusCode >= 400) {
              reject(new Error(`Status ${response.statusCode}`));
              return;
            }
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed)) {
              if (Array.isArray(parsed[0])) {
                const translated = parsed[0].map((item: any) => item[0] || item).join('');
                resolve(translated);
              } else if (typeof parsed[0] === 'string') {
                resolve(parsed.join(''));
              } else {
                reject(new Error('Invalid array format'));
              }
            } else if (parsed && typeof parsed === 'object') {
              if (parsed.sentences && Array.isArray(parsed.sentences)) {
                const translated = parsed.sentences.map((s: any) => s.trans).join('');
                resolve(translated);
              } else if (parsed.translatedText) {
                resolve(parsed.translatedText);
              } else {
                reject(new Error('Invalid object format'));
              }
            } else {
              reject(new Error('Unknown format'));
            }
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  };

  const fetchMyMemory = (url: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const req = https.get(url, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          try {
            if (response.statusCode && response.statusCode >= 400) {
              reject(new Error(`Status ${response.statusCode}`));
              return;
            }
            const parsed = JSON.parse(data);
            if (parsed && parsed.responseData && parsed.responseData.translatedText) {
              resolve(parsed.responseData.translatedText);
            } else {
              reject(new Error('Invalid MyMemory response'));
            }
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
  };

  const getFreeTranslation = async (text: string, from: string = 'auto', to: string = 'id'): Promise<string> => {
    let detectedFrom = from;
    if (from === 'auto') {
      detectedFrom = detectLanguageFromText(text);
    }

    const methods = [
      // Method 1: Google Translate Single with client=gtx
      async () => {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
        return fetchGoogleTranslate(url);
      },
      // Method 2: Google Translate with client=dict-chrome-ex (highly robust, bypasses common Cloud Run blocks)
      async () => {
        const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&q=${encodeURIComponent(text)}`;
        return fetchGoogleTranslateChrome(url);
      },
      // Method 3: MyMemory Translation API (completely independent of Google server endpoints)
      async () => {
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(detectedFrom)}|${encodeURIComponent(to)}`;
        return fetchMyMemory(url);
      },
      // Method 4: Google Translate alternate endpoint
      async () => {
        const url = `https://translate.google.com/translate_a/single?client=at&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
        return fetchGoogleTranslate(url);
      }
    ];

    let lastError: any = null;
    for (const method of methods) {
      try {
        const result = await method();
        if (result && result.trim() !== '') {
          return result;
        }
      } catch (err) {
        lastError = err;
        console.warn(`[Free Translation Fallback Attempt Failed]:`, err);
      }
    }

    throw lastError || new Error("All free translation fallback engines failed");
  };

  // API routes
  app.get("/api/env-check", (req, res) => {
    res.json({
      gemini: !!(process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.GOOGLE_API_KEY),
      openai: !!process.env.OPENAI_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      custom: false
    });
  });

  app.post("/api/free-translate", async (req, res) => {
    const { text, from = 'auto', to = 'id' } = req.body;
    if (!text || typeof text !== 'string' || text.trim() === '') {
      return res.json({ translatedText: '' });
    }
    
    try {
      const result = await getFreeTranslation(text, from, to);
      res.json({ translatedText: result });
    } catch (error: any) {
      console.error("[Free Translate REST API error]:", error);
      res.status(500).json({ error: error.message || "Failed to perform free translation" });
    }
  });

  app.post("/api/translate", async (req, res) => {
    const { provider, model, contents, config, customKey } = req.body;
    
    try {
      let key = (typeof customKey === 'string' && customKey.trim() !== '') ? customKey.trim() : '';
      if (!key) {
        if (provider === 'openai') {
          key = process.env.OPENAI_API_KEY || '';
        } else if (provider === 'anthropic') {
          key = process.env.ANTHROPIC_API_KEY || '';
        } else if (provider === 'custom') {
          key = process.env.OPENAI_API_KEY || '';
        } else {
          key = process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.GOOGLE_API_KEY || '';
        }
      }

      if (!key) {
        return res.status(401).json({ error: `No API key found for provider: ${provider}` });
      }

      let ai: AIProvider;
      switch (provider) {
        case 'openai': ai = new OpenAIProvider(key); break;
        case 'anthropic': ai = new AnthropicProvider(key); break;
        case 'custom': ai = new OpenAIProvider(key, req.body.customBaseURL); break;
        default: ai = new GeminiProvider(key); break;
      }

      const response = await ai.generateContent({ model, contents, config });
      res.json(response);
    } catch (error: any) {
      let statusCode = 500;
      let errorMsg = 'Internal Server Error';
      let errorDetails = '';

      if (error) {
        if (typeof error === 'string') {
          errorMsg = error;
        } else {
          errorMsg = error.message || 'Internal Server Error';
          
          const errorStr = (error.message || '') + ' ' + (error.status || '') + ' ' + JSON.stringify(error.error || {});
          
          if (errorStr.includes('429') || errorStr.includes('RESOURCE_EXHAUSTED') || errorStr.includes('quota') || errorStr.includes('Quota exceeded')) {
            statusCode = 429;
          } else if (errorStr.includes('503') || errorStr.includes('UNAVAILABLE') || errorStr.includes('Service Unavailable') || errorStr.includes('experiencing high demand')) {
            statusCode = 503;
          } else if (errorStr.includes('401') || errorStr.includes('invalid_api_key') || errorStr.includes('API key')) {
            statusCode = 401;
          } else if (errorStr.includes('403') || errorStr.includes('PERMISSION_DENIED')) {
            statusCode = 403;
          } else if (errorStr.includes('400') || errorStr.includes('INVALID_ARGUMENT') || errorStr.includes('BAD_REQUEST')) {
            statusCode = 400;
          } else {
            if (typeof error.status === 'number' && error.status >= 400 && error.status <= 599) {
              statusCode = error.status;
            } else if (typeof error.status === 'string' && /^\d+$/.test(error.status)) {
              const parsed = parseInt(error.status, 10);
              if (parsed >= 400 && parsed <= 599) statusCode = parsed;
            } else if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode <= 599) {
              statusCode = error.statusCode;
            }
          }

          try {
            if (error.error && typeof error.error === 'object') {
              errorDetails = JSON.stringify(error.error);
            } else if (error.response?.data) {
              errorDetails = typeof error.response.data === 'object' ? JSON.stringify(error.response.data) : String(error.response.data);
            } else {
              const safeObj: any = {};
              if (error.status) safeObj.status = error.status;
              if (error.statusCode) safeObj.statusCode = error.statusCode;
              if (error.code) safeObj.code = error.code;
              if (error.statusText) safeObj.statusText = error.statusText;
              
              if (Object.keys(safeObj).length > 0) {
                errorDetails = JSON.stringify(safeObj);
              } else {
                errorDetails = String(error);
              }
            }
          } catch (e) {
            errorDetails = 'Could not safely serialize error details';
          }
        }
      }

      let retrySeconds = 0;
      const fullErrorStr = errorMsg + ' ' + errorDetails;
      const matchSeconds = fullErrorStr.match(/retry in\s+([0-9.]+)\s*s/i);
      if (matchSeconds && matchSeconds[1]) {
        retrySeconds = parseFloat(matchSeconds[1]);
      } else {
        const matchDelay = fullErrorStr.match(/"retryDelay"\s*:\s*"(\d+)\s*s?"/i);
        if (matchDelay && matchDelay[1]) {
          retrySeconds = parseFloat(matchDelay[1]);
        }
      }

      if (statusCode === 429) {
        console.warn(`[Translation Rate Limit] ${provider} (${model}): Quota/Rate limit reached${retrySeconds > 0 ? ` (retry in ${retrySeconds}s)` : ''}`);
      } else {
        console.error(`Translation error (${provider}):`, error);
      }

      res.status(statusCode).json({ 
        error: errorMsg,
        details: errorDetails,
        retrySeconds: retrySeconds > 0 ? retrySeconds : undefined
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
