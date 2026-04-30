import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { readAuthConfig } from "@/lib/key-config";

export const AUTH_COOKIE = "cgpt_mirror_auth";
export const ADMIN_COOKIE = "cgpt_mirror_admin";

const COOKIE_PREFIX = "chatgpt-image-web:";

export function hashSecret(scope: "admin" | "access", secret: string) {
  return crypto.createHash("sha256").update(`${COOKIE_PREFIX}${scope}:${secret}`).digest("hex");
}

export function safeCompare(left: string, right: string) {
  if (!left || !right) return false;

  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function makeAdminToken(adminPassword?: string) {
  const config = readAuthConfig();
  const secret = adminPassword ?? config.adminPassword;
  return secret ? hashSecret("admin", secret) : "";
}

export function makeAccessToken(accessKey: string) {
  return accessKey ? hashSecret("access", accessKey) : "";
}

export function verifyAuthToken(token?: string) {
  if (!token) return false;

  if (verifyAdminToken(token)) return true;

  return verifyAccessToken(token);
}

export function verifyAccessToken(token?: string) {
  if (!token) return false;

  const config = readAuthConfig();
  return config.keys.some((item) => item.enabled && safeCompare(token, makeAccessToken(item.key)));
}

export function verifyAdminToken(token?: string) {
  if (!token) return false;
  const adminToken = makeAdminToken();
  return Boolean(adminToken) && safeCompare(token, adminToken);
}

export type AuthPrincipal =
  | {
      role: "admin";
      ownerId: "admin";
    }
  | {
      role: "user";
      ownerId: string;
      keyId: string;
      keyName: string;
    };

export function getAuthPrincipal(request: NextRequest): AuthPrincipal | null {
  const authToken = request.cookies.get(AUTH_COOKIE)?.value;
  const adminToken = request.cookies.get(ADMIN_COOKIE)?.value;

  if (verifyAdminToken(adminToken) && verifyAdminToken(authToken)) {
    return {
      role: "admin",
      ownerId: "admin"
    };
  }

  if (!authToken) return null;

  const config = readAuthConfig();
  const key = config.keys.find((item) => item.enabled && safeCompare(authToken, makeAccessToken(item.key)));

  if (!key) return null;

  return {
    role: "user",
    ownerId: `key:${key.id}`,
    keyId: key.id,
    keyName: key.name
  };
}

export type AccessPrincipal = Extract<AuthPrincipal, { role: "user" }>;

export function getAccessPrincipal(request: NextRequest): AccessPrincipal | null {
  const authToken = request.cookies.get(AUTH_COOKIE)?.value;
  if (!authToken) return null;

  const config = readAuthConfig();
  const key = config.keys.find((item) => item.enabled && safeCompare(authToken, makeAccessToken(item.key)));

  if (!key) return null;

  return {
    role: "user",
    ownerId: `key:${key.id}`,
    keyId: key.id,
    keyName: key.name
  };
}

export function isAuthenticated(request: NextRequest) {
  return Boolean(getAuthPrincipal(request));
}

export function isAdmin(request: NextRequest) {
  return verifyAdminToken(request.cookies.get(ADMIN_COOKIE)?.value);
}

export function requireAuth(request: NextRequest) {
  if (isAuthenticated(request)) return null;

  return NextResponse.json(
    {
      error: "未登录或登录已过期，请重新输入访问密钥。"
    },
    { status: 401 }
  );
}

export function requireAuthPrincipal(request: NextRequest): AuthPrincipal | NextResponse {
  const principal = getAuthPrincipal(request);
  if (principal) return principal;

  return NextResponse.json(
    {
      error: "未登录或登录已过期，请重新输入访问密钥。"
    },
    { status: 401 }
  );
}

export function requireAccessPrincipal(request: NextRequest): AccessPrincipal | NextResponse {
  const principal = getAccessPrincipal(request);
  if (principal) return principal;

  return NextResponse.json(
    {
      error: "请先选择或输入访问密钥后再使用聊天室。"
    },
    { status: 401 }
  );
}

export function requireAdmin(request: NextRequest) {
  if (isAdmin(request)) return null;

  return NextResponse.json(
    {
      error: "需要管理员权限，请输入管理密码。"
    },
    { status: 403 }
  );
}

export type LoginResult =
  | {
      ok: true;
      role: "admin";
      authToken: string;
      adminToken: string;
    }
  | {
      ok: true;
      role: "user";
      authToken: string;
      keyId: string;
    }
  | {
      ok: false;
      error: string;
      status: number;
    };

export function loginWithCredential(input: string): LoginResult {
  const credential = input.trim();
  if (!credential) {
    return {
      ok: false,
      error: "请输入访问密钥或管理密码。",
      status: 400
    };
  }

  const config = readAuthConfig();

  if (config.adminPassword && safeCompare(credential, config.adminPassword)) {
    const adminToken = makeAdminToken(config.adminPassword);
    return {
      ok: true,
      role: "admin",
      authToken: adminToken,
      adminToken
    };
  }

  const key = config.keys.find((item) => safeCompare(credential, item.key));

  if (!key) {
    return {
      ok: false,
      error: "访问密钥或管理密码不正确。",
      status: 401
    };
  }

  if (!key.enabled) {
    return {
      ok: false,
      error: "该访问密钥已停用。",
      status: 403
    };
  }

  return {
    ok: true,
    role: "user",
    authToken: makeAccessToken(key.key),
    keyId: key.id
  };
}

function getCookieSecure() {
  const configured = process.env.AUTH_COOKIE_SECURE ?? process.env.COOKIE_SECURE;
  if (configured !== undefined) {
    return ["1", "true", "yes", "on"].includes(configured.trim().toLowerCase());
  }

  return process.env.NODE_ENV === "production";
}

export const authCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: getCookieSecure(),
  path: "/",
  maxAge: 60 * 60 * 24 * 30
};
