import { requireAccessPrincipal } from "@/lib/auth";
import { consumeAccessKeyDialog, refundAccessKeyDialog } from "@/lib/key-config";
import { getOpenAIConfig, getOpenAIHeaders, normalizeOpenAIError } from "@/lib/openai";
import { prisma } from "@/lib/prisma";
import {
  getTextLengthError,
  MAX_CHAT_HISTORY_MESSAGES,
  MAX_CHAT_MESSAGE_CHARS,
  MAX_CHAT_REQUEST_BYTES,
  readJsonBodyWithLimit
} from "@/lib/request-limits";
import { ensureSession, titleFromText } from "@/lib/sessions";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type ChatBody = {
  sessionId?: string;
  message?: string;
  model?: string;
};

function sse(controller: ReadableStreamDefaultController<Uint8Array>, event: string, data: unknown) {
  const encoder = new TextEncoder();
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

function parseSSEBlock(block: string) {
  const lines = block.split(/\r?\n/);
  const event = lines
    .find((line) => line.startsWith("event:"))
    ?.replace(/^event:\s*/, "")
    .trim();
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace(/^data:\s?/, ""))
    .join("\n");

  return {
    event,
    data
  };
}

function findSSEBoundary(buffer: string) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");

  if (lf === -1 && crlf === -1) return null;
  if (lf === -1) return { index: crlf, length: 4 };
  if (crlf === -1) return { index: lf, length: 2 };

  return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 };
}

function getStreamDelta(payload: {
  type?: string;
  delta?: string;
  choices?: Array<{
    delta?: {
      content?: string;
    };
    message?: {
      content?: string;
    };
  }>;
}) {
  if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") {
    return payload.delta;
  }

  const choice = payload.choices?.[0];
  const deltaContent = choice?.delta?.content;
  if (typeof deltaContent === "string") return deltaContent;

  const messageContent = choice?.message?.content;
  if (typeof messageContent === "string") return messageContent;

  return "";
}

