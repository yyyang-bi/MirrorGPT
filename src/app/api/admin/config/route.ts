import {
  ADMIN_COOKIE,
  authCookieOptions,
  makeAdminToken,
  requireAdmin
} from "@/lib/auth";
import { AUTH_CONFIG_PATH, readAuthConfig, updateAdminPassword } from "@/lib/key-config";
import { NextRequest, NextResponse } from "next/server";
import path from "path";

export const runtime = "nodejs";

function publicConfig() {
  const config = readAuthConfig();

  return {
    configPath: path.relative(process.cwd(), AUTH_CONFIG_PATH),
    keyCount: config.keys.length,
    keys: config.keys
  };
}

export async function GET(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  return NextResponse.json({
    config: publicConfig()
  });
}

export async function PATCH(request: NextRequest) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => null)) as {
    adminPassword?: string;
  } | null;

  if (!body?.adminPassword) {
    return NextResponse.json(
      {
        error: "请输入新的管理密码。"
      },
      { status: 400 }
    );
  }

  try {
    updateAdminPassword(body.adminPassword);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "管理密码更新失败。"
      },
      { status: 400 }
    );
  }

  const adminToken = makeAdminToken(body.adminPassword);
  const response = NextResponse.json({
    ok: true,
    config: publicConfig()
  });

  response.cookies.set(ADMIN_COOKIE, adminToken, authCookieOptions);

  return response;
}
