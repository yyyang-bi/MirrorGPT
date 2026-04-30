import { requireAccessPrincipal } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(request: NextRequest, { params }: RouteContext) {
  const principal = requireAccessPrincipal(request);
  if (principal instanceof NextResponse) return principal;
  const { id } = await params;

  const session = await prisma.chatSession.findFirst({
    where: {
      id,
      ownerId: principal.ownerId
    },
    include: {
      messages: {
        orderBy: {
          createdAt: "asc"
        }
      },
      images: {
        orderBy: {
          createdAt: "desc"
        }
      }
    }
  });

  if (!session) {
    return NextResponse.json(
      {
        error: "会话不存在。"
      },
      { status: 404 }
    );
  }

  return NextResponse.json({
    session
  });
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const principal = requireAccessPrincipal(request);
  if (principal instanceof NextResponse) return principal;
  const { id } = await params;

  const body = (await request.json().catch(() => null)) as {
    title?: string;
  } | null;

  const title = body?.title?.trim();
  if (!title) {
    return NextResponse.json(
      {
        error: "标题不能为空。"
      },
      { status: 400 }
    );
  }

  const existingSession = await prisma.chatSession.findFirst({
    where: {
      id,
      ownerId: principal.ownerId
    }
  });

  if (!existingSession) {
    return NextResponse.json(
      {
        error: "会话不存在。"
      },
      { status: 404 }
    );
  }

  const session = await prisma.chatSession.update({
    where: {
      id: existingSession.id
    },
    data: {
      title
    }
  });

  return NextResponse.json({
    session
  });
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const principal = requireAccessPrincipal(request);
  if (principal instanceof NextResponse) return principal;
  const { id } = await params;

  const result = await prisma.chatSession.deleteMany({
    where: {
      id,
      ownerId: principal.ownerId
    }
  });

  if (result.count === 0) {
    return NextResponse.json(
      {
        error: "会话不存在。"
      },
      { status: 404 }
    );
  }

  return NextResponse.json({
    ok: true
  });
}
