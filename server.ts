import crypto from 'crypto';
import express from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import { GoogleGenAI } from '@google/genai';

const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_MODELS = new Set([
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-4-hydrogen',
  'gemini-4-neon',
  'gemini-4-carbon',
  'gemini-4-argon',
]);

// Hạn mức an toàn phía cổng máy chủ (luôn thấp hơn trần 15 RPM của Google Free Tier để chừa vùng đệm độ trễ mạng)
const SERVER_SAFE_RPM_LIMIT = 14;
const SERVER_RPM_WINDOW_MS = 63_000;
const SERVER_MIN_INTERVAL_MS = 4_400; // ~13.6 RPM tối đa cho mỗi (Project/Key + Model)
const SERVER_DEFAULT_429_COOLDOWN_MS = 20_000;

interface ServerChannelState {
  timestamps: number[];
  nextAllowedAt: number;
  cooldownUntil: number;
  mutex: Promise<void>;
}

const serverChannelStates = new Map<string, ServerChannelState>();

function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey.trim()).digest('hex').slice(0, 16);
}

function getOrCreateChannelState(keyFp: string, model: string): ServerChannelState {
  const mapKey = `${keyFp}::${model}`;
  let state = serverChannelStates.get(mapKey);
  if (!state) {
    state = {
      timestamps: [],
      nextAllowedAt: 0,
      cooldownUntil: 0,
      mutex: Promise.resolve(),
    };
    serverChannelStates.set(mapKey, state);
  }
  return state;
}

function extractRetryDelayMs(errText: string): number {
  const secMatch = errText.match(/retry(?:\s+in|\s*delay["':\s]+)(\d+(?:\.\d+)?)\s*s/i);
  if (secMatch) {
    const parsed = Math.ceil(Number(secMatch[1]) * 1000);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(65_000, Math.max(SERVER_DEFAULT_429_COOLDOWN_MS, parsed + 1_500));
    }
  }
  return SERVER_DEFAULT_429_COOLDOWN_MS;
}

async function acquireServerRpmSlot(
  apiKey: string,
  model: string,
  isAborted?: () => boolean
): Promise<{ releaseTimestamp: (completionMs?: number) => void }> {
  const keyFp = hashApiKey(apiKey);
  const state = getOrCreateChannelState(keyFp, model);

  let releaseMutex!: () => void;
  const prevMutex = state.mutex;
  state.mutex = new Promise<void>((resolve) => {
    releaseMutex = resolve;
  });

  await prevMutex;

  let slotIndex = -1;
  try {
    while (true) {
      if (isAborted?.()) {
        throw new Error('CLIENT_ABORTED');
      }

      const now = Date.now();
      state.timestamps = state.timestamps.filter((ts) => now - ts < SERVER_RPM_WINDOW_MS);

      const windowWaitUntil =
        state.timestamps.length >= SERVER_SAFE_RPM_LIMIT
          ? state.timestamps[0] + SERVER_RPM_WINDOW_MS
          : 0;

      const scheduledAt = Math.max(
        now,
        windowWaitUntil,
        state.nextAllowedAt,
        state.cooldownUntil
      );

      if (scheduledAt > now) {
        const waitMs = Math.min(scheduledAt - now, 5_000);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      state.timestamps.push(now);
      slotIndex = state.timestamps.length - 1;
      state.nextAllowedAt = now + SERVER_MIN_INTERVAL_MS;

      const activeTsRef = state.timestamps;
      const recordedAt = now;
      return {
        releaseTimestamp: (completionMs = Date.now()) => {
          // Cập nhật mốc kết thúc để cửa sổ 63s luôn tính an toàn sau thời điểm Google tiếp nhận
          const idx = activeTsRef.indexOf(recordedAt);
          if (idx !== -1 && completionMs > recordedAt) {
            activeTsRef[idx] = completionMs;
          } else if (slotIndex >= 0 && slotIndex < activeTsRef.length && completionMs > activeTsRef[slotIndex]) {
            activeTsRef[slotIndex] = completionMs;
          }
        },
      };
    }
  } finally {
    releaseMutex();
  }
}

function recordServerRpm429(apiKey: string, model: string, errText: string): { cooldownMs: number } {
  const keyFp = hashApiKey(apiKey);
  const now = Date.now();
  const cooldownMs = extractRetryDelayMs(errText);
  const state = getOrCreateChannelState(keyFp, model);

  state.timestamps = state.timestamps.filter((ts) => now - ts < SERVER_RPM_WINDOW_MS);
  state.cooldownUntil = Math.max(state.cooldownUntil, now + cooldownMs);
  state.nextAllowedAt = Math.max(state.nextAllowedAt, now + cooldownMs);

  return { cooldownMs };
}

function getServerGeminiKeys(): string[] {
  const raw = process.env.GEMINI_API_KEY || '';
  return Array.from(
    new Set(
      raw
        .split(/[,;\r\n]+/)
        .map((k) => k.trim())
        .filter(Boolean)
    )
  );
}

function createServerGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
      // Tắt retry ngầm bên trong SDK @google/genai để tránh 1 request tự nhân thành 2-5 request khi gặp 429
      retryOptions: {
        attempts: 1,
      },
    },
  });
}

