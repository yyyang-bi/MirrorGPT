import crypto from "crypto";
import { NextRequest } from "next/server";

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

const globalForRateLimit = globalThis as unknown as {
  mirrorGptRateLimitBuckets?: Map<string, RateLimitBucket>;
  mirrorGptRateLimitLastPruneAt?: number;
};

function getBuckets() {
  if (!globalForRateLimit.mirrorGptRateLimitBuckets) {
    globalForRateLimit.mirrorGptRateLimitBuckets = new Map();
  }

  return globalForRateLimit.mirrorGptRateLimitBuckets;
}

export function getClientIp(request: NextRequest) {
  const trustProxyHeaders =
    process.env.TRUST_PROXY_HEADERS === "1" ||
    process.env.TRUST_PROXY_HEADERS?.toLowerCase() === "true";

  if (!trustProxyHeaders) return "direct";

  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "direct"
  );
}

export function hashRateLimitValue(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function consumeRateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const buckets = getBuckets();
  pruneExpiredBuckets(buckets, now);
  const current = buckets.get(key);

  if (!current || current.resetAt <= now) {
    buckets.set(key, {
      count: 1,
      resetAt: now + windowMs
    });
    return {
      ok: true,
      remaining: Math.max(0, limit - 1),
      retryAfter: 0
    };
  }

  if (current.count >= limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
    };
  }

  current.count += 1;
  buckets.set(key, current);

  return {
    ok: true,
    remaining: Math.max(0, limit - current.count),
    retryAfter: 0
  };
}

function pruneExpiredBuckets(buckets: Map<string, RateLimitBucket>, now: number) {
  if (
    globalForRateLimit.mirrorGptRateLimitLastPruneAt &&
    now - globalForRateLimit.mirrorGptRateLimitLastPruneAt < 60_000 &&
    buckets.size < 10_000
  ) {
    return;
  }

  globalForRateLimit.mirrorGptRateLimitLastPruneAt = now;

  for (const [key, bucket] of Array.from(buckets.entries())) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }

  while (buckets.size > 10_000) {
    const oldestKey = buckets.keys().next().value as string | undefined;
    if (!oldestKey) break;
    buckets.delete(oldestKey);
  }
}

export function clearRateLimit(key: string) {
  getBuckets().delete(key);
}
