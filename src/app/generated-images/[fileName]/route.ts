import { createReadStream } from "fs";
import fs from "fs/promises";
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { Readable } from "stream";

export const runtime = "nodejs";

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

function isSafeGeneratedImageName(fileName: string) {
  return /^[a-z0-9-]+\.(png|jpe?g|webp)$/i.test(fileName);
}

function makeImageEtag(size: number, mtimeMs: number) {
  return `"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`;
}

function getImageCacheHeaders(contentType: string, size: number, mtime: Date) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Length": String(size),
    "Last-Modified": mtime.toUTCString(),
    ETag: makeImageEtag(size, mtime.getTime()),
    "X-Content-Type-Options": "nosniff"
  };
}

async function serveGeneratedImage(
  request: NextRequest,
  {
    params,
    headOnly = false
  }: {
    params: Promise<{
      fileName: string;
    }>;
    headOnly?: boolean;
  }
) {
  const { fileName } = await params;
  const decodedFileName = decodeURIComponent(fileName || "");

  if (!isSafeGeneratedImageName(decodedFileName)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const extension = path.extname(decodedFileName).toLowerCase();
  const contentType = IMAGE_MIME_TYPES[extension];
  if (!contentType) {
    return new NextResponse("Not found", { status: 404 });
  }

  const imagePath = path.join(process.cwd(), "public", "generated-images", decodedFileName);

  try {
    const stat = await fs.stat(imagePath);
    if (!stat.isFile()) {
      return new NextResponse("Not found", { status: 404 });
    }

    const headers = getImageCacheHeaders(contentType, stat.size, stat.mtime);
    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch?.split(",").map((value) => value.trim()).includes(headers.ETag)) {
      return new NextResponse(null, {
        status: 304,
        headers
      });
    }

    if (headOnly) {
      return new NextResponse(null, {
        headers
      });
    }

    const stream = Readable.toWeb(createReadStream(imagePath)) as ReadableStream<Uint8Array>;
    return new NextResponse(stream, {
      headers
    });
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
}

export async function GET(
  request: NextRequest,
  {
    params
  }: {
    params: Promise<{
      fileName: string;
    }>;
  }
) {
  return serveGeneratedImage(request, { params });
}

export async function HEAD(
  request: NextRequest,
  {
    params
  }: {
    params: Promise<{
      fileName: string;
    }>;
  }
) {
  return serveGeneratedImage(request, { params, headOnly: true });
}