function getErrorText(err: unknown): string {
  if (err instanceof Error) {
    const details = err as Error & { status?: number; response?: unknown };
    return `${details.message || ''} ${details.status || ''} ${JSON.stringify(details.response || '')}`.toLowerCase();
  }
  try {
    return JSON.stringify(err).toLowerCase();
  } catch {
    return String(err).toLowerCase();
  }
}

type FailureKind = 'RPD' | 'RPM' | 'AUTH' | 'NON_RETRYABLE' | 'TRANSIENT' | 'OTHER';

function classifyGeminiError(err: unknown): FailureKind {
  const errMsg = getErrorText(err);
  if (
    /per.?day|daily|free_tier_daily_limit|requests_per_day|requests per day|perday/.test(errMsg) ||
    (/\blimit\s*[:=]?\s*500\b/.test(errMsg) && /requests|generate_content/.test(errMsg))
  ) {
    return 'RPD';
  }
  if (/api.?key.?not.?valid|invalid api key|api_key_invalid|api.?key.?expired|api_key_expired|unauthenticated|permission_denied|http.?401|http.?403/.test(errMsg)) {
    return 'AUTH';
  }
  if (/gemini_non_retryable|safety|recitation|blocked by|prompt was blocked/.test(errMsg)) {
    return 'NON_RETRYABLE';
  }
  if (/429|resource_exhausted|rate.?limit|too many requests|quota exceeded/.test(errMsg)) {
    return 'RPM';
  }
  if (/503|502|500|timeout|timed out|network|failed to fetch|unavailable|socket/.test(errMsg)) {
    return 'TRANSIENT';
  }
  return 'OTHER';
}