export async function POST(request: NextRequest) {
  const principal = requireAccessPrincipal(request);
  if (principal instanceof NextResponse) return principal;

  const parsedBody = await readJsonBodyWithLimit<ChatBody>(request, MAX_CHAT_REQUEST_BYTES);
  if (parsedBody.error) {
    return NextResponse.json(
      {
        error: parsedBody.error
      },
      { status: parsedBody.status || 400 }
    );
  }

  const body = parsedBody.body;
  const message = body?.message?.trim();

  if (!message) {
    return NextResponse.json(
      {
        error: "消息不能为空。"
      },
      { status: 400 }
    );
  }

  const messageLengthError = getTextLengthError("消息", message, MAX_CHAT_MESSAGE_CHARS);
  if (messageLengthError) {
    return NextResponse.json(
      {
        error: messageLengthError
      },
      { status: 400 }
    );
  }

  const providerConfig = getOpenAIConfig();
  const headers = getOpenAIHeaders(providerConfig);
  if (!headers) {
    return NextResponse.json(
      {
        error: "服务端尚未配置 OPENAI_API_KEY，已完成页面和接口预留，请配置密钥后再发起在线聊天。"
      },
      { status: 500 }
    );
  }

  let session;

  try {
    session = await ensureSession(principal.ownerId, body?.sessionId, titleFromText(message));
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "会话不存在。"
      },
      { status: 404 }
    );
  }

  const reservedUsage = consumeAccessKeyDialog(principal.keyId);
  if (!reservedUsage.ok) {
    return NextResponse.json(
      {
        error: reservedUsage.error
      },
      { status: reservedUsage.status }
    );
  }

  const refundReservedUsage = (reason: string) => {
    try {
      refundAccessKeyDialog(principal.keyId);
    } catch (error) {
      console.error("[api/chat] refund_failed", {
        sessionId: session.id,
        reason,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  };

  let preflight;

  try {
    preflight = await (async () => {
      const messageCount = await prisma.message.count({
        where: {
          sessionId: session.id
        }
      });

      const history = (await prisma.message.findMany({
        where: {
          sessionId: session.id
        },
        orderBy: {
          createdAt: "desc"
        },
        take: MAX_CHAT_HISTORY_MESSAGES
      })).reverse();

      const savedUserMessage = await prisma.message.create({
        data: {
          sessionId: session.id,
          role: "user",
          kind: "text",
          content: message
        }
      });

      await prisma.chatSession.update({
        where: {
          id: session.id
        },
        data: {
          ...(messageCount === 0 || session.title === "新会话" ? { title: titleFromText(message) } : {}),
          updatedAt: new Date()
        }
      });

      return {
        history,
        savedUserMessage
      };
    })();
  } catch (error) {
    refundReservedUsage("preflight_db_failed");
    return NextResponse.json(
      {
        error: error instanceof Error ? `消息保存失败：${error.message}` : "消息保存失败。"
      },
      { status: 500 }
    );
  }

  let openAIResponse: Response;
  const upstreamController = new AbortController();
  const abortUpstreamRequest = () => upstreamController.abort();
  request.signal.addEventListener("abort", abortUpstreamRequest, { once: true });

  try {
    openAIResponse = await fetch(`${providerConfig.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: upstreamController.signal,
      body: JSON.stringify({
        model: providerConfig.chatModel,
        stream: true,
        messages: [
          ...preflight.history.map((item) => ({
            role: item.role === "assistant" ? "assistant" : "user",
            content: item.kind === "image" ? `[图片消息] ${item.content}` : item.content
          })),
          {
            role: "user",
            content: message
          }
        ]
      })
    });
  } catch (error) {
    request.signal.removeEventListener("abort", abortUpstreamRequest);
    if (request.signal.aborted || upstreamController.signal.aborted) {
      return new Response(null, { status: 499 });
    }

    refundReservedUsage("upstream_request_failed");

    return NextResponse.json(
      {
        error: error instanceof Error ? `OpenAI 网络请求失败：${error.message}` : "OpenAI 网络请求失败。"
      },
      { status: 502 }
    );
  }

  if (!openAIResponse.ok || !openAIResponse.body) {
    request.signal.removeEventListener("abort", abortUpstreamRequest);
    const payload = await openAIResponse.json().catch(() => null);
    refundReservedUsage("upstream_error_response");
    return NextResponse.json(
      {
        error: normalizeOpenAIError(payload, `OpenAI 接口错误：${openAIResponse.status}`)
      },
      { status: 502 }
    );
  }

  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let streamCancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = openAIResponse.body!.getReader();
      upstreamReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";
      let responseId: string | undefined;
      const abortUpstream = () => {
        streamCancelled = true;
        upstreamController.abort();
        void reader.cancel().catch(() => undefined);
      };

      request.signal.addEventListener("abort", abortUpstream, { once: true });

      if (request.signal.aborted || streamCancelled || upstreamController.signal.aborted) {
        return;
      }

      sse(controller, "meta", {
        sessionId: session.id,
        model: providerConfig.chatModel,
        userMessage: preflight.savedUserMessage
      });

      try {
        while (true) {
          if (request.signal.aborted || streamCancelled || upstreamController.signal.aborted) {
            return;
          }

          const { done, value } = await reader.read();
          if (request.signal.aborted || streamCancelled || upstreamController.signal.aborted) {
            return;
          }
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          while (true) {
            if (request.signal.aborted || streamCancelled || upstreamController.signal.aborted) {
              return;
            }

            const boundary = findSSEBoundary(buffer);
            if (!boundary) break;

            const block = buffer.slice(0, boundary.index);
            buffer = buffer.slice(boundary.index + boundary.length);

            const parsed = parseSSEBlock(block);
            if (!parsed.data || parsed.data === "[DONE]") continue;

            const payload = JSON.parse(parsed.data) as {
              type?: string;
              delta?: string;
              id?: string;
              choices?: Array<{
                delta?: {
                  content?: string;
                };
                message?: {
                  content?: string;
                };
              }>;
              response?: {
                id?: string;
              };
            };

            const delta = getStreamDelta(payload);

            if (delta) {
              if (request.signal.aborted || streamCancelled || upstreamController.signal.aborted) {
                return;
              }
              assistantText += delta;
              sse(controller, "delta", {
                text: delta
              });
            }

            const type = payload.type || parsed.event;
            if (type === "response.completed") {
              responseId = payload.response?.id || payload.id;
            }

            if (payload.id) responseId = payload.id;
          }
        }

        if (request.signal.aborted || streamCancelled || upstreamController.signal.aborted) {
          return;
        }

        let savedMessageId: string | undefined;

        if (assistantText.trim()) {
          const savedMessage = await prisma.message.create({
            data: {
              sessionId: session.id,
              role: "assistant",
              kind: "text",
              content: assistantText
            }
          });

          savedMessageId = savedMessage.id;
        }

        await prisma.chatSession.update({
          where: {
            id: session.id
          },
          data: {
            updatedAt: new Date()
          }
        });

        sse(controller, "done", {
          sessionId: session.id,
          messageId: savedMessageId,
          responseId
        });
      } catch (error) {
        if (!request.signal.aborted && !streamCancelled && !upstreamController.signal.aborted) {
          if (!assistantText.trim()) {
            refundReservedUsage("empty_stream_failed");
          }

          sse(controller, "error", {
            error: error instanceof Error ? error.message : "流式响应解析失败"
          });
        }
      } finally {
        request.signal.removeEventListener("abort", abortUpstream);
        request.signal.removeEventListener("abort", abortUpstreamRequest);
        try {
          controller.close();
        } catch {
          // 客户端主动中断时，流可能已经关闭。
        }
      }
    },
    cancel() {
      streamCancelled = true;
      upstreamController.abort();
      void upstreamReader?.cancel().catch(() => undefined);
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    }
  });
}
