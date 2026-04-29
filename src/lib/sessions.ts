import { prisma } from "@/lib/prisma";

export function titleFromText(text: string, prefix = "") {
  const normalized = text.replace(/\s+/g, " ").trim();
  const clipped = normalized.length > 26 ? `${normalized.slice(0, 26)}…` : normalized;
  return `${prefix}${clipped || "新会话"}`;
}

export async function ensureSession(ownerId: string, sessionId?: string | null, fallbackTitle = "新会话") {
  if (sessionId) {
    const session = await prisma.chatSession.findFirst({
      where: {
        id: sessionId,
        ownerId
      }
    });

    if (!session) {
      throw new Error("会话不存在或已被删除。");
    }

    return session;
  }

  return prisma.chatSession.create({
    data: {
      ownerId,
      title: fallbackTitle
    }
  });
}
