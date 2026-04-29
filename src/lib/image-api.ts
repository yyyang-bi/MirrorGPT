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
};

type CompatibilityMode = "standard" | "codex";

const MIME_MAP: Record<ImageTaskParams["output_format"], string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp"
};

const globalForImageApi = globalThis as unknown as {
  imageApiCodexCompatibilityCache?: Record<string, true>;
};

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
  const response = await fetch(url, {
    cache: "no-store",
    signal
  });

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

function parseResponsesImagePayload(payload: unknown, fallbackMime: string): ImageApiResult {
  const output = (payload as {
    output?: Array<{
      type?: string;
      result?: string | {
        b64_json?: string;
        image?: string;
        data?: string;
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
    if (item?.type !== "image_generation_call") continue;
    const result = item.result;
    const image =
      typeof result === "string"
        ? result
        : result?.b64_json || result?.image || result?.data;

    if (!image) continue;

    return {
      dataUrl: normalizeBase64Image(image, fallbackMime),
      revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
      actualParams: mergeActualParams(pickActualParams(item), { n: 1 })
    };
  }

  throw new Error("OpenAI Responses 接口没有返回可用图片。");
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

  let response: Response;

  if (isEdit) {
    const formData = new FormData();
    formData.append("model", providerConfig.imageModel);
    formData.append("prompt", prompt);
    formData.append("size", params.size);
    formData.append("output_format", params.output_format);
    formData.append("moderation", params.moderation);
    formData.append("n", "1");

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

    response = await fetch(`${providerConfig.baseUrl}/images/edits`, {
      method: "POST",
      headers: createAuthHeaders(apiKey),
      cache: "no-store",
      body: formData,
      signal
    });
  } else {
    const body: Record<string, unknown> = {
      model: providerConfig.imageModel,
      prompt,
      size: params.size,
      output_format: params.output_format,
      moderation: params.moderation,
      n: 1
    };

    if (mode !== "codex") {
      body.quality = params.quality;
    }

    if (params.output_format !== "png" && params.output_compression != null) {
      body.output_compression = params.output_compression;
    }

    response = await fetch(`${providerConfig.baseUrl}/images/generations`, {
      method: "POST",
      headers: createJsonHeaders(apiKey),
      cache: "no-store",
      body: JSON.stringify(body),
      signal
    });
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(normalizeOpenAIError(payload, `OpenAI 生图接口错误：${response.status}`));
  }

  return parseImagesApiPayload(payload, fallbackMime, signal);
}

async function callResponsesApi(opts: CallImageOptions, mode: CompatibilityMode): Promise<ImageApiResult> {
  const { providerConfig, prompt, params, inputImageDataUrls, maskDataUrl, signal } = opts;
  const apiKey = getRotatedApiKey(providerConfig);
  if (!apiKey) throw new Error("请先配置 API 密钥。");

  const fallbackMime = MIME_MAP[params.output_format] || "image/png";
  const response = await fetch(`${providerConfig.baseUrl}/responses`, {
    method: "POST",
    headers: createJsonHeaders(apiKey),
    cache: "no-store",
    body: JSON.stringify({
      model: providerConfig.responsesImageModel,
      input: createResponsesInput(prompt, inputImageDataUrls),
      tools: [createResponsesImageTool(params, inputImageDataUrls.length > 0, mode, maskDataUrl)],
      tool_choice: "required"
    }),
    signal
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(normalizeOpenAIError(payload, `OpenAI Responses 生图接口错误：${response.status}`));
  }

  return parseResponsesImagePayload(payload, fallbackMime);
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
