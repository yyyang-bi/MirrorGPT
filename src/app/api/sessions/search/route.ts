import { requireAccessPrincipal } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const principal = requireAccessPrincipal(request);
  if (principal instanceof NextResponse) return principal;

  const query = (request.nextUrl.searchParams.get("q") || "").trim();
  if (!query) {
    return NextResponse.json({
      results: []
    });
  }

  const sessions = await prisma.chatSession.findMany({
    where: {
      ownerId: principal.ownerId,
      OR: [
        {
          title: {
            contains: query
          }
        },
        {
          messages: {
            some: {
              content: {
                contains: query
              }
            }
          }
        }
      ]
    },
    orderBy: {
      updatedAt: "desc"
    },
    take: 30,
    include: {
      _count: {
        select: {
          messages: true
        }
      },
      messages: {
        where: {
          content: {
            contains: query
          }
        },
        orderBy: {
          createdAt: "desc"
        },
        take: 3
      }
    }
  });

  return NextResponse.json({
    results: sessions.map((session) => ({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session._count.messages,
      snippets: session.messages.map((message) => ({
        id: message.id,
        role: message.role,
        kind: message.kind,
        content: message.content,
        createdAt: message.createdAt
      }))
    }))
  });
}
