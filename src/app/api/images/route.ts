import { requireAccessPrincipal } from "@/lib/auth";
import { checkAccessKeyDialog, consumeAccessKeyDialog } from "@/lib/key-config";
import { callImageGenerationApi, normalizeImageParams } from "@/lib/image-api";
import {
  getOpenAIConfig
} from "@/lib/openai";
import { prisma } from "@/lib/prisma";
import { ensureSession, titleFromText } from "@/lib/sessions";
import { NextRequest, NextResponse } from "next/server";

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

function normalizeInputImages(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.startsWith("data:image/"))
    .slice(0, 16);
}

export async function POST(request: NextRequest) {
  const principal = requireAccessPrincipal(request);
  if (principal instanceof NextResponse) return principal;

  const body = (await request.json().catch(() => null)) as ImageBody | null;
  const prompt = body?.prompt?.trim();

  if (!prompt) {
    return NextResponse.json(
      {
        error: "生图提示词不能为空。"
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

  const usage = checkAccessKeyDialog(principal.keyId);
  if (!usage.ok) {
    return NextResponse.json(
      {
        error: usage.error
      },
      { status: usage.status }
    );
  }

  const inputImageDataUrls = normalizeInputImages(body?.inputImageDataUrls);
  // 遮罩功能先下线：保留请求字段兼容旧客户端，但当前服务端不再转发 mask。
  const maskDataUrl = undefined;
  const params = normalizeImageParams(body?.params, body?.size);

  let result: Awaited<ReturnType<typeof callImageGenerationApi>>;
  try {
    result = await callImageGenerationApi({
      providerConfig: {
        ...providerConfig,
        imageModel: body?.model?.trim() || providerConfig.imageModel
      },
      prompt,
      params,
      inputImageDataUrls,
      maskDataUrl,
      signal: request.signal
    });
  } catch (error) {
    if (request.signal.aborted) {
      return new Response(null, { status: 499 });
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? `OpenAI 生图失败：${error.message}` : "OpenAI 生图失败。"
      },
      { status: 502 }
    );
  }

  if (request.signal.aborted) {
    return new Response(null, { status: 499 });
  }

  const committedUsage = consumeAccessKeyDialog(principal.keyId);
  if (!committedUsage.ok) {
    return NextResponse.json(
      {
        error: committedUsage.error
      },
      { status: committedUsage.status }
    );
  }

  const userMessage = await prisma.message.create({
    data: {
      sessionId: session.id,
      role: "user",
      kind: "text",
      content: prompt
    }
  });

  const generatedImage = await prisma.generatedImage.create({
    data: {
      sessionId: session.id,
      prompt,
      imageUrl: result.dataUrl,
      revisedPrompt: result.revisedPrompt
    }
  });

  const assistantMessage = await prisma.message.create({
    data: {
      sessionId: session.id,
      role: "assistant",
      kind: "image",
      content: result.revisedPrompt || prompt,
      imageUrl: result.dataUrl
    }
  });

  await prisma.chatSession.update({
    where: {
      id: session.id
    },
    data: {
      ...(session.title === "新会话" ? { title: titleFromText(prompt, "画图：") } : {}),
      updatedAt: new Date()
    }
  });

  return NextResponse.json({
    sessionId: session.id,
    userMessage,
    assistantMessage,
    image: generatedImage,
    actualParams: result.actualParams
  });
}
