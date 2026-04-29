import { requireAdmin } from "@/lib/auth";
import { getOpenAIHeaders, normalizeOpenAIError } from "@/lib/openai";
import {
  normalizeBaseUrl,
  parseApiKeys,
  PROVIDER_CONFIG_PATH,
  ProviderConfig,
  readProviderConfig,
  writeProviderConfig
} from "@/lib/provider-config";
import { NextRequest, NextResponse } from "next/server";
import path from "path";

export const runtime = "nodejs";

function publicProviderConfig() {
  const config = readProviderConfig();

  return {
    ...config,
    configPath: path.relative(process.cwd(), PROVIDER_CONFIG_PATH)
  };
}

function normalizeRequestBody(body: {
  apiKeys?: string[] | string;
  apiKeysText?: string;
  baseUrl?: string;
  chatModel?: string;
  imageModel?: string;
  responsesImageModel?: string;
  imageApiMode?: "images" | "responses";
  imageCompatibilityMode?: "auto" | "standard" | "codex";
} | null): ProviderConfig {
  const current = readProviderConfig();
  const apiKeys =
    body?.apiKeysText !== undefined
      ? parseApiKeys(body.apiKeysText)
      : body?.apiKeys !== undefined
        ? parseApiKeys(body.apiKeys)
        : current.apiKeys;

  return {
    apiKeys,
    baseUrl: normalizeBaseUrl(body?.baseUrl || current.baseUrl),
    chatModel: body?.chatModel?.trim() || current.chatModel,
    imageModel: body?.imageModel?.trim() || current.imageModel,
    responsesImageModel: body?.responsesImageModel?.trim() || current.responsesImageModel,
    imageApiMode: body?.imageApiMode === "responses" ? "responses" : current.imageApiMode,
    imageCompatibilityMode:
      body?.imageCompatibilityMode === "standard" || body?.imageCompatibilityMode === "codex" || body?.imageCompatibilityMode === "auto"
        ? body.imageCompatibilityMode
        : current.imageCompatibilityMode
  };
}

function normalizeModels(payload: unknown) {
  const data =
    (payload as { data?: unknown[]; models?: unknown[] } | null)?.data ??
    (payload as { data?: unknown[]; models?: unknown[] } | null)?.models ??
    [];

  if (!Array.isArray(data)) return [];

  return data
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "id" in item) {
        return String((item as { id?: unknown }).id || "").trim();
      }
      return "";
    })
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

export async function GET(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  return NextResponse.json({
    provider: publicProviderConfig()
  });
}

export async function PATCH(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => null)) as {
    apiKeys?: string[] | string;
    apiKeysText?: string;
    baseUrl?: string;
    chatModel?: string;
    imageModel?: string;
    responsesImageModel?: string;
    imageApiMode?: "images" | "responses";
    imageCompatibilityMode?: "auto" | "standard" | "codex";
  } | null;

  const provider = writeProviderConfig(normalizeRequestBody(body));

  return NextResponse.json({
    ok: true,
    provider: {
      ...provider,
      configPath: path.relative(process.cwd(), PROVIDER_CONFIG_PATH)
    }
  });
}

export async function POST(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => null)) as {
    apiKeys?: string[] | string;
    apiKeysText?: string;
    baseUrl?: string;
    chatModel?: string;
    imageModel?: string;
    responsesImageModel?: string;
    imageApiMode?: "images" | "responses";
    imageCompatibilityMode?: "auto" | "standard" | "codex";
  } | null;

  const provider = body ? normalizeRequestBody(body) : readProviderConfig();
  const headers = getOpenAIHeaders(provider);

  if (!headers) {
    return NextResponse.json(
      {
        error: "请先配置 API 密钥。"
      },
      { status: 400 }
    );
  }

  try {
    const response = await fetch(`${provider.baseUrl}/models`, {
      method: "GET",
      headers
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      return NextResponse.json(
        {
          error: normalizeOpenAIError(payload, `接口检测失败：${response.status}`)
        },
        { status: 502 }
      );
    }

    const models = normalizeModels(payload);

    return NextResponse.json({
      ok: true,
      message: models.length === 0 ? "接口检测成功。" : `接口检测成功，共返回 ${models.length} 个模型。`,
      models
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? `接口检测失败：${error.message}` : "接口检测失败。"
      },
      { status: 502 }
    );
  }
}