function sanitizeModelConfig(rawConfig: unknown): Record<string, unknown> | undefined {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return undefined;
  }
  const input = rawConfig as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  if (typeof input.systemInstruction === 'string' && input.systemInstruction.trim()) {
    safe.systemInstruction = input.systemInstruction;
  }
  if (typeof input.responseMimeType === 'string' && input.responseMimeType.trim()) {
    safe.responseMimeType = input.responseMimeType;
  }
  if (input.responseSchema && typeof input.responseSchema === 'object') {
    safe.responseSchema = input.responseSchema;
  }
  if (input.thinkingConfig && typeof input.thinkingConfig === 'object') {
    safe.thinkingConfig = input.thinkingConfig;
  }
  if (typeof input.seed === 'number' && Number.isFinite(input.seed)) {
    safe.seed = input.seed;
  }
  if (typeof input.maxOutputTokens === 'number' && Number.isFinite(input.maxOutputTokens)) {
    safe.maxOutputTokens = input.maxOutputTokens;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function resolveRequestApiKey(req: Request, keySlotIndex?: unknown): string {
  const headerKey = req.header('x-gemini-api-key');
  if (typeof headerKey === 'string' && headerKey.trim()) {
    return headerKey.trim();
  }
  const serverKeys = getServerGeminiKeys();
  if (serverKeys.length === 0) return '';
  const slot = typeof keySlotIndex === 'number' && Number.isInteger(keySlotIndex) && keySlotIndex >= 0
    ? keySlotIndex % serverKeys.length
    : 0;
  return serverKeys[slot];
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // 1. Trạng thái Gemini API trên máy chủ (không bao giờ trả về chuỗi API Key)
  app.get('/api/gemini/status', (_req: Request, res: Response) => {
    const serverKeys = getServerGeminiKeys();
    res.json({
      serverConfigured: serverKeys.length > 0,
      serverKeyCount: serverKeys.length,
    });
  });

  // 2. Kiểm tra tính hợp lệ của Key qua máy chủ (thử 3.5 -> dự phòng 3.1)
  app.post('/api/gemini/test-key', async (req: Request, res: Response) => {
    const candidateKey = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    const apiKey = candidateKey || getServerGeminiKeys()[0] || '';

    if (!apiKey) {
      res.status(400).json({
        success: false,
        failureKind: 'AUTH',
        message: 'Chưa nhập API Key và máy chủ chưa cấu hình GEMINI_API_KEY.',
      });
      return;
    }

    const probeModels = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'] as const;
    let lastFailureKind: FailureKind = 'OTHER';
    let lastErrMessage = 'Key lỗi. Chờ hoặc thay key mới.';

    for (const modelName of probeModels) {
      let releaseSlot: ((completionMs?: number) => void) | null = null;
      try {
        const slot = await acquireServerRpmSlot(apiKey, modelName);
        releaseSlot = slot.releaseTimestamp;
        const ai = createServerGeminiClient(apiKey);
        const response = await ai.models.generateContent({
          model: modelName,
          contents: 'Ping test. Reply with word OK.',
        });
        releaseSlot();
        if (response?.text) {
          res.json({
            success: true,
            message:
              modelName === 'gemini-3.5-flash-lite'
                ? 'Key hoạt động tốt.'
                : 'Key hoạt động tốt (dự phòng 3.1).',
          });
          return;
        }
        lastErrMessage = 'Gemini trả về phản hồi rỗng.';
      } catch (err: unknown) {
        releaseSlot?.();
        lastFailureKind = classifyGeminiError(err);
        if (lastFailureKind === 'RPM') {
          recordServerRpm429(apiKey, modelName, getErrorText(err));
        }
        if (lastFailureKind === 'AUTH') {
          res.status(401).json({
            success: false,
            failureKind: 'AUTH',
            message: 'Key không hợp lệ hoặc bị từ chối quyền.',
          });
          return;
        }
        lastErrMessage =
          lastFailureKind === 'RPD' || lastFailureKind === 'RPM'
            ? 'Key hết hạn ngạch. Chờ hoặc thay key mới.'
            : err instanceof Error
            ? err.message
            : 'Key lỗi. Chờ hoặc thay key mới.';
      }
    }

    res
      .status(lastFailureKind === 'RPM' || lastFailureKind === 'RPD' ? 429 : 502)
      .json({
        success: false,
        failureKind: lastFailureKind,
        message: lastErrMessage,
      });
  });

  // 3. Proxy chuẩn cho tất cả tác vụ Gemini generateContent (OCR gáy sách, Chuẩn hóa, Tra cứu, Dịch EPUB)
  app.post('/api/gemini/generate', async (req: Request, res: Response) => {
    const { model, contents, config, keySlotIndex } = req.body || {};
    const requestedModel = typeof model === 'string' && model.trim() ? model.trim() : 'gemini-3.5-flash-lite';

    if (!ALLOWED_MODELS.has(requestedModel)) {
      res.status(400).json({
        error: `Model "${requestedModel}" không được hỗ trợ.`,
        failureKind: 'NON_RETRYABLE',
      });
      return;
    }

    if (!contents) {
      res.status(400).json({
        error: 'Thiếu nội dung đầu vào (contents).',
        failureKind: 'NON_RETRYABLE',
      });
      return;
    }

    const apiKey = resolveRequestApiKey(req, keySlotIndex);
    if (!apiKey) {
      res.status(503).json({
        error: 'Máy chủ chưa cấu hình GEMINI_API_KEY và chưa có Key trong Cài đặt.',
        failureKind: 'AUTH',
      });
      return;
    }

    let clientDisconnected = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
      }
    });

    let releaseSlot: ((completionMs?: number) => void) | null = null;
    try {
      const slot = await acquireServerRpmSlot(apiKey, requestedModel, () => clientDisconnected);
      releaseSlot = slot.releaseTimestamp;

      const ai = createServerGeminiClient(apiKey);
      const safeConfig = sanitizeModelConfig(config);
      const response = await ai.models.generateContent({
        model: requestedModel,
        contents,
        ...(safeConfig ? { config: safeConfig } : {}),
      });
      releaseSlot();

      const candidate = response?.candidates?.[0];
      const finishReason = candidate?.finishReason;
      if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
        res.status(422).json({
          error: `GEMINI_NON_RETRYABLE: Yêu cầu bị từ chối bởi Google AI (Lý do: ${finishReason}).`,
          failureKind: 'NON_RETRYABLE',
        });
        return;
      }

      const blockReason = response?.promptFeedback?.blockReason;
      if (blockReason) {
        res.status(422).json({
          error: `GEMINI_NON_RETRYABLE: Nội dung bị chặn bởi bộ lọc an toàn Google AI (Lý do: ${blockReason}).`,
          failureKind: 'NON_RETRYABLE',
        });
        return;
      }

      res.json({
        text: response?.text || '',
        finishReason: finishReason || 'STOP',
      });
    } catch (err: unknown) {
      releaseSlot?.();
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg === 'CLIENT_ABORTED') {
        if (!res.headersSent) {
          res.status(499).json({ error: 'Client closed request', failureKind: 'TRANSIENT' });
        }
        return;
      }

      const failureKind = classifyGeminiError(err);
      let retryAfterMs: number | undefined;
      if (failureKind === 'RPM') {
        const rpmInfo = recordServerRpm429(apiKey, requestedModel, getErrorText(err));
        retryAfterMs = rpmInfo.cooldownMs;
      }

      const status =
        failureKind === 'AUTH'
          ? 401
          : failureKind === 'RPM' || failureKind === 'RPD'
          ? 429
          : failureKind === 'NON_RETRYABLE'
          ? 422
          : 502;
      res.status(status).json({
        error: errMsg,
        failureKind,
        ...(retryAfterMs ? { retryAfterMs } : {}),
      });
    }
  });

  // 4. Proxy SSE Streaming cho generateContentStream
  app.post('/api/gemini/stream', async (req: Request, res: Response) => {
    const { model, contents, config, keySlotIndex } = req.body || {};
    const requestedModel = typeof model === 'string' && model.trim() ? model.trim() : 'gemini-3.5-flash-lite';

    if (!ALLOWED_MODELS.has(requestedModel) || !contents) {
      res.status(400).json({
        error: 'Tham số model hoặc contents không hợp lệ.',
        failureKind: 'NON_RETRYABLE',
      });
      return;
    }

    const apiKey = resolveRequestApiKey(req, keySlotIndex);
    if (!apiKey) {
      res.status(503).json({
        error: 'Máy chủ chưa cấu hình GEMINI_API_KEY.',
        failureKind: 'AUTH',
      });
      return;
    }

    let clientDisconnected = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
      }
    });

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let releaseSlot: ((completionMs?: number) => void) | null = null;
    try {
      const slot = await acquireServerRpmSlot(apiKey, requestedModel, () => clientDisconnected);
      releaseSlot = slot.releaseTimestamp;

      const ai = createServerGeminiClient(apiKey);
      const safeConfig = sanitizeModelConfig(config);
      const stream = await ai.models.generateContentStream({
        model: requestedModel,
        contents,
        ...(safeConfig ? { config: safeConfig } : {}),
      });

      for await (const chunk of stream) {
        if (chunk?.text) {
          res.write(`data: ${JSON.stringify({ text: chunk.text })}\n\n`);
        }
      }
      releaseSlot();
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (err: unknown) {
      releaseSlot?.();
      const failureKind = classifyGeminiError(err);
      if (failureKind === 'RPM') {
        recordServerRpm429(apiKey, requestedModel, getErrorText(err));
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      res.write(`data: ${JSON.stringify({ error: errMsg, failureKind })}\n\n`);
      res.end();
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.use((_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Kho Sách server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[Server] Failed to start:', err);
  process.exit(1);
});
