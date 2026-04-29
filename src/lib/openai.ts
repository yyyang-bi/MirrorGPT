import { ProviderConfig, readProviderConfig } from "@/lib/provider-config";

const globalForOpenAI = globalThis as unknown as {
  openaiKeyRotation?: Record<string, number>;
};

export function getOpenAIConfig() {
  return readProviderConfig();
}

export function getRotatedApiKey(config?: ProviderConfig) {
  const providerConfig = config ?? getOpenAIConfig();
  const keys = providerConfig.apiKeys.map((item) => item.trim()).filter(Boolean);

  if (keys.length === 0) return "";
  if (keys.length === 1) return keys[0];

  if (!globalForOpenAI.openaiKeyRotation) {
    globalForOpenAI.openaiKeyRotation = {};
  }

  const scope = `${providerConfig.baseUrl}|${keys.join(",")}`;
  const nextIndex = ((globalForOpenAI.openaiKeyRotation[scope] ?? -1) + 1) % keys.length;
  globalForOpenAI.openaiKeyRotation[scope] = nextIndex;

  return keys[nextIndex];
}

export function getOpenAIHeaders(config?: ProviderConfig) {
  const providerConfig = config ?? getOpenAIConfig();
  const apiKey = getRotatedApiKey(providerConfig);
  if (!apiKey) return null;

  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
}

export function normalizeOpenAIError(payload: unknown, fallback = "OpenAI 接口调用失败") {
  if (typeof payload === "string") return payload || fallback;
  if (!payload || typeof payload !== "object") return fallback;

  const maybeError = payload as {
    error?: {
      message?: string;
    };
    message?: string;
  };

  return maybeError.error?.message || maybeError.message || fallback;
}
