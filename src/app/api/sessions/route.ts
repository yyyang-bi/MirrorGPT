import { requireAccessPrincipal } from "@/lib/auth";
import { readAuthConfig } from "@/lib/key-config";
import { readProviderConfig } from "@/lib/provider-config";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function isEmptyNewSession(session: { title: string; _count: { messages: number } }) {
  return session.title === "新会话" && session._count.messages === 0;
}

function hideDuplicateEmptyNewSessions<T extends { title: string; _count: { messages: number } }>(sessions: T[]) {
  let hasEmptyNewSession = false;

  return sessions.filter((session) => {
    if (!isEmptyNewSession(session)) return true;
    if (hasEmptyNewSession) return false;
    hasEmptyNewSession = true;
    return true;
  });
}

export async function GET(request: NextRequest) {
  const principal = requireAccessPrincipal(request);
  if (principal instanceof NextResponse) return principal;
  const accessKey = readAuthConfig().keys.find((key) => key.id === principal.keyId);
  const providerConfig = readProviderConfig();

  const sessions = await prisma.chatSession.findMany({
    where: {
      ownerId: principal.ownerId
    },
    orderBy: {
      updatedAt: "desc"
    },
    include: {
      _count: {
        select: {
          messages: true
        }
      }
    }
  });

  const visibleSessions = hideDuplicateEmptyNewSessions(sessions);

  return NextResponse.json({
    providerModels: {
      chatModel: providerConfig.chatModel,
      imageModel: providerConfig.imageApiMode === "responses" ? providerConfig.responsesImageModel : providerConfig.imageModel,
      imagesModel: providerConfig.imageModel,
      responsesImageModel: providerConfig.responsesImageModel,
      imageApiMode: providerConfig.imageApiMode
    },
    accessKey: accessKey
      ? {
          id: accessKey.id,
          name: accessKey.name,
          remark: accessKey.remark,
          maxUses: accessKey.maxUses,
          usedCount: accessKey.usedCount,
          remaining: accessKey.maxUses === 0 ? null : Math.max(0, accessKey.maxUses - accessKey.usedCount),
          lastUsedAt: accessKey.lastUsedAt
        }
      : null,
    sessions: visibleSessions.map((session) => ({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session._count.messages
    }))
  });
}

export async function POST(request: NextRequest) {
  const principal = requireAccessPrincipal(request);
  if (principal instanceof NextResponse) return principal;

  const body = (await request.json().catch(() => null)) as {
    title?: string;
  } | null;
  const title = body?.title?.trim() || "新会话";

  if (title === "新会话") {
    const existingEmptySession = await prisma.chatSession.findFirst({
      where: {
        ownerId: principal.ownerId,
        title: "新会话",
        messages: {
          none: {}
        }
      },
      orderBy: {
        updatedAt: "desc"
      }
    });

    if (existingEmptySession) {
      return NextResponse.json({
        session: existingEmptySession
      });
    }
  }

  const session = await prisma.chatSession.create({
    data: {
      ownerId: principal.ownerId,
      title
    }
  });

  return NextResponse.json(
    {
      session
    },
    { status: 201 }
  );
}
