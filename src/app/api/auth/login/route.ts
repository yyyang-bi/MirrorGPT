import {
  ADMIN_COOKIE,
  authCookieOptions,
  AUTH_COOKIE,
  loginWithCredential
} from "@/lib/auth";
import { clearRateLimit, consumeRateLimit, getClientIp, hashRateLimitValue } from "@/lib/rate-limit";
import { MAX_LOGIN_REQUEST_BYTES, readJsonBodyWithLimit } from "@/lib/request-limits";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const parsedBody = await readJsonBodyWithLimit<{ accessKey?: string }>(request, MAX_LOGIN_REQUEST_BYTES);
  if (parsedBody.error) {
    return NextResponse.json(
      {
        error: parsedBody.error
      },
      { status: parsedBody.status || 400 }
    );
  }
  const body = parsedBody.body;
  const credential = body?.accessKey ?? "";
  const clientIp = getClientIp(request);
  const ipLimit = consumeRateLimit(`login:ip:${clientIp}`, 60, 15 * 60 * 1000);

  if (!ipLimit.ok) {
    return NextResponse.json(
      {
        error: `登录尝试过于频繁，请 ${ipLimit.retryAfter} 秒后再试。`
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(ipLimit.retryAfter)
        }
      }
    );
  }

  const credentialRateKey = `login:credential:${clientIp}:${hashRateLimitValue(credential.trim())}`;
  const credentialLimit = consumeRateLimit(credentialRateKey, 10, 15 * 60 * 1000);

  if (!credentialLimit.ok) {
    return NextResponse.json(
      {
        error: `登录尝试过于频繁，请 ${credentialLimit.retryAfter} 秒后再试。`
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(credentialLimit.retryAfter)
        }
      }
    );
  }

  const result = loginWithCredential(credential);

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error
      },
      { status: result.status }
    );
  }

  clearRateLimit(credentialRateKey);

  const response = NextResponse.json({
    ok: true,
    role: result.role
  });

  if (result.role === "admin") {
    response.cookies.set(ADMIN_COOKIE, result.adminToken, authCookieOptions);
    response.cookies.set(AUTH_COOKIE, "", {
      ...authCookieOptions,
      maxAge: 0
    });
  } else {
    response.cookies.set(AUTH_COOKIE, result.authToken, authCookieOptions);
    response.cookies.set(ADMIN_COOKIE, "", {
      ...authCookieOptions,
      maxAge: 0
    });
  }

  return response;
}
