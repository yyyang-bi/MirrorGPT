import { getRotatedApiKey, normalizeOpenAIError } from "@/lib/openai";
import { ProviderConfig } from "@/lib/provider-config";

export type ImageTaskParams = {
  size: string;
  quality: "auto" | "low" | "medium" | "high";
  output_format: "png" | "jpeg" | "webp";
  output_compression: number | null;
  moderation: "auto" | "low";
  n: number;
};

type ImageApiResult = {
  dataUrl: string;
  revisedPrompt?: string;
  actualParams?: Partial<ImageTaskParams>;
};

type CallImageOptions = {
  providerConfig: ProviderConfig;
  prompt: string;
  params: ImageTaskParams;
  inputImageDataUrls: string[];
  maskDataUrl?: string;
  signal?: AbortSignal;
  requestId?: string;
};

type CompatibilityMode = "standard" | "codex";

const MIME_MAP: Record<ImageTaskParams["output_format"], string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp"
};

const SAFETY_VIOLATION_LABELS: Record<string, string> = {
  violence: "暴力/伤害内容",
  sexual: "性相关内容",
  self_harm: "自伤内容",
  hate: "仇恨/骚扰内容",
  harassment: "骚扰内容",
  illegal: "违法内容"
};

const globalForImageApi = globalThis as unknown as {
  imageApiCodexCompatibilityCache?: Record<string, true>;
};

export class ImageGenerationApiError extends Error {
  readonly statusCode: number;
  readonly upstreamStatus?: number;
  readonly requestId?: string;
  readonly safetyViolations?: string[];
  readonly isSafetyRejection: boolean;

  constructor(
    message: string,
    options?: {
      statusCode?: number;
      upstreamStatus?: number;
      requestId?: string;
      safetyViolations?: string[];
      isSafetyRejection?: boolean;
    }
  ) {
    super(message);
    this.name = "ImageGenerationApiError";
    this.statusCode = options?.statusCode ?? 502;
    this.upstreamStatus = options?.upstreamStatus;
    this.requestId = options?.requestId;
    this.safetyViolations = options?.safetyViolations;
    this.isSafetyRejection = Boolean(options?.isSafetyRejection);
  }
}

export const DEFAULT_IMAGE_PARAMS: ImageTaskParams = {
  size: "auto",
  quality: "auto",
  output_format: "png",
  output_compression: null,
  moderation: "auto",
  n: 1
};

function getCompatibilityCacheKey(config: ProviderConfig) {
  return `${config.baseUrl}|${config.apiKeys.map((key) => key.trim()).filter(Boolean).join(",")}`;
}

function readCachedCodexCompatibility(config: ProviderConfig) {
  return Boolean(globalForImageApi.imageApiCodexCompatibilityCache?.[getCompatibilityCacheKey(config)]);
}

function cacheCodexCompatibility(config: ProviderConfig) {
  if (!globalForImageApi.imageApiCodexCompatibilityCache) {
    globalForImageApi.imageApiCodexCompatibilityCache = {};
  }

  globalForImageApi.imageApiCodexCompatibilityCache[getCompatibilityCacheKey(config)] = true;
}

