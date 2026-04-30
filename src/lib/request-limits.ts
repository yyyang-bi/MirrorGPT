import { NextRequest } from "next/server";

export const MAX_LOGIN_REQUEST_BYTES = 4 * 1024;
export const MAX_CHAT_REQUEST_BYTES = 256 * 1024;
export const MAX_IMAGE_REQUEST_BYTES = 24 * 1024 * 1024;

export const MAX_CHAT_MESSAGE_CHARS = 12_000;
export const MAX_CHAT_HISTORY_MESSAGES = 40;
export const MAX_IMAGE_PROMPT_CHARS = 4_000;
export const MAX_IMAGE_INPUT_BYTES = 6 * 1024 * 1024;
export const MAX_IMAGE_INPUT_TOTAL_BYTES = 18 * 1024 * 1024;
export const MAX_GENERATED_IMAGE_BYTES = 16 * 1024 * 1024;

export function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / 1024 / 1024) * 10) / 10}MB`;
  if (bytes >= 1024) return `${Math.round((bytes / 1024) * 10) / 10}KB`;
  return `${bytes}B`;
}

export function getRequestBodySizeError(request: NextRequest, maxBytes: number) {
  const contentLength = request.headers.get("content-length");
  if (!contentLength) return "";

  const size = Number(contentLength);
  if (!Number.isFinite(size) || size < 0) return "请求体大小不合法。";
  if (size > maxBytes) return `请求体过大，最大允许 ${formatBytes(maxBytes)}。`;

  return "";
}

async function readRequestTextWithLimit(request: NextRequest, maxBytes: number) {
  const earlySizeError = getRequestBodySizeError(request, maxBytes);
  if (earlySizeError) {
    return {
      text: "",
      error: earlySizeError,
      status: 413
    };
  }

  if (!request.body) {
    return {
      text: ""
    };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return {
          text: "",
          error: `请求体过大，最大允许 ${formatBytes(maxBytes)}。`,
          status: 413
        };
      }

      text += decoder.decode(value, { stream: true });
    }

    text += decoder.decode();
  } catch {
    return {
      text: "",
      error: "请求体读取失败。",
      status: 400
    };
  }

  return {
    text
  };
}

export async function readJsonBodyWithLimit<T>(request: NextRequest, maxBytes: number) {
  const result = await readRequestTextWithLimit(request, maxBytes);
  if (result.error) {
    return {
      body: null,
      error: result.error,
      status: result.status
    };
  }

  if (!result.text.trim()) {
    return {
      body: null
    };
  }

  try {
    return {
      body: JSON.parse(result.text) as T
    };
  } catch {
    return {
      body: null
    };
  }
}

export function getTextLengthError(label: string, value: string, maxChars: number) {
  return value.length > maxChars ? `${label}过长，最多 ${maxChars} 个字符。` : "";
}

export function estimateDataUrlBytes(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!match) return null;

  const mime = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || "";
  let bytes: number;

  try {
    bytes = isBase64
      ? Math.floor(payload.replace(/\s/g, "").length * 3 / 4)
      : Buffer.byteLength(decodeURIComponent(payload), "utf8");
  } catch {
    return null;
  }

  return {
    mime,
    bytes
  };
}
