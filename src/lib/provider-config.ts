import fs from "fs";
import path from "path";

export type ProviderConfig = {
  apiKeys: string[];
  baseUrl: string;
  chatModel: string;
  imageModel: string;
  responsesImageModel: string;
  imageApiMode: "images" | "responses";
  imageCompatibilityMode: "auto" | "standard" | "codex";
};

export const PROVIDER_CONFIG_PATH = path.join(process.cwd(), "config", "openai.json");

const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  apiKeys: process.env.OPENAI_API_KEY?.trim() ? [process.env.OPENAI_API_KEY.trim()] : [],
  baseUrl: process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
  chatModel: process.env.OPENAI_CHAT_MODEL?.trim() || "gpt-5.5",
  imageModel: process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2",
  responsesImageModel: process.env.OPENAI_RESPONSES_IMAGE_MODEL?.trim() || "gpt-5.5",
  imageApiMode: "images",
  imageCompatibilityMode: "auto"
};

function ensureConfigFile() {
  const dir = path.dirname(PROVIDER_CONFIG_PATH);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(PROVIDER_CONFIG_PATH)) {
    fs.writeFileSync(PROVIDER_CONFIG_PATH, `${JSON.stringify(DEFAULT_PROVIDER_CONFIG, null, 2)}\n`, "utf8");
  }
}

export function normalizeBaseUrl(input?: string) {
  const value = (input || DEFAULT_PROVIDER_CONFIG.baseUrl).trim().replace(/\/+$/, "");
  if (!value) return "https://api.openai.com/v1";

  const v1Index = value.search(/\/v1(?:\/|$)/);
  if (v1Index >= 0) {
    return value.slice(0, v1Index + 3);
  }

  return `${value}/v1`;
}

export function parseApiKeys(input: unknown) {
  if (Array.isArray(input)) {
    return input
      .map((item) => String(item).trim())
      .filter(Boolean);
  }

  if (typeof input === "string") {
    return input
      .split(/[,\n\r]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeProviderConfig(input: Partial<ProviderConfig> | null | undefined): ProviderConfig {
  const apiKeys = parseApiKeys(input?.apiKeys);
  const imageApiMode = input?.imageApiMode === "responses" ? "responses" : DEFAULT_PROVIDER_CONFIG.imageApiMode;
  const imageCompatibilityMode =
    input?.imageCompatibilityMode === "standard" || input?.imageCompatibilityMode === "codex"
      ? input.imageCompatibilityMode
      : DEFAULT_PROVIDER_CONFIG.imageCompatibilityMode;

  return {
    apiKeys,
    baseUrl: normalizeBaseUrl(input?.baseUrl),
    chatModel: input?.chatModel?.trim() || DEFAULT_PROVIDER_CONFIG.chatModel,
    imageModel: input?.imageModel?.trim() || DEFAULT_PROVIDER_CONFIG.imageModel,
    responsesImageModel: input?.responsesImageModel?.trim() || DEFAULT_PROVIDER_CONFIG.responsesImageModel,
    imageApiMode,
    imageCompatibilityMode
  };
}

export function readProviderConfig(): ProviderConfig {
  ensureConfigFile();

  try {
    const raw = fs.readFileSync(PROVIDER_CONFIG_PATH, "utf8");
    return normalizeProviderConfig(JSON.parse(raw) as Partial<ProviderConfig>);
  } catch {
    return DEFAULT_PROVIDER_CONFIG;
  }
}

export function writeProviderConfig(config: ProviderConfig) {
  ensureConfigFile();
  const normalized = normalizeProviderConfig(config);
  fs.writeFileSync(PROVIDER_CONFIG_PATH, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}