function normalizeBase64Image(value: string, fallbackMime: string): string {
  return value.startsWith("data:") ? value : `data:${fallbackMime};base64,${value}`;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function collectSafetyViolations(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => collectSafetyViolations(item))
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .replace(/^[\s[]+|[\s\]]+$/g, "")
      .split(/[,，]/)
      .map((item) => item.trim().replace(/^["']|["']$/g, "").toLowerCase())
      .filter(Boolean);
  }

  return [];
}

function extractSafetyViolationsFromPayload(payload: unknown): string[] {
  const root = readRecord(payload);
  if (!root) return [];

  const error = readRecord(root.error);
  const response = readRecord(root.response);
  const responseError = readRecord(response?.error);
  const innerError = readRecord(error?.innererror);
  const responseInnerError = readRecord(responseError?.innererror);
  const candidates = [
    root.safety_violations,
    error?.safety_violations,
    innerError?.safety_violations,
    responseError?.safety_violations,
    responseInnerError?.safety_violations,
    root.violations,
    error?.violations,
    responseError?.violations
  ];

  return Array.from(new Set(candidates.flatMap(collectSafetyViolations)));
}

function extractSafetyViolationsFromMessage(message: string): string[] {
  const match = message.match(/safety_violations\s*=\s*\[([^\]]+)\]/i);
  if (!match) return [];
  return Array.from(new Set(collectSafetyViolations(match[1])));
}

function getStringProperty(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractRequestIdFromPayload(payload: unknown): string | undefined {
  const root = readRecord(payload);
  const error = readRecord(root?.error);
  const response = readRecord(root?.response);
  const responseError = readRecord(response?.error);
  return (
    getStringProperty(root, "request_id") ||
    getStringProperty(root, "requestId") ||
    getStringProperty(error, "request_id") ||
    getStringProperty(error, "requestId") ||
    getStringProperty(response, "request_id") ||
    getStringProperty(response, "requestId") ||
    getStringProperty(responseError, "request_id") ||
    getStringProperty(responseError, "requestId")
  );
}

function extractRequestIdFromMessage(message: string): string | undefined {
  const match = message.match(/request\s*id\s+([a-z0-9_-]+)/i);
  return match?.[1];
}

function isSafetyRejection(message: string, safetyViolations: string[], payload?: unknown) {
  if (safetyViolations.length > 0) return true;

  const lowerMessage = message.toLowerCase();
  if (/safety system|safety_violations|content policy/.test(lowerMessage)) return true;

  const root = readRecord(payload);
  const error = readRecord(root?.error);
  const response = readRecord(root?.response);
  const responseError = readRecord(response?.error);
  const errorCode = [
    getStringProperty(error, "code"),
    getStringProperty(error, "type"),
    getStringProperty(responseError, "code"),
    getStringProperty(responseError, "type")
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /safety|policy|moderation/.test(errorCode);
}

function formatSafetyRejectionMessage(message: string, payload?: unknown) {
  const safetyViolations = Array.from(
    new Set([
      ...extractSafetyViolationsFromPayload(payload),
      ...extractSafetyViolationsFromMessage(message)
    ])
  );
  const requestId = extractRequestIdFromPayload(payload) || extractRequestIdFromMessage(message);
  const reasons = safetyViolations
    .map((item) => SAFETY_VIOLATION_LABELS[item] || item)
    .filter(Boolean)
    .join("、");

  return {
    requestId,
    safetyViolations,
    message:
      `生图请求被 OpenAI 安全系统拒绝${reasons ? `（${reasons}）` : ""}。` +
      `请调整提示词或参考图，避免暴力、伤害等可能触发安全审核的内容。` +
      `${requestId ? `如果认为是误判，可携带 Request ID ${requestId} 联系 OpenAI 支持。` : ""}`
  };
}

function createImageGenerationError(message: string, upstreamStatus?: number, payload?: unknown) {
  const safetyInfo = formatSafetyRejectionMessage(message, payload);
  if (isSafetyRejection(message, safetyInfo.safetyViolations, payload)) {
    return new ImageGenerationApiError(safetyInfo.message, {
      statusCode: 400,
      upstreamStatus,
      requestId: safetyInfo.requestId,
      safetyViolations: safetyInfo.safetyViolations,
      isSafetyRejection: true
    });
  }

  return new ImageGenerationApiError(message, {
    statusCode: 502,
    upstreamStatus
  });
}

export function getImageGenerationErrorStatus(error: unknown) {
  return error instanceof ImageGenerationApiError ? error.statusCode : 502;
}

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function getMimeFromOutputFormat(outputFormat: unknown, fallbackMime: string) {
  if (typeof outputFormat !== "string") return fallbackMime;

  const normalized = outputFormat.trim().toLowerCase();
  if (!normalized) return fallbackMime;
  if (normalized.includes("/")) return normalized;
  if (normalized === "jpg") return "image/jpeg";

  return MIME_MAP[normalized as ImageTaskParams["output_format"]] || fallbackMime;
}

async function normalizeImageOutputToDataUrl(value: string, fallbackMime: string, signal?: AbortSignal) {
  const image = value.trim();
  if (!image) throw new Error("OpenAI 生图接口返回了空图片数据。");
  if (image.startsWith("data:")) return image;
  if (isHttpUrl(image)) return fetchImageUrlAsDataUrl(image, fallbackMime, signal);

  return normalizeBase64Image(image, fallbackMime);
}

function findSSEBoundary(buffer: string) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");

  if (lf === -1 && crlf === -1) return null;
  if (lf === -1) return { index: crlf, length: 4 };
  if (crlf === -1) return { index: lf, length: 2 };

  return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 };
}

function parseSSEBlock(block: string) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace(/^data:\s?/, ""))
    .join("\n")
    .trim();

  return data;
}

