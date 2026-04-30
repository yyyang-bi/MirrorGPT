import { requireAccessPrincipal } from "@/lib/auth";
import { consumeAccessKeyDialog, refundAccessKeyDialog } from "@/lib/key-config";
import { callImageGenerationApi, getImageGenerationErrorStatus, normalizeImageParams } from "@/lib/image-api";
import {
  getOpenAIConfig
} from "@/lib/openai";
import { prisma } from "@/lib/prisma";
import {
  estimateDataUrlBytes,
  formatBytes,
  getTextLengthError,
  MAX_GENERATED_IMAGE_BYTES,
  MAX_IMAGE_INPUT_BYTES,
  MAX_IMAGE_INPUT_TOTAL_BYTES,
  MAX_IMAGE_PROMPT_CHARS,
  MAX_IMAGE_REQUEST_BYTES,
  readJsonBodyWithLimit
} from "@/lib/request-limits";
import { ensureSession, titleFromText } from "@/lib/sessions";
import crypto from "crypto";
import fs from "fs/promises";
import { NextRequest, NextResponse } from "next/server";
import path from "path";

export const runtime = "nodejs";

type ImageBody = {
  sessionId?: string;
  prompt?: string;
  size?: string;
  model?: string;
  params?: unknown;
  inputImageDataUrls?: unknown;
  maskDataUrl?: unknown;
};

const ALLOWED_INPUT_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const GENERATED_IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
};

function normalizeInputImages(value: unknown) {
  if (!Array.isArray(value)) return { images: [] as string[] };
  if (value.length > 16) {
    return {
      images: [] as string[],
      error: "参考图数量过多，最多支持 16 张。"
    };
  }

  let totalBytes = 0;
  const images: string[] = [];

  for (const item of value) {
    const dataUrl = typeof item === "string" ? item.trim() : "";
    if (!dataUrl) continue;
    if (!dataUrl.startsWith("data:image/")) {
      return {
        images: [] as string[],
        error: "参考图必须是 data:image/* 格式。"
      };
    }

    const info = estimateDataUrlBytes(dataUrl);
    if (!info || !ALLOWED_INPUT_IMAGE_MIMES.has(info.mime.toLowerCase())) {
      return {
        images: [] as string[],
        error: "参考图格式仅支持 PNG、JPEG、WEBP 或 GIF。"
      };
    }

    if (info.bytes > MAX_IMAGE_INPUT_BYTES) {
      return {
        images: [] as string[],
        error: `单张参考图过大，最大允许 ${formatBytes(MAX_IMAGE_INPUT_BYTES)}。`
      };
    }

    totalBytes += info.bytes;
    if (totalBytes > MAX_IMAGE_INPUT_TOTAL_BYTES) {
      return {
        images: [] as string[],
        error: `参考图总大小过大，最大允许 ${formatBytes(MAX_IMAGE_INPUT_TOTAL_BYTES)}。`
      };
    }

    images.push(dataUrl);
  }

  return { images };
}

