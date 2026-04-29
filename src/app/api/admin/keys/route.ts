import { AUTH_COOKIE, authCookieOptions, makeAccessToken, requireAdmin } from "@/lib/auth";
import { createAccessKey, deleteAccessKey, readAuthConfig, updateAccessKey } from "@/lib/key-config";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  return NextResponse.json({
    keys: readAuthConfig().keys
  });
}

export async function POST(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => null)) as {
    name?: string;
    remark?: string;
    maxUses?: number;
  } | null;

  const key = createAccessKey({
    name: body?.name,
    remark: body?.remark,
    maxUses: body?.maxUses
  });

  return NextResponse.json(
    {
      key
    },
    { status: 201 }
  );
}

export async function PATCH(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => null)) as {
    id?: string;
    name?: string;
    remark?: string;
    enabled?: boolean;
    maxUses?: number;
    resetUsedCount?: boolean;
  } | null;

  if (!body?.id) {
    return NextResponse.json(
      {
        error: "缺少密钥 ID。"
      },
      { status: 400 }
    );
  }

  const key = updateAccessKey(body.id, body);

  if (!key) {
    return NextResponse.json(
      {
        error: "密钥不存在。"
      },
      { status: 404 }
    );
  }

  return NextResponse.json({
    key
  });
}

export async function PUT(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => null)) as {
    id?: string;
  } | null;

  if (!body?.id) {
    return NextResponse.json(
      {
        error: "缺少密钥 ID。"
      },
      { status: 400 }
    );
  }

  const key = readAuthConfig().keys.find((item) => item.id === body.id);

  if (!key) {
    return NextResponse.json(
      {
        error: "密钥不存在。"
      },
      { status: 404 }
    );
  }

  if (!key.enabled) {
    return NextResponse.json(
      {
        error: "该访问密钥已停用，不能用于聊天室。"
      },
      { status: 400 }
    );
  }

  if (key.maxUses > 0 && key.usedCount >= key.maxUses) {
    return NextResponse.json(
      {
        error: "该访问密钥的可用对话次数已用完。"
      },
      { status: 400 }
    );
  }

  const response = NextResponse.json({
    ok: true,
    key
  });

  response.cookies.set(AUTH_COOKIE, makeAccessToken(key.key), authCookieOptions);

  return response;
}

export async function DELETE(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => null)) as {
    id?: string;
  } | null;

  if (!body?.id) {
    return NextResponse.json(
      {
        error: "缺少密钥 ID。"
      },
      { status: 400 }
    );
  }

  const ok = deleteAccessKey(body.id);

  if (!ok) {
    return NextResponse.json(
      {
        error: "密钥不存在。"
      },
      { status: 404 }
    );
  }

  return NextResponse.json({
    ok: true
  });
}
