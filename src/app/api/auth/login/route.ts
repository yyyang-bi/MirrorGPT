import {
  ADMIN_COOKIE,
  authCookieOptions,
  AUTH_COOKIE,
  loginWithCredential
} from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    accessKey?: string;
  } | null;

  const result = loginWithCredential(body?.accessKey ?? "");

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error
      },
      { status: result.status }
    );
  }

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