function createImageRequestId() {
  return `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getDataUrlMime(dataUrl: string) {
  return dataUrl.match(/^data:([^;,]+)/)?.[1] || "unknown";
}

async function persistGeneratedImage(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+)?;base64,([\s\S]+)$/);
  if (!match) throw new Error("生图结果不是可保存的 base64 data URL。");

  const mime = (match[1] || "image/png").toLowerCase();
  const extension = GENERATED_IMAGE_MIME_EXTENSIONS[mime] || "png";
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");

  if (bytes.byteLength > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error(`生图结果过大，最大允许 ${formatBytes(MAX_GENERATED_IMAGE_BYTES)}。`);
  }

  const outputDir = path.join(process.cwd(), "public", "generated-images");
  const fileName = `${Date.now().toString(36)}-${crypto.randomUUID()}.${extension}`;

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, fileName), bytes);

  return `/generated-images/${fileName}`;
}

function getGeneratedImageFilePath(imageUrl: string) {
  if (!imageUrl.startsWith("/generated-images/")) return null;
  return path.join(process.cwd(), "public", imageUrl.slice(1));
}

async function deletePersistedGeneratedImage(imageUrl: string) {
  const filePath = getGeneratedImageFilePath(imageUrl);
  if (!filePath) return;

  await fs.unlink(filePath).catch(() => undefined);
}

export async function POST(request: NextRequest) {
  const requestId = createImageRequestId();
  const principal = requireAccessPrincipal(request);
  if (principal instanceof NextResponse) return principal;

  const parsedBody = await readJsonBodyWithLimit<ImageBody>(request, MAX_IMAGE_REQUEST_BYTES);
  if (parsedBody.error) {
    return NextResponse.json(
      {
        error: parsedBody.error
      },
      { status: parsedBody.status || 400 }
    );
  }

  const body = parsedBody.body;
  const prompt = body?.prompt?.trim();

  if (!prompt) {
    return NextResponse.json(
      {
        error: "生图提示词不能为空。"
      },
      { status: 400 }
    );
  }

  const promptLengthError = getTextLengthError("生图提示词", prompt, MAX_IMAGE_PROMPT_CHARS);
  if (promptLengthError) {
    return NextResponse.json(
      {
        error: promptLengthError
      },
      { status: 400 }
    );
  }

  const providerConfig = getOpenAIConfig();
  if (providerConfig.apiKeys.length === 0) {
    return NextResponse.json(
      {
        error: "服务端尚未配置 OPENAI_API_KEY，已完成页面和接口预留，请配置密钥后再发起在线生图。"
      },
      { status: 500 }
    );
  }

  let session;

  try {
    session = await ensureSession(principal.ownerId, body?.sessionId, titleFromText(prompt, "画图："));
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "会话不存在。"
      },
      { status: 404 }
    );
  }

  const reservedUsage = consumeAccessKeyDialog(principal.keyId);
  if (!reservedUsage.ok) {
    return NextResponse.json(
      {
        error: reservedUsage.error
      },
      { status: reservedUsage.status }
    );
  }

  const refundReservedUsage = (reason: string) => {
    try {
      refundAccessKeyDialog(principal.keyId);
    } catch (error) {
      console.error("[api/images] refund_failed", {
        requestId,
        sessionId: session.id,
        reason,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const normalizedInputImages = normalizeInputImages(body?.inputImageDataUrls);
  if (normalizedInputImages.error) {
    refundReservedUsage("invalid_input_images");
    return NextResponse.json(
      {
        error: normalizedInputImages.error
      },
      { status: 400 }
    );
  }

  const inputImageDataUrls = normalizedInputImages.images;
  // 遮罩功能先下线：保留请求字段兼容旧客户端，但当前服务端不再转发 mask。
  const maskDataUrl = undefined;
  const params = normalizeImageParams(body?.params, body?.size);
  const effectiveProviderConfig = {
    ...providerConfig,
    imageModel: providerConfig.imageModel
  };

  console.info("[api/images] start", {
    requestId,
    sessionId: session.id,
    apiMode: effectiveProviderConfig.imageApiMode,
    baseUrl: effectiveProviderConfig.baseUrl,
    imageModel: effectiveProviderConfig.imageModel,
    responsesImageModel: effectiveProviderConfig.responsesImageModel,
    compatibilityMode: effectiveProviderConfig.imageCompatibilityMode,
    size: params.size,
    quality: params.quality,
    outputFormat: params.output_format,
    inputImageCount: inputImageDataUrls.length,
    hasReferenceImages: inputImageDataUrls.length > 0,
    hasMask: Boolean(maskDataUrl)
  });

  let result: Awaited<ReturnType<typeof callImageGenerationApi>>;
  try {
    result = await callImageGenerationApi({
      providerConfig: effectiveProviderConfig,
      prompt,
      params,
      inputImageDataUrls,
      maskDataUrl,
      signal: request.signal,
      requestId
    });
  } catch (error) {
    if (request.signal.aborted) {
      return new Response(null, { status: 499 });
    }

    refundReservedUsage("upstream_failed");

    console.error("[api/images] failed", {
      requestId,
      sessionId: session.id,
      apiMode: effectiveProviderConfig.imageApiMode,
      message: error instanceof Error ? error.message : String(error)
    });

    const errorMessage = error instanceof Error ? error.message : "OpenAI 生图失败。";
    const clientMessage =
      errorMessage.startsWith("OpenAI 生图失败") || errorMessage.startsWith("生图")
        ? errorMessage
        : `OpenAI 生图失败：${errorMessage}`;

    return NextResponse.json(
      {
        error: clientMessage
      },
      { status: getImageGenerationErrorStatus(error) }
    );
  }

  if (request.signal.aborted) {
    return new Response(null, { status: 499 });
  }

  console.info("[api/images] success", {
    requestId,
    sessionId: session.id,
    apiMode: effectiveProviderConfig.imageApiMode,
    dataUrlMime: getDataUrlMime(result.dataUrl),
    hasRevisedPrompt: Boolean(result.revisedPrompt)
  });

  let imageUrl = "";
  let userMessage;
  let generatedImage;
  let assistantMessage;

  try {
    imageUrl = await persistGeneratedImage(result.dataUrl);

    [userMessage, generatedImage, assistantMessage] = await prisma.$transaction([
      prisma.message.create({
        data: {
          sessionId: session.id,
          role: "user",
          kind: "text",
          content: prompt
        }
      }),
      prisma.generatedImage.create({
        data: {
          sessionId: session.id,
          prompt,
          imageUrl,
          revisedPrompt: result.revisedPrompt
        }
      }),
      prisma.message.create({
        data: {
          sessionId: session.id,
          role: "assistant",
          kind: "image",
          content: result.revisedPrompt || prompt,
          imageUrl
        }
      }),
      prisma.chatSession.update({
        where: {
          id: session.id
        },
        data: {
          ...(session.title === "新会话" ? { title: titleFromText(prompt, "画图：") } : {}),
          updatedAt: new Date()
        }
      })
    ]);
  } catch (error) {
    if (imageUrl) {
      await deletePersistedGeneratedImage(imageUrl);
    }
    refundReservedUsage("persist_failed");

    console.error("[api/images] persist_failed", {
      requestId,
      sessionId: session.id,
      message: error instanceof Error ? error.message : String(error)
    });

    return NextResponse.json(
      {
        error: error instanceof Error ? `图片保存失败：${error.message}` : "图片保存失败。"
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    sessionId: session.id,
    userMessage,
    assistantMessage,
    image: generatedImage,
    actualParams: result.actualParams
  });
}