function describeError(error: unknown) {
  if (!(error instanceof Error)) return String(error);

  const cause = (error as { cause?: unknown }).cause;
  const causeMessage =
    cause instanceof Error
      ? cause.message
      : cause && typeof cause === "object" && "message" in cause
        ? String((cause as { message?: unknown }).message)
        : "";
  const causeCode =
    cause && typeof cause === "object" && "code" in cause
      ? String((cause as { code?: unknown }).code)
      : "";
  const detail = [causeCode, causeMessage].filter(Boolean).join("：");

  return detail ? `${error.message}（${detail}）` : error.message;
}

function getErrorCauseForLog(error: unknown) {
  if (!(error instanceof Error)) return undefined;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== "object") return undefined;

  const record = cause as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : undefined,
    message: typeof record.message === "string" ? record.message : undefined
  };
}

function truncateLogText(value: string, maxLength = 1200) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...<truncated ${value.length - maxLength} chars>` : value;
}

function logImageApi(level: "info" | "warn" | "error", event: string, details: Record<string, unknown>) {
  const logger = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  logger(`[image-api] ${event}`, details);
}

async function fetchWithBetterError(
  url: string,
  init: RequestInit,
  label: string,
  context?: {
    requestId?: string;
    endpoint?: string;
    startedAt?: number;
  }
) {
  try {
    return await fetch(url, init);
  } catch (error) {
    logImageApi("error", "fetch_failed", {
      requestId: context?.requestId,
      endpoint: context?.endpoint || url,
      elapsedMs: context?.startedAt ? Date.now() - context.startedAt : undefined,
      message: error instanceof Error ? error.message : String(error),
      cause: getErrorCauseForLog(error)
    });
    throw new Error(`${label} 网络请求失败：${describeError(error)}`);
  }
}

async function getApiErrorDetails(response: Response, fallback: string) {
  const text = await response.text().catch(() => "");
  if (!text) return { message: fallback, body: "", payload: undefined };

  try {
    const payload = JSON.parse(text);
    return {
      message: normalizeOpenAIError(payload, fallback),
      body: truncateLogText(text),
      payload
    };
  } catch {
    return {
      message: text,
      body: truncateLogText(text),
      payload: undefined
    };
  }
}

function createJsonHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "Cache-Control": "no-store, no-cache, max-age=0",
    Pragma: "no-cache"
  };
}

function createAuthHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Cache-Control": "no-store, no-cache, max-age=0",
    Pragma: "no-cache"
  };
}

function pickActualParams(source: unknown): Partial<ImageTaskParams> {
  if (!source || typeof source !== "object") return {};
  const record = source as Record<string, unknown>;
  const actualParams: Partial<ImageTaskParams> = {};

  if (typeof record.size === "string") actualParams.size = record.size;
  if (record.quality === "auto" || record.quality === "low" || record.quality === "medium" || record.quality === "high") {
    actualParams.quality = record.quality;
  }
  if (record.output_format === "png" || record.output_format === "jpeg" || record.output_format === "webp") {
    actualParams.output_format = record.output_format;
  }
  if (typeof record.output_compression === "number") actualParams.output_compression = record.output_compression;
  if (record.moderation === "auto" || record.moderation === "low") actualParams.moderation = record.moderation;
  if (typeof record.n === "number") actualParams.n = record.n;

  return actualParams;
}

function mergeActualParams(...sources: Array<Partial<ImageTaskParams> | undefined>) {
  const merged = Object.assign({}, ...sources.filter(Boolean));
  return Object.keys(merged).length ? merged : undefined;
}

function shouldRetryWithCodexCompatibility(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /(quality|unsupported.*parameter|unknown.*parameter|unrecognized.*argument|invalid.*parameter)/i.test(message);
}

function shouldCacheCodexCompatibility(result: ImageApiResult, prompt: string) {
  const revisedPrompt = result.revisedPrompt?.trim();
  return !revisedPrompt || revisedPrompt !== prompt.trim();
}

async function getResponsesImageResultFromOutputItem(item: unknown, fallbackMime: string, signal?: AbortSignal): Promise<ImageApiResult | null> {
  const outputItem = item as {
    type?: string;
    result?: string | {
      b64_json?: string;
      image?: string;
      data?: string;
      url?: string;
      image_url?: string;
    };
    b64_json?: string;
    image?: string;
    data?: string;
    url?: string;
    image_url?: string;
    revised_prompt?: string;
    size?: string;
    quality?: string;
    output_format?: string;
    output_compression?: number;
    moderation?: string;
  } | null;

  if (outputItem?.type !== "image_generation_call") return null;

  const result = outputItem.result;
  const outputMime = getMimeFromOutputFormat(outputItem.output_format, fallbackMime);
  const image =
    typeof result === "string"
      ? result
      : result?.b64_json || result?.image || result?.data || result?.url || result?.image_url ||
        outputItem.b64_json || outputItem.image || outputItem.data || outputItem.url || outputItem.image_url;

  if (!image) return null;

  return {
    dataUrl: await normalizeImageOutputToDataUrl(image, outputMime, signal),
    revisedPrompt: typeof outputItem.revised_prompt === "string" ? outputItem.revised_prompt : undefined,
    actualParams: mergeActualParams(pickActualParams(outputItem), { n: 1 })
  };
}

function dataUrlToBlob(dataUrl: string, fallbackType = "image/png") {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!match) throw new Error("图片输入必须是 data URL。");

  const mime = match[1] || fallbackType;
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";
  const bytes = isBase64
    ? Buffer.from(payload.replace(/\s/g, ""), "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");

  return new Blob([bytes], { type: mime || fallbackType });
}

function getBlobExtension(blob: Blob) {
  const subtype = blob.type.split("/")[1] || "png";
  return subtype === "jpeg" ? "jpg" : subtype;
}

async function fetchImageUrlAsDataUrl(url: string, fallbackMime: string, signal?: AbortSignal) {
  if (url.startsWith("data:")) return url;
  if (!/^https?:\/\//i.test(url)) throw new Error(`图片 URL 格式不支持：${url.slice(0, 80)}`);

  const response = await fetchWithBetterError(url, {
    cache: "no-store",
    signal
  }, "图片 URL 下载");

  if (!response.ok) {
    throw new Error(`图片 URL 下载失败：HTTP ${response.status}`);
  }

  const mime = response.headers.get("content-type")?.split(";")[0]?.trim() || fallbackMime;
  const bytes = Buffer.from(await response.arrayBuffer());
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function createResponsesInput(prompt: string, inputImageDataUrls: string[]) {
  const text = `Use the following text as the complete prompt. Do not rewrite it:\n${prompt}`;
  if (!inputImageDataUrls.length) return text;

  return [
    {
      role: "user",
      content: [
        { type: "input_text", text },
        ...inputImageDataUrls.map((dataUrl) => ({
          type: "input_image",
          image_url: dataUrl
        }))
      ]
    }
  ];
}

function createResponsesImageTool(params: ImageTaskParams, isEdit: boolean, mode: CompatibilityMode, maskDataUrl?: string) {
  const tool: Record<string, unknown> = {
    type: "image_generation",
    action: isEdit ? "edit" : "generate",
    size: params.size,
    output_format: params.output_format
  };

  if (mode !== "codex") {
    tool.quality = params.quality;
  }

  if (params.output_format !== "png" && params.output_compression != null) {
    tool.output_compression = params.output_compression;
  }

  if (maskDataUrl) {
    tool.input_image_mask = {
      image_url: maskDataUrl
    };
  }

  return tool;
}

async function parseImagesApiPayload(payload: unknown, fallbackMime: string, signal?: AbortSignal): Promise<ImageApiResult> {
  const firstImage = (payload as {
    data?: Array<{
      url?: string;
      b64_json?: string;
      revised_prompt?: string;
      size?: string;
      quality?: string;
      output_format?: string;
      output_compression?: number;
      moderation?: string;
    }>;
  } | null)?.data?.[0];

  if (!firstImage) throw new Error("OpenAI 生图接口没有返回可用图片。");

  const dataUrl = firstImage.b64_json
    ? normalizeBase64Image(firstImage.b64_json, fallbackMime)
    : firstImage.url
      ? await fetchImageUrlAsDataUrl(firstImage.url, fallbackMime, signal)
      : null;

  if (!dataUrl) throw new Error("OpenAI 生图接口没有返回可用图片。");

  return {
    dataUrl,
    revisedPrompt: typeof firstImage.revised_prompt === "string" ? firstImage.revised_prompt : undefined,
    actualParams: mergeActualParams(pickActualParams(payload), pickActualParams(firstImage), { n: 1 })
  };
}

async function parseResponsesImagePayload(payload: unknown, fallbackMime: string, signal?: AbortSignal): Promise<ImageApiResult> {
  const responsePayload = (payload as { response?: unknown } | null)?.response || payload;
  const output = (responsePayload as {
    output?: Array<{
      type?: string;
      result?: string | {
        b64_json?: string;
        image?: string;
        data?: string;
        url?: string;
        image_url?: string;
      };
      revised_prompt?: string;
      size?: string;
      quality?: string;
      output_format?: string;
      output_compression?: number;
      moderation?: string;
    }>;
  } | null)?.output;

  if (!Array.isArray(output)) throw new Error("OpenAI Responses 接口没有返回图片。");

  for (const item of output) {
    const imageResult = await getResponsesImageResultFromOutputItem(item, fallbackMime, signal);
    if (imageResult) return imageResult;
  }

  throw new Error("OpenAI Responses 接口没有返回可用图片。");
}

async function parseResponsesImageStream(response: Response, fallbackMime: string, opts: CallImageOptions, startedAt: number): Promise<ImageApiResult> {
  if (!response.body) {
    throw new Error("OpenAI Responses 生图接口没有返回可读取的流。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fallbackImageResult: ImageApiResult | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const boundary = findSSEBoundary(buffer);
        if (!boundary) break;

        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);

        const data = parseSSEBlock(block);
        if (!data || data === "[DONE]") continue;

        let payload: {
          type?: string;
          item?: unknown;
          response?: unknown;
          error?: {
            message?: string;
          };
          partial_image_b64?: string;
          output_format?: string;
        };

        try {
          payload = JSON.parse(data);
        } catch {
          logImageApi("warn", "stream_invalid_json", {
            requestId: opts.requestId,
            endpoint: "/responses",
            elapsedMs: Date.now() - startedAt,
            data: truncateLogText(data, 500)
          });
          continue;
        }

        if (payload.type === "response.failed" || payload.type === "error") {
          const responseError = (payload.response as { error?: { message?: string } } | null)?.error;
          throw createImageGenerationError(
            payload.error?.message || responseError?.message || "OpenAI Responses 生图流返回失败事件。",
            undefined,
            payload
          );
        }

        if (payload.type === "response.output_item.done") {
          const imageResult = await getResponsesImageResultFromOutputItem(payload.item, fallbackMime, opts.signal);
          if (imageResult) {
            fallbackImageResult = imageResult;
          }
        }

        if (payload.type === "response.image_generation_call.partial_image" && payload.partial_image_b64) {
          fallbackImageResult = {
            dataUrl: normalizeBase64Image(
              payload.partial_image_b64,
              getMimeFromOutputFormat(payload.output_format, fallbackMime)
            ),
            actualParams: mergeActualParams(
              payload.output_format ? { output_format: payload.output_format as ImageTaskParams["output_format"] } : undefined,
              { n: 1 }
            )
          };
        }

        if (payload.type === "response.completed") {
          try {
            return await parseResponsesImagePayload(payload.response || payload, fallbackMime, opts.signal);
          } catch (error) {
            if (fallbackImageResult) return fallbackImageResult;
            throw error;
          }
        }
      }
    }

    if (fallbackImageResult) return fallbackImageResult;
    throw new Error("OpenAI Responses 生图流已结束，但没有返回可用图片。");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function callImagesApi(opts: CallImageOptions, mode: CompatibilityMode): Promise<ImageApiResult> {
  const { providerConfig, params, inputImageDataUrls, maskDataUrl, signal } = opts;
  const apiKey = getRotatedApiKey(providerConfig);
  if (!apiKey) throw new Error("请先配置 API 密钥。");

  const prompt = mode === "codex"
    ? `Use the following text as the complete prompt. Do not rewrite it:\n${opts.prompt}`
    : opts.prompt;
  const fallbackMime = MIME_MAP[params.output_format] || "image/png";
  const isEdit = inputImageDataUrls.length > 0;
  const endpointPath = isEdit ? "/images/edits" : "/images/generations";
  const endpointUrl = `${providerConfig.baseUrl}${endpointPath}`;
  const startedAt = Date.now();

  let response: Response;

  if (isEdit) {
    const formData = new FormData();
    formData.append("model", providerConfig.imageModel);
    formData.append("prompt", prompt);
    formData.append("size", params.size);
    formData.append("output_format", params.output_format);
    formData.append("moderation", params.moderation);
    if (params.n > 1) {
      formData.append("n", String(params.n));
    }

    if (mode !== "codex") {
      formData.append("quality", params.quality);
    }

    if (params.output_format !== "png" && params.output_compression != null) {
      formData.append("output_compression", String(params.output_compression));
    }

    inputImageDataUrls.forEach((dataUrl, index) => {
      const blob = dataUrlToBlob(dataUrl);
      formData.append("image[]", blob, `input-${index + 1}.${getBlobExtension(blob)}`);
    });

    if (maskDataUrl) {
      formData.append("mask", dataUrlToBlob(maskDataUrl, "image/png"), "mask.png");
    }

    response = await fetchWithBetterError(endpointUrl, {
      method: "POST",
      headers: createAuthHeaders(apiKey),
      cache: "no-store",
      body: formData,
      signal
    }, "Images API 编辑", {
      requestId: opts.requestId,
      endpoint: endpointPath,
      startedAt
    });
  } else {
    const body: Record<string, unknown> = {
      model: providerConfig.imageModel,
      prompt,
      size: params.size,
      output_format: params.output_format,
      moderation: params.moderation
    };

    if (params.n > 1) {
      body.n = params.n;
    }

    if (mode !== "codex") {
      body.quality = params.quality;
    }

    if (params.output_format !== "png" && params.output_compression != null) {
      body.output_compression = params.output_compression;
    }

    response = await fetchWithBetterError(endpointUrl, {
      method: "POST",
      headers: createJsonHeaders(apiKey),
      cache: "no-store",
      body: JSON.stringify(body),
      signal
    }, "Images API 生图", {
      requestId: opts.requestId,
      endpoint: endpointPath,
      startedAt
    });
  }

  if (!response.ok) {
    const errorDetails = await getApiErrorDetails(response, `OpenAI 生图接口错误：${response.status}`);
    logImageApi("warn", "upstream_failed", {
      requestId: opts.requestId,
      endpoint: endpointPath,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      body: errorDetails.body
    });
    throw createImageGenerationError(errorDetails.message, response.status, errorDetails.payload);
  }

  const payload = await response.json().catch((error) => {
    throw new Error(`OpenAI 生图接口返回不是有效 JSON：${describeError(error)}`);
  });

  const firstImage = (payload as {
    data?: Array<{
      url?: string;
      b64_json?: string;
      revised_prompt?: string;
    }>;
  } | null)?.data?.[0];
  const returnType = firstImage?.b64_json
    ? "b64_json"
    : firstImage?.url?.startsWith("data:")
      ? "data_url"
      : firstImage?.url
        ? "url"
        : "unknown";
  const result = await parseImagesApiPayload(payload, fallbackMime, signal);

  logImageApi("info", "upstream_success", {
    requestId: opts.requestId,
    endpoint: endpointPath,
    status: response.status,
    elapsedMs: Date.now() - startedAt,
    returnType,
    hasRevisedPrompt: Boolean(result.revisedPrompt)
  });

  return result;
}

async function callResponsesApi(opts: CallImageOptions, mode: CompatibilityMode): Promise<ImageApiResult> {
  const { providerConfig, prompt, params, inputImageDataUrls, maskDataUrl, signal } = opts;
  const apiKey = getRotatedApiKey(providerConfig);
  if (!apiKey) throw new Error("请先配置 API 密钥。");

  const fallbackMime = MIME_MAP[params.output_format] || "image/png";
  const endpointPath = "/responses";
  const startedAt = Date.now();
  const body = {
    model: providerConfig.responsesImageModel,
    stream: true,
    input: createResponsesInput(prompt, inputImageDataUrls),
    tools: [createResponsesImageTool(params, inputImageDataUrls.length > 0, mode, maskDataUrl)],
    tool_choice: "required"
  };
  const response = await fetchWithBetterError(`${providerConfig.baseUrl}${endpointPath}`, {
    method: "POST",
    headers: createJsonHeaders(apiKey),
    cache: "no-store",
    body: JSON.stringify(body),
    signal
  }, "Responses API 生图", {
    requestId: opts.requestId,
    endpoint: endpointPath,
    startedAt
  });

  if (!response.ok) {
    const errorDetails = await getApiErrorDetails(response, `OpenAI Responses 生图接口错误：${response.status}`);
    logImageApi("warn", "upstream_failed", {
      requestId: opts.requestId,
      endpoint: endpointPath,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      body: errorDetails.body
    });
    throw createImageGenerationError(errorDetails.message, response.status, errorDetails.payload);
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.toLowerCase().includes("text/event-stream")) {
    const result = await parseResponsesImageStream(response, fallbackMime, opts, startedAt);

    logImageApi("info", "upstream_success", {
      requestId: opts.requestId,
      endpoint: endpointPath,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      returnType: "stream",
      hasRevisedPrompt: Boolean(result.revisedPrompt)
    });

    return result;
  }

  const payload = await response.json().catch((error) => {
    throw new Error(`OpenAI Responses 生图接口返回不是有效 JSON：${describeError(error)}`);
  });

  const output = (payload as {
    output?: Array<{
      type?: string;
      result?: string | {
        b64_json?: string;
        image?: string;
        data?: string;
      };
      revised_prompt?: string;
    }>;
  } | null)?.output;
  const imageItem = Array.isArray(output) ? output.find((item) => item?.type === "image_generation_call") : undefined;
  const rawResult = imageItem?.result;
  const returnType = typeof rawResult === "string"
    ? "b64_json"
    : rawResult?.b64_json
      ? "b64_json"
      : rawResult?.image || rawResult?.data
        ? "object_image"
        : "unknown";
  const result = await parseResponsesImagePayload(payload, fallbackMime, signal);

  logImageApi("info", "upstream_success", {
    requestId: opts.requestId,
    endpoint: endpointPath,
    status: response.status,
    elapsedMs: Date.now() - startedAt,
    returnType,
    hasRevisedPrompt: Boolean(result.revisedPrompt)
  });

  return result;
}

async function callOnce(opts: CallImageOptions, mode: CompatibilityMode) {
  return opts.providerConfig.imageApiMode === "responses"
    ? callResponsesApi(opts, mode)
    : callImagesApi(opts, mode);
}

export function normalizeImageParams(input: unknown, legacySize?: string): ImageTaskParams {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const outputFormat =
    record.output_format === "jpeg" || record.output_format === "webp" || record.output_format === "png"
      ? record.output_format
      : DEFAULT_IMAGE_PARAMS.output_format;
  const quality =
    record.quality === "low" || record.quality === "medium" || record.quality === "high" || record.quality === "auto"
      ? record.quality
      : DEFAULT_IMAGE_PARAMS.quality;
  const moderation = record.moderation === "low" ? "low" : DEFAULT_IMAGE_PARAMS.moderation;
  const outputCompression =
    typeof record.output_compression === "number" && Number.isFinite(record.output_compression)
      ? Math.max(0, Math.min(100, Math.round(record.output_compression)))
      : null;

  return {
    size: typeof record.size === "string" && record.size.trim()
      ? record.size.trim()
      : legacySize?.trim() || DEFAULT_IMAGE_PARAMS.size,
    quality,
    output_format: outputFormat,
    output_compression: outputFormat === "png" ? null : outputCompression,
    moderation,
    n: 1
  };
}

export async function callImageGenerationApi(opts: CallImageOptions): Promise<ImageApiResult> {
  const forcedMode =
    opts.providerConfig.imageCompatibilityMode === "codex" ||
    (opts.providerConfig.imageCompatibilityMode === "auto" && readCachedCodexCompatibility(opts.providerConfig))
      ? "codex"
      : "standard";

  try {
    const result = await callOnce(opts, forcedMode);
    if (opts.providerConfig.imageCompatibilityMode === "auto" && shouldCacheCodexCompatibility(result, opts.prompt)) {
      cacheCodexCompatibility(opts.providerConfig);
    }
    return result;
  } catch (error) {
    const canRetry =
      opts.providerConfig.imageCompatibilityMode === "auto" &&
      forcedMode === "standard" &&
      shouldRetryWithCodexCompatibility(error);

    if (!canRetry) throw error;

    cacheCodexCompatibility(opts.providerConfig);
    return callOnce(opts, "codex");
  }
}
