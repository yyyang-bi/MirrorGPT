"use client";

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type ChatSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
};

type AccessKeyInfo = {
  id: string;
  name: string;
  remark: string;
  maxUses: number;
  usedCount: number;
  remaining: number | null;
  lastUsedAt: string | null;
};

type Message = {
  id: string;
  sessionId?: string;
  role: "user" | "assistant" | "system";
  kind: "text" | "image";
  content: string;
  imageUrl?: string | null;
  createdAt?: string;
};

type ChatSearchResult = ChatSession & {
  snippets: Array<Pick<Message, "id" | "role" | "kind" | "content" | "createdAt">>;
};

type Mode = "chat" | "image";

type ProviderModelInfo = {
  chatModel: string;
  imageModel: string;
  imagesModel?: string;
  responsesImageModel?: string;
  imageApiMode?: "images" | "responses";
};

type InputImage = {
  id: string;
  dataUrl: string;
  name: string;
};

type MaskDraft = {
  targetImageId: string;
  maskDataUrl: string;
  updatedAt: number;
};

type ImageParams = {
  size: string;
  quality: "auto" | "low" | "medium" | "high";
  output_format: "png" | "jpeg" | "webp";
  output_compression: number | null;
  moderation: "auto" | "low";
  n: 1;
};

type MaskCoverage = "empty" | "partial" | "full";

type ActiveRequestMeta = {
  id: number;
  messageIds: string[];
};

type MarkdownBlock =
  | {
      type: "paragraph" | "quote";
      text: string;
    }
  | {
      type: "heading";
      level: number;
      text: string;
    }
  | {
      type: "ul" | "ol";
      items: string[];
    }
  | {
      type: "code";
      language: string;
      code: string;
    }
  | {
      type: "hr";
    };

type SessionsPayload = {
  sessions: ChatSession[];
  accessKey: AccessKeyInfo | null;
  providerModels: ProviderModelInfo;
};

const quickPrompts = [
  "帮我规划一个一周学习计划",
  "用中文解释一下大模型 API 的工作方式",
  "写一份产品上线检查清单"
];

const generatingDots = Array.from({ length: 22 * 18 }, (_, index) => {
  const columns = 22;
  const rows = 18;
  const column = index % columns;
  const row = Math.floor(index / columns);
  const waveOffset = Math.sin(row * 0.72) * 0.18;

  return {
    id: index,
    x: (column / (columns - 1)) * 100,
    y: (row / (rows - 1)) * 100,
    size: 2.4 + ((column + row) % 3) * 0.35,
    delay: -((column * 0.105 + waveOffset + row * 0.018) % 2.8)
  };
});

const IMAGE_INPUT_LIMIT = 16;
// 遮罩编辑先下线保留代码，后续需要时改为 true 即可恢复入口。
const ENABLE_IMAGE_MASK_EDITOR = false;
const DISPLAY_IMAGE_MODEL = "gpt-image-2";

const DEFAULT_IMAGE_PARAMS: ImageParams = {
  size: "auto",
  quality: "auto",
  output_format: "png",
  output_compression: null,
  moderation: "auto",
  n: 1
};

function createLocalImageId() {
  return `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败。"));
    reader.readAsDataURL(file);
  });
}

function loadHtmlImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败。"));
    image.src = dataUrl;
  });
}

async function classifyMaskCoverage(maskDataUrl: string, imageDataUrl: string): Promise<MaskCoverage> {
  const [maskImage, sourceImage] = await Promise.all([loadHtmlImage(maskDataUrl), loadHtmlImage(imageDataUrl)]);
  if (maskImage.naturalWidth !== sourceImage.naturalWidth || maskImage.naturalHeight !== sourceImage.naturalHeight) {
    throw new Error("遮罩尺寸与遮罩主图不一致，请重新绘制遮罩。");
  }

  const canvas = document.createElement("canvas");
  canvas.width = maskImage.naturalWidth;
  canvas.height = maskImage.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("当前浏览器不支持 Canvas。");

  context.drawImage(maskImage, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const total = pixels.length / 4;
  let edited = 0;
  let fullyTransparent = 0;

  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] < 255) edited += 1;
    if (pixels[index] === 0) fullyTransparent += 1;
  }

  if (edited === 0) return "empty";
  if (fullyTransparent === total) return "full";
  return "partial";
}

function parseSSEBlock(block: string) {
  const event = block
    .split(/\r?\n/)
    .find((line) => line.startsWith("event:"))
    ?.replace(/^event:\s*/, "")
    .trim();
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace(/^data:\s?/, ""))
    .join("\n");

  return { event, data };
}

function shouldUseImageMode(text: string) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;

  const directImagePhrases = [
    "生图",
    "出图",
    "画图",
    "绘图",
    "生成图",
    "生成图片",
    "生成图像",
    "生成照片",
    "生成一张",
    "创建一张",
    "做一张",
    "画一张",
    "绘制一张"
  ];

  if (directImagePhrases.some((phrase) => normalized.includes(phrase))) return true;

  const imageTargetPattern = /(图片|图像|照片|插画|海报|头像|壁纸|封面|表情包|漫画|logo|图标|视觉图|效果图|宣传图|配图)/i;
  const imageVerbPattern = /(生成|创建|制作|设计|画|绘制|出|来一张|做一张)/i;

  return imageTargetPattern.test(normalized) && imageVerbPattern.test(normalized);
}

export default function ChatShell() {
  const router = useRouter();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [imagePrompt, setImagePrompt] = useState("");
  const [imageParams, setImageParams] = useState<ImageParams>(DEFAULT_IMAGE_PARAMS);
  const [inputImages, setInputImages] = useState<InputImage[]>([]);
  const [maskDraft, setMaskDraft] = useState<MaskDraft | null>(null);
  const [maskEditorImageId, setMaskEditorImageId] = useState("");
  const [mode, setMode] = useState<Mode>("chat");
  const [loading, setLoading] = useState(false);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState("");
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const [accessKeyInfo, setAccessKeyInfo] = useState<AccessKeyInfo | null>(null);
  const [providerModels, setProviderModels] = useState<ProviderModelInfo | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ChatSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const activeRequestRef = useRef<AbortController | null>(null);
  const activeReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const activeRequestIdRef = useRef(0);
  const activeRequestMetaRef = useRef<ActiveRequestMeta | null>(null);
  const stoppedRequestIdsRef = useRef<Set<number>>(new Set());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounterRef = useRef(0);
  const bootstrapStartedRef = useRef(false);
  const createSessionPendingRef = useRef<Promise<string> | null>(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions]
  );

  useEffect(() => {
    void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];

      for (const item of Array.from(items)) {
        if (!item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (file) files.push(file);
      }

      if (files.length > 0) {
        event.preventDefault();
        void handleFiles(files);
      }
    };

    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputImages.length]);

  useEffect(() => {
    const hasFiles = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes("Files"));

    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragCounterRef.current += 1;
      setIsDraggingImage(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
      if (dragCounterRef.current === 0) setIsDraggingImage(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragCounterRef.current = 0;
      setIsDraggingImage(false);
      if (event.dataTransfer?.files?.length) {
        void handleFiles(event.dataTransfer.files);
      }
    };

    document.addEventListener("dragenter", onDragEnter);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragenter", onDragEnter);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("drop", onDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputImages.length]);

  useEffect(() => {
    if (!searchOpen) return;

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setSearchOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchOpen]);

  useEffect(() => {
    if (!mobileSidebarOpen) return;

    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileSidebarOpen(false);
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileSidebarOpen]);

  useEffect(() => {
    if (!searchOpen) return;

    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchLoading(false);
      setSearchError("");
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      setSearchError("");

      apiJson<{ results: ChatSearchResult[] }>(`/api/sessions/search?q=${encodeURIComponent(query)}`, {
        signal: controller.signal
      })
        .then((payload) => setSearchResults(payload.results))
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setSearchError(error instanceof Error ? error.message : "搜索失败。");
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setSearchLoading(false);
          }
        });
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, searchQuery]);

  async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => ({}));

    if (response.status === 401) {
      router.replace("/login");
      throw new Error("登录已过期。");
    }

    if (!response.ok) {
      throw new Error(payload.error || "请求失败。");
    }

    return payload as T;
  }

  async function bootstrap() {
    if (bootstrapStartedRef.current) return;
    bootstrapStartedRef.current = true;
    setBooting(true);
    setError("");

    try {
      const { sessions: loadedSessions, accessKey, providerModels: loadedProviderModels } = await apiJson<SessionsPayload>("/api/sessions");
      setSessions(loadedSessions);
      setAccessKeyInfo(accessKey);
      setProviderModels(loadedProviderModels);

      if (loadedSessions[0]) {
        await loadSession(loadedSessions[0].id);
      } else {
        await createSession();
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "初始化失败。");
    } finally {
      setBooting(false);
    }
  }

  async function refreshSessions() {
    const { sessions: loadedSessions, accessKey, providerModels: loadedProviderModels } = await apiJson<SessionsPayload>("/api/sessions");
    setSessions(loadedSessions);
    setAccessKeyInfo(accessKey);
    setProviderModels(loadedProviderModels);
  }

  async function createSession() {
    if (createSessionPendingRef.current) return createSessionPendingRef.current;

    const pending = (async () => {
      const { session } = await apiJson<{ session: ChatSession }>("/api/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          title: "新会话"
        })
      });

      setSessions((previous) => {
        const withoutDuplicate = previous.filter((item) => item.id !== session.id);
        return [session, ...withoutDuplicate];
      });
      setActiveSessionId(session.id);
      setMessages([]);
      return session.id;
    })();

    createSessionPendingRef.current = pending;
    try {
      return await pending;
    } finally {
      createSessionPendingRef.current = null;
    }
  }

  async function loadSession(sessionId: string) {
    setError("");
    const { session } = await apiJson<{ session: ChatSession & { messages: Message[] } }>(`/api/sessions/${sessionId}`);
    setActiveSessionId(session.id);
    setMessages(session.messages);
  }

  async function deleteSession(sessionId: string) {
    if (!window.confirm("确定删除这个会话吗？")) return;

    await apiJson<{ ok: boolean }>(`/api/sessions/${sessionId}`, {
      method: "DELETE"
    });

    const nextSessions = sessions.filter((session) => session.id !== sessionId);
    setSessions(nextSessions);

    if (activeSessionId === sessionId) {
      if (nextSessions[0]) {
        await loadSession(nextSessions[0].id);
      } else {
        await createSession();
      }
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", {
      method: "POST"
    });
    router.replace("/login");
    router.refresh();
  }

  function openSearch() {
    setSearchOpen(true);
    setSearchError("");
  }

  async function selectSearchResult(sessionId: string) {
    setSearchOpen(false);
    await loadSession(sessionId);
  }

  function isRequestStopped(requestId: number) {
    return stoppedRequestIdsRef.current.has(requestId) || activeRequestIdRef.current !== requestId;
  }

  function stopCurrentRequest() {
    const requestId = activeRequestIdRef.current;
    const requestMeta = activeRequestMetaRef.current;

    if (requestId > 0) {
      stoppedRequestIdsRef.current.add(requestId);
      activeRequestIdRef.current = requestId + 1;
    }

    activeRequestRef.current?.abort();
    void activeReaderRef.current?.cancel().catch(() => undefined);

    if (requestMeta?.messageIds.length) {
      const messageIds = new Set(requestMeta.messageIds);
      setMessages((previous) => previous.filter((message) => !messageIds.has(message.id)));
    }

    activeReaderRef.current = null;
    activeRequestRef.current = null;
    activeRequestMetaRef.current = null;
    setError("");
    setLoading(false);
  }

  async function ensureActiveSession() {
    if (activeSessionId) return activeSessionId;
    return createSession();
  }

  async function handleFiles(files: FileList | File[]) {
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;

    setMode("image");
    setError("");

    const remaining = Math.max(0, IMAGE_INPUT_LIMIT - inputImages.length);
    if (remaining === 0) {
      setError(`参考图数量已达上限（${IMAGE_INPUT_LIMIT} 张）。`);
      return;
    }

    const selectedFiles = imageFiles.slice(0, remaining);
    const nextImages = await Promise.all(
      selectedFiles.map(async (file) => ({
        id: createLocalImageId(),
        name: file.name || "参考图",
        dataUrl: await fileToDataUrl(file)
      }))
    );

    setInputImages((previous) => [...previous, ...nextImages].slice(0, IMAGE_INPUT_LIMIT));
    if (imageFiles.length > selectedFiles.length) {
      setError(`最多支持 ${IMAGE_INPUT_LIMIT} 张参考图，已忽略多余图片。`);
    }
  }

  function removeInputImage(id: string) {
    setInputImages((previous) => previous.filter((image) => image.id !== id));
    setMaskDraft((previous) => (previous?.targetImageId === id ? null : previous));
  }

  function clearInputImages() {
    setInputImages([]);
    setMaskDraft(null);
  }

  async function prepareImageRequestPayload(prompt: string) {
    let orderedImages = inputImages;
    let maskDataUrl: string | undefined;

    if (ENABLE_IMAGE_MASK_EDITOR && maskDraft) {
      const target = inputImages.find((image) => image.id === maskDraft.targetImageId);
      if (!target) {
        setMaskDraft(null);
        throw new Error("遮罩主图已不存在，请重新选择遮罩区域。");
      }

      const coverage = await classifyMaskCoverage(maskDraft.maskDataUrl, target.dataUrl);
      if (coverage === "empty") {
        throw new Error("请先涂抹需要编辑的区域。");
      }
      if (coverage === "full" && !window.confirm("当前遮罩覆盖了整张图片，提交后可能会重绘全部内容。是否继续？")) {
        throw new Error("");
      }

      orderedImages = [target, ...inputImages.filter((image) => image.id !== target.id)];
      maskDataUrl = maskDraft.maskDataUrl;
    }

    return {
      sessionId: await ensureActiveSession(),
      prompt,
      size: imageParams.size,
      params: imageParams,
      inputImageDataUrls: orderedImages.map((image) => image.dataUrl),
      maskDataUrl
    };
  }

  async function sendChat(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();

    const text = input.trim();
    if (!text || loading) return;

    if (shouldUseImageMode(text)) {
      setMode("image");
      setInput("");
      setImagePrompt("");
      await generateImage(undefined, text);
      return;
    }

    setLoading(true);
    setError("");
    setInput("");

    const sessionId = await ensureActiveSession();
    const assistantId = `tmp-assistant-${Date.now()}`;
    const userId = `tmp-user-${Date.now()}`;
    const controller = new AbortController();
    const requestId = activeRequestIdRef.current + 1;
    activeRequestIdRef.current = requestId;
    activeRequestRef.current = controller;
    activeRequestMetaRef.current = {
      id: requestId,
      messageIds: [assistantId]
    };
    let streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    setMessages((previous) => [
      ...previous,
      {
        id: userId,
        role: "user",
        kind: "text",
        content: text
      },
      {
        id: assistantId,
        role: "assistant",
        kind: "text",
        content: ""
      }
    ]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          sessionId,
          message: text
        })
      });

      if (response.status === 401) {
        router.replace("/login");
        return;
      }

      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "聊天接口请求失败。");
      }

      streamReader = response.body.getReader();
      const reader = streamReader;
      activeReaderRef.current = reader;
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        if (controller.signal.aborted || isRequestStopped(requestId)) {
          await reader.cancel().catch(() => undefined);
          throw new DOMException("The operation was aborted.", "AbortError");
        }

        const { done, value } = await reader.read();
        if (controller.signal.aborted || isRequestStopped(requestId)) {
          await reader.cancel().catch(() => undefined);
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        while (buffer.includes("\n\n")) {
          const index = buffer.indexOf("\n\n");
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);

          const parsed = parseSSEBlock(block);
          if (!parsed.data) continue;

          const payload = JSON.parse(parsed.data) as {
            text?: string;
            error?: string;
            userMessage?: Message;
          };

          if (parsed.event === "meta" && payload.userMessage) {
            setMessages((previous) =>
              isRequestStopped(requestId)
                ? previous
                : previous.map((message) => (message.id === userId ? payload.userMessage! : message))
            );
          }

          if (parsed.event === "delta" && payload.text) {
            if (controller.signal.aborted || isRequestStopped(requestId)) {
              await reader.cancel().catch(() => undefined);
              throw new DOMException("The operation was aborted.", "AbortError");
            }
            setMessages((previous) =>
              isRequestStopped(requestId)
                ? previous
                : previous.map((message) =>
                    message.id === assistantId ? { ...message, content: `${message.content}${payload.text}` } : message
                  )
            );
          }

          if (parsed.event === "error") {
            throw new Error(payload.error || "流式响应失败。");
          }
        }
      }

      if (controller.signal.aborted || isRequestStopped(requestId)) {
        await reader.cancel().catch(() => undefined);
        throw new DOMException("The operation was aborted.", "AbortError");
      }

      await refreshSessions();
      if (controller.signal.aborted || isRequestStopped(requestId)) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      await loadSession(sessionId);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError") || isRequestStopped(requestId)) {
        setError("");
        setMessages((previous) => previous.filter((item) => item.id !== assistantId));
        void refreshSessions().catch(() => undefined);
        return;
      }

      const message = error instanceof Error ? error.message : "发送失败。";
      setError(message);
      setMessages((previous) =>
        previous.map((item) => (item.id === assistantId ? { ...item, content: `请求失败：${message}` } : item))
      );
      void refreshSessions().catch(() => undefined);
    } finally {
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = null;
      }
      if (activeReaderRef.current === streamReader) {
        activeReaderRef.current = null;
      }
      const shouldClearLoading = !activeRequestMetaRef.current || activeRequestMetaRef.current.id === requestId;
      if (activeRequestMetaRef.current?.id === requestId) {
        activeRequestMetaRef.current = null;
      }
      if (shouldClearLoading) {
        setLoading(false);
      }
    }
  }

  async function generateImage(event?: FormEvent<HTMLFormElement>, promptOverride?: string) {
    event?.preventDefault();

    const prompt = (promptOverride ?? imagePrompt).trim();
    if (!prompt || loading) return;

    let requestPayload: {
      sessionId: string;
      prompt: string;
      size: string;
      params: ImageParams;
      inputImageDataUrls: string[];
      maskDataUrl?: string;
    };

    try {
      requestPayload = await prepareImageRequestPayload(prompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : "图片输入校验失败。";
      if (message) setError(message);
      return;
    }

    setLoading(true);
    setError("");
    setImagePrompt("");
    const controller = new AbortController();
    const requestId = activeRequestIdRef.current + 1;
    const userId = `tmp-image-user-${Date.now()}`;
    activeRequestIdRef.current = requestId;
    activeRequestRef.current = controller;
    activeRequestMetaRef.current = {
      id: requestId,
      messageIds: [userId]
    };

    try {
      setMessages((previous) => [
        ...previous,
        {
          id: userId,
          role: "user",
          kind: "text",
          content: prompt
        }
      ]);

      const payload = await apiJson<{
        userMessage: Message;
        assistantMessage: Message;
        sessionId: string;
      }>("/api/images", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestPayload)
      });

      if (controller.signal.aborted || isRequestStopped(requestId)) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }

      setMessages((previous) => [
        ...previous.filter((message) => message.id !== userId),
        payload.userMessage,
        payload.assistantMessage
      ]);
      clearInputImages();
      await refreshSessions();
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError") || isRequestStopped(requestId)) {
        setError("");
        setMessages((previous) => previous.filter((message) => message.id !== userId));
        return;
      }

      setError(error instanceof Error ? error.message : "生图失败。");
      setImagePrompt(prompt);
      void refreshSessions().catch(() => undefined);
    } finally {
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = null;
      }
      const shouldClearLoading = !activeRequestMetaRef.current || activeRequestMetaRef.current.id === requestId;
      if (activeRequestMetaRef.current?.id === requestId) {
        activeRequestMetaRef.current = null;
      }
      if (shouldClearLoading) {
        setLoading(false);
      }
    }
  }

  function onTextAreaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (mode === "chat") {
        void sendChat();
      } else {
        void generateImage();
      }
    }
  }

  const composerText = mode === "chat" ? input : imagePrompt;
  const setComposerText = mode === "chat" ? setInput : setImagePrompt;
  const hasMessages = messages.length > 0;
  const maskTargetImage = maskDraft ? inputImages.find((image) => image.id === maskDraft.targetImageId) ?? null : null;

  const renderImageInputs = () => {
    if (mode !== "image" || inputImages.length === 0) return null;

    return (
      <div className="border-b border-white/5 px-3 pt-3">
        <div className="flex gap-2 overflow-x-auto pb-3">
          {inputImages.map((image) => {
            const isMaskTarget = ENABLE_IMAGE_MASK_EDITOR && maskDraft?.targetImageId === image.id;

            return (
              <div key={image.id} className={`group relative h-16 w-16 shrink-0 overflow-hidden rounded-2xl ring-2 ${isMaskTarget ? "ring-blue-400" : "ring-white/10"}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.dataUrl}
                  alt={image.name}
                  className="h-full w-full object-cover"
                  onClick={() => setPreviewImage({ src: image.dataUrl, alt: image.name })}
                />
                {isMaskTarget ? (
                  <span className="absolute left-1 top-1 rounded-full bg-blue-500 px-1.5 py-0.5 text-[9px] font-bold text-white">MASK</span>
                ) : null}
                <div className="absolute inset-0 flex items-center justify-center gap-1 bg-black/55 opacity-0 transition group-hover:opacity-100">
                  {ENABLE_IMAGE_MASK_EDITOR ? (
                    <button
                      type="button"
                      onClick={() => setMaskEditorImageId(image.id)}
                      className="rounded-full bg-white px-2 py-1 text-[10px] font-semibold text-black"
                      title={isMaskTarget ? "编辑遮罩" : "添加遮罩"}
                    >
                      遮罩
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => removeInputImage(image.id)}
                    className="rounded-full bg-red-500 px-2 py-1 text-[10px] font-semibold text-white"
                    title="移除"
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}
          <button
            type="button"
            onClick={clearInputImages}
            className="h-16 w-16 shrink-0 rounded-2xl border border-dashed border-white/15 text-xs text-[#b4b4b4] transition hover:border-red-300/60 hover:text-red-200"
          >
            清空
          </button>
        </div>
      </div>
    );
  };

  const renderImageParams = () => {
    if (mode !== "image") return null;

    const selectClass = "h-8 rounded-xl border border-white/10 bg-[#252525] px-2 text-xs text-[#ececec] outline-none transition focus:border-blue-400";

    return (
      <div className="flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2 text-xs text-[#b4b4b4]">
        <label className="flex items-center gap-1.5">
          <span>尺寸</span>
          <select
            value={imageParams.size}
            onChange={(event) => setImageParams((previous) => ({ ...previous, size: event.target.value }))}
            className={selectClass}
          >
            <option value="auto">auto</option>
            <option value="1024x1024">1024×1024</option>
            <option value="1024x1536">1024×1536</option>
            <option value="1536x1024">1536×1024</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span>质量</span>
          <select
            value={imageParams.quality}
            onChange={(event) => setImageParams((previous) => ({ ...previous, quality: event.target.value as ImageParams["quality"] }))}
            className={selectClass}
          >
            <option value="auto">auto</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span>格式</span>
          <select
            value={imageParams.output_format}
            onChange={(event) => setImageParams((previous) => ({ ...previous, output_format: event.target.value as ImageParams["output_format"], output_compression: null }))}
            className={selectClass}
          >
            <option value="png">PNG</option>
            <option value="jpeg">JPEG</option>
            <option value="webp">WebP</option>
          </select>
        </label>
        <span className="rounded-full bg-white/10 px-2.5 py-1 text-[#d7d7d7]">数量 1</span>
        {ENABLE_IMAGE_MASK_EDITOR && maskTargetImage ? <span className="rounded-full bg-blue-500/20 px-2.5 py-1 text-blue-200">已启用遮罩</span> : null}
      </div>
    );
  };

  const renderComposer = (placement: "center" | "dock") => (
    <form onSubmit={mode === "chat" ? sendChat : generateImage} className={placement === "center" ? "mx-auto w-full max-w-[800px]" : "w-full"}>
      <div className="relative flex flex-col rounded-3xl bg-[#2f2f2f] shadow-[0_0_15px_rgba(0,0,0,0.1)] transition focus-within:bg-[#333333]">
        {renderImageInputs()}
        {renderImageParams()}
        <textarea
          value={composerText}
          onChange={(event) => setComposerText(event.target.value)}
          onKeyDown={onTextAreaKeyDown}
          rows={placement === "center" ? 1 : 1}
          placeholder={mode === "chat" ? "给 \"ChatGPT\" 发送消息" : "描述你想生成的图片"}
          className="chat-scrollbar max-h-40 min-h-[56px] w-full resize-none border-0 bg-transparent px-5 py-4 text-base text-[#ececec] outline-none placeholder:text-[#a3a3a3]"
        />

        <div className="flex items-center justify-between px-3 pb-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              title="添加参考图"
              onClick={() => {
                setMode("image");
                fileInputRef.current?.click();
              }}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-2xl font-light text-[#ececec] transition hover:bg-white/10"
            >
              +
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => {
                if (event.target.files) void handleFiles(event.target.files);
                event.currentTarget.value = "";
              }}
            />

            <ModeSelector value={mode} onChange={setMode} models={providerModels} />
          </div>

          <div className="flex items-center gap-2">
            <button
              disabled={!loading && !composerText.trim()}
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-full transition ${
                loading
                  ? "bg-[#ececec] text-black hover:bg-white"
                  : "bg-white text-black hover:bg-[#ececec] disabled:cursor-not-allowed disabled:bg-[#676767] disabled:text-[#2f2f2f]"
              }`}
              type="button"
              onClick={() => {
                if (loading) {
                  stopCurrentRequest();
                  return;
                }

                if (mode === "chat") {
                  void sendChat();
                } else {
                  void generateImage();
                }
              }}
              title={loading ? "暂停生成" : mode === "chat" ? "发送" : "生成图片"}
            >
              {loading ? <StopGeneratingIcon /> : <SendIcon />}
            </button>
          </div>
        </div>
      </div>
    </form>
  );

  return (
    <main className="flex h-dvh overflow-hidden bg-[#212121] text-[#ececec]">
      {isDraggingImage ? (
        <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-sm">
          <div className="rounded-3xl border border-dashed border-blue-300/70 bg-blue-500/10 px-8 py-6 text-center shadow-2xl">
            <p className="text-lg font-semibold text-blue-100">释放以添加参考图</p>
            <p className="mt-1 text-sm text-blue-100/70">最多 {IMAGE_INPUT_LIMIT} 张，支持 JPG、PNG、WebP 等图片格式</p>
          </div>
        </div>
      ) : null}

      {mobileSidebarOpen ? (
        <div className="fixed inset-0 z-50 flex bg-black/55 backdrop-blur-sm md:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            className="absolute inset-0 cursor-default"
            aria-label="关闭侧边栏"
            onClick={() => setMobileSidebarOpen(false)}
          />
          <aside className="relative flex h-full w-[min(86vw,320px)] flex-col bg-[#171717] text-[#ececec] shadow-2xl">
            <div className="flex h-14 items-center justify-between px-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg text-[#ececec]" title="ChatGPT">
                <ChatGPTMarkIcon />
              </div>
              <button
                type="button"
                onClick={() => setMobileSidebarOpen(false)}
                className="grid h-10 w-10 place-items-center rounded-lg text-2xl leading-none text-[#b4b4b4] transition hover:bg-[#212121] hover:text-white"
                title="关闭侧边栏"
                aria-label="关闭侧边栏"
              >
                ×
              </button>
            </div>

            <nav className="flex flex-col gap-0.5 px-3 mt-2">
              <SidebarAction
                icon={<NewChatIcon />}
                label="新聊天"
                onClick={() => {
                  void createSession().finally(() => setMobileSidebarOpen(false));
                }}
              />
              <SidebarAction
                icon={<SearchIcon />}
                label="搜索聊天"
                onClick={() => {
                  setMobileSidebarOpen(false);
                  openSearch();
                }}
              />
            </nav>

            <div className="chat-scrollbar mt-4 flex-1 overflow-y-auto px-3">
              <p className="px-2 pb-2 text-xs font-medium text-[#9b9b9b]">最近</p>
              {sessions.length === 0 ? (
                <p className="rounded-lg px-2 py-3 text-sm text-[#8f8f8f]">暂无历史会话</p>
              ) : (
                sessions.map((session) => (
                  <div
                    key={session.id}
                    className={`group relative mb-0.5 flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition ${
                      activeSessionId === session.id ? "bg-[#212121] text-[#ececec]" : "text-[#ececec] hover:bg-[#212121]"
                    }`}
                  >
                    <button
                      className="min-w-0 flex-1 text-left"
                      onClick={() => {
                        void loadSession(session.id).finally(() => setMobileSidebarOpen(false));
                      }}
                    >
                      <p className="truncate">{session.title}</p>
                    </button>
                    <button
                      onClick={() => void deleteSession(session.id)}
                      className="rounded px-1.5 py-1 text-[#b4b4b4] transition hover:bg-[#333333] hover:text-[#ececec]"
                      title="删除会话"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="mt-2 flex flex-col gap-1 p-3 pt-0">
              <KeyUsageCard accessKey={accessKeyInfo} onLogout={() => void logout()} />
            </div>
          </aside>
        </div>
      ) : null}

      <aside
        className={`hidden shrink-0 overflow-hidden bg-[#171717] text-[#ececec] transition-[width] duration-300 ease-in-out md:flex ${
          sidebarCollapsed ? "w-[60px]" : "w-[260px]"
        }`}
      >
        <div className="relative h-full w-[260px]">
          <div
            className={`absolute inset-y-0 left-0 flex w-[60px] flex-col items-center bg-[#171717] py-3 transition-all duration-200 ${
              sidebarCollapsed ? "translate-x-0 opacity-100 delay-150" : "pointer-events-none -translate-x-2 opacity-0"
            }`}
          >
            <div className="flex flex-col items-center gap-3">
              <button
                className="grid h-10 w-10 place-items-center rounded-lg text-[#ececec] transition hover:bg-[#212121]"
                title="展开侧边栏"
                onClick={() => setSidebarCollapsed(false)}
              >
                <SidebarIcon />
              </button>
              <button className="grid h-10 w-10 place-items-center rounded-lg text-[#ececec] transition hover:bg-[#212121]" title="新聊天" onClick={() => void createSession()}>
                <NewChatIcon />
              </button>
              <button className="grid h-10 w-10 place-items-center rounded-lg text-[#ececec] transition hover:bg-[#212121]" title="搜索聊天" onClick={openSearch}>
                <SearchIcon />
              </button>
            </div>
            <div className="mt-auto pb-2">
              <div className="grid h-10 w-10 place-items-center rounded-full bg-blue-600 text-sm font-semibold text-white ring-1 ring-white/10">
                {getKeyInitial(accessKeyInfo?.name)}
              </div>
            </div>
          </div>

          <div
            className={`absolute inset-0 flex w-[260px] flex-col bg-[#171717] transition-all duration-200 ${
              sidebarCollapsed ? "pointer-events-none -translate-x-4 opacity-0" : "translate-x-0 opacity-100 delay-100"
            }`}
          >
            <div className="flex h-14 items-center justify-between px-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg text-[#ececec] transition hover:bg-[#212121] cursor-pointer" title="ChatGPT">
                <ChatGPTMarkIcon />
              </div>
              <button
                onClick={() => setSidebarCollapsed(true)}
                className="grid h-10 w-10 place-items-center rounded-lg text-[#b4b4b4] transition hover:bg-[#212121]"
                title="收起侧边栏"
              >
                <SidebarIcon />
              </button>
            </div>

            <nav className="flex flex-col gap-0.5 px-3 mt-2">
              <SidebarAction icon={<NewChatIcon />} label="新聊天" onClick={() => void createSession()} />
              <SidebarAction icon={<SearchIcon />} label="搜索聊天" onClick={openSearch} />
            </nav>

            <div className="chat-scrollbar mt-4 flex-1 overflow-y-auto px-3">
              <p className="px-2 pb-2 text-xs font-medium text-[#9b9b9b]">最近</p>
              {sessions.map((session) => (
                <div
                  key={session.id}
                  className={`group relative mb-0.5 flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition ${
                    activeSessionId === session.id ? "bg-[#212121] text-[#ececec]" : "text-[#ececec] hover:bg-[#212121]"
                  }`}
                >
                  <button className="min-w-0 flex-1 text-left" onClick={() => void loadSession(session.id)}>
                    <p className="truncate">{session.title}</p>
                  </button>
                  <div className="absolute right-2 flex items-center opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      onClick={() => void deleteSession(session.id)}
                      className="rounded px-1.5 py-1 text-[#b4b4b4] transition hover:bg-[#333333] hover:text-[#ececec]"
                      title="删除会话"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-2 flex flex-col gap-1 p-3 pt-0">
              <KeyUsageCard accessKey={accessKeyInfo} onLogout={() => void logout()} />
            </div>
          </div>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-[#212121]">
        <header className="flex h-14 shrink-0 items-center justify-between px-3 md:px-8">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setMobileSidebarOpen(true)}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-[#ececec] transition hover:bg-white/10 md:hidden"
              aria-label="打开侧边栏"
              title="打开侧边栏"
            >
              <SidebarIcon />
            </button>
            <TopModelMenu models={providerModels} onChooseMode={setMode} />
            <span className="hidden max-w-[42vw] truncate text-sm text-[#b4b4b4] sm:inline md:hidden">
              {activeSession?.title || "新会话"}
            </span>
          </div>
          <div className="grid h-8 w-8 place-items-center rounded-full bg-blue-600 text-sm font-semibold text-white ring-1 ring-white/10 cursor-pointer">
            {getKeyInitial(accessKeyInfo?.name)}
          </div>
        </header>

        <div className="chat-scrollbar flex-1 overflow-y-auto px-4 md:px-8">
          {booting ? (
            <div className="flex h-full items-center justify-center text-sm text-[#b4b4b4]">正在加载会话...</div>
          ) : !hasMessages ? (
            <div className="flex min-h-full flex-col items-center justify-center pb-32">
              <h2 className="mb-8 text-center text-3xl font-semibold tracking-tight text-[#f4f4f4]">你在忙什么？</h2>
              {error ? <div className="mb-4 w-full max-w-[800px] rounded-2xl bg-red-500/10 px-4 py-3 text-sm text-red-200 ring-1 ring-red-500/20">{error}</div> : null}
              <div className="w-full px-4 sm:px-0">
                {renderComposer("center")}
              </div>
              <div className="mt-4 flex justify-center">
                {/*<button type="button" className="flex items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-sm font-medium text-[#ececec] transition hover:bg-white/5">*/}
                {/*  <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>*/}
                {/*  公司知识库*/}
                {/*</button>*/}
              </div>
            </div>
          ) : (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-8">
              {messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  onImagePreview={(src, alt) => setPreviewImage({ src, alt })}
                />
              ))}

              {loading ? (
                mode === "image" ? (
                  <ImageGeneratingPlaceholder />
                ) : (
                  <div className="flex items-center gap-2 text-sm text-[#b4b4b4]">
                    <span className="h-2 w-2 animate-bounce rounded-full bg-[#b4b4b4] [animation-delay:-.2s]" />
                    <span className="h-2 w-2 animate-bounce rounded-full bg-[#b4b4b4] [animation-delay:-.1s]" />
                    <span className="h-2 w-2 animate-bounce rounded-full bg-[#b4b4b4]" />
                    正在处理...
                  </div>
                )
              ) : null}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {hasMessages ? (
          <div className="shrink-0 bg-[#212121] px-4 pb-3 md:px-8">
            <div className="mx-auto max-w-3xl">
              {error ? <div className="mb-3 rounded-2xl bg-red-500/10 px-4 py-3 text-sm text-red-200 ring-1 ring-red-500/20">{error}</div> : null}
              {renderComposer("dock")}
              <p className="mt-2 text-center text-[11px] text-[#b4b4b4]">
                ChatGPT 也可能会犯错。当前使用密钥：{accessKeyInfo?.name || "读取中"}。
              </p>
            </div>
          </div>
        ) : (
          <p className="shrink-0 px-4 pb-3 text-center text-[11px] text-[#b4b4b4]">
            ChatGPT 也可能会犯错。OpenAI 不会使用“MarcinkowskiMigliorisi81”工作空间数据来训练其模型。
          </p>
        )}
      </section>

      {searchOpen ? (
        <ChatSearchModal
          query={searchQuery}
          setQuery={setSearchQuery}
          results={searchResults}
          recentSessions={sessions}
          loading={searchLoading}
          error={searchError}
          onClose={() => setSearchOpen(false)}
          onSelect={(sessionId) => void selectSearchResult(sessionId)}
        />
      ) : null}

      {previewImage ? (
        <ImagePreviewModal
          src={previewImage.src}
          alt={previewImage.alt}
          onClose={() => setPreviewImage(null)}
        />
      ) : null}

      {ENABLE_IMAGE_MASK_EDITOR && maskEditorImageId ? (
        <MaskEditorModal
          image={inputImages.find((item) => item.id === maskEditorImageId) ?? null}
          existingMask={maskDraft?.targetImageId === maskEditorImageId ? maskDraft.maskDataUrl : null}
          onClose={() => setMaskEditorImageId("")}
          onSave={(targetImage, maskDataUrl) => {
            setInputImages((previous) => {
              let replaced = false;
              const next = previous.map((image) => {
                if (image.id !== maskEditorImageId) return image;
                replaced = true;
                return targetImage;
              });
              return replaced ? next : [targetImage, ...previous].slice(0, IMAGE_INPUT_LIMIT);
            });
            setMaskDraft({
              targetImageId: targetImage.id,
              maskDataUrl,
              updatedAt: Date.now()
            });
            setMaskEditorImageId("");
            setMode("image");
          }}
        />
      ) : null}
    </main>
  );
}

function TopModelMenu(_: {
  models: ProviderModelInfo | null;
  onChooseMode: (mode: Mode) => void;
}) {
  return (
    <div className="rounded-xl px-3 py-2 text-[18px] font-semibold text-[#ececec]">
      ChatGPT
    </div>
  );
}

function ChatSearchModal({
  query,
  setQuery,
  results,
  recentSessions,
  loading,
  error,
  onClose,
  onSelect
}: {
  query: string;
  setQuery: (query: string) => void;
  results: ChatSearchResult[];
  recentSessions: ChatSession[];
  loading: boolean;
  error: string;
  onClose: () => void;
  onSelect: (sessionId: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hasQuery = query.trim().length > 0;
  const visibleRecentSessions = recentSessions.slice(0, 12);
  const firstSessionId = hasQuery ? results[0]?.id : visibleRecentSessions[0]?.id;

  useEffect(() => {
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (firstSessionId) onSelect(firstSessionId);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-4 pt-[12vh] backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-2xl overflow-hidden rounded-3xl bg-[#2f2f2f] text-[#ececec] shadow-2xl ring-1 ring-white/10"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <form onSubmit={submitSearch} className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索聊天"
            className="min-w-0 flex-1 border-0 bg-transparent text-base text-[#f4f4f4] outline-none placeholder:text-[#8f8f8f]"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="rounded-full px-2 py-1 text-sm text-[#b4b4b4] transition hover:bg-white/10 hover:text-white"
            >
              清空
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-full text-[#b4b4b4] transition hover:bg-white/10 hover:text-white"
            title="关闭"
          >
            ×
          </button>
        </form>

        <div className="chat-scrollbar max-h-[62vh] overflow-y-auto p-3">
          {error ? <div className="mb-3 rounded-2xl bg-red-500/10 px-4 py-3 text-sm text-red-200 ring-1 ring-red-500/20">{error}</div> : null}

          {!hasQuery ? (
            <>
              <p className="px-2 pb-2 text-xs font-medium text-[#9b9b9b]">最近聊天</p>
              {visibleRecentSessions.length > 0 ? (
                <div className="space-y-1">
                  {visibleRecentSessions.map((session) => (
                    <SearchSessionRow
                      key={session.id}
                      title={session.title}
                      subtitle={`${session.messageCount ?? 0} 条消息 · ${formatSearchDate(session.updatedAt)}`}
                      onClick={() => onSelect(session.id)}
                    />
                  ))}
                </div>
              ) : (
                <EmptySearchState text="暂无聊天记录" />
              )}
            </>
          ) : loading ? (
            <div className="flex items-center gap-2 px-3 py-8 text-sm text-[#b4b4b4]">
              <span className="h-2 w-2 animate-bounce rounded-full bg-[#b4b4b4] [animation-delay:-.2s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-[#b4b4b4] [animation-delay:-.1s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-[#b4b4b4]" />
              正在搜索...
            </div>
          ) : results.length > 0 ? (
            <>
              <p className="px-2 pb-2 text-xs font-medium text-[#9b9b9b]">搜索结果</p>
              <div className="space-y-1">
                {results.map((session) => {
                  const snippet = session.snippets[0]?.content;
                  return (
                    <SearchSessionRow
                      key={session.id}
                      title={session.title}
                      subtitle={`${session.messageCount ?? 0} 条消息 · ${formatSearchDate(session.updatedAt)}`}
                      snippet={snippet}
                      query={query}
                      onClick={() => onSelect(session.id)}
                    />
                  );
                })}
              </div>
            </>
          ) : (
            <EmptySearchState text="没有找到相关聊天" />
          )}
        </div>
      </div>
    </div>
  );
}

function SearchSessionRow({
  title,
  subtitle,
  snippet,
  query,
  onClick
}: {
  title: string;
  subtitle: string;
  snippet?: string;
  query?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-start gap-3 rounded-2xl px-3 py-3 text-left transition hover:bg-white/10"
    >
      <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/10 text-[#d7d7d7] group-hover:bg-white/15 group-hover:text-white">
        <SearchIcon />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-[#f4f4f4]">{highlightMatch(title || "新会话", query)}</span>
        <span className="mt-0.5 block text-xs text-[#9b9b9b]">{subtitle}</span>
        {snippet ? (
          <span className="mt-1 block truncate text-sm text-[#c7c7c7]">
            {highlightMatch(cleanSnippet(snippet), query)}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function EmptySearchState({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center text-sm text-[#9b9b9b]">
      <div className="mb-3 grid h-12 w-12 place-items-center rounded-full bg-white/10 text-[#d7d7d7]">
        <SearchIcon />
      </div>
      {text}
    </div>
  );
}

function formatSearchDate(value?: string) {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知时间";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function cleanSnippet(value: string) {
  return value
    .replace(/```[\w-]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightMatch(text: string, query?: string) {
  const keyword = query?.trim();
  if (!keyword) return text;

  const parts = text.split(new RegExp(`(${escapeRegExp(keyword)})`, "gi"));
  return parts.map((part, index) =>
    part.toLowerCase() === keyword.toLowerCase() ? (
      <mark key={index} className="rounded bg-amber-400/25 px-0.5 text-[#ffd978]">
        {part}
      </mark>
    ) : (
      part
    )
  );
}

function SidebarAction({ icon, label, onClick }: { icon: React.ReactNode; label: React.ReactNode; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm font-medium text-[#ececec] transition hover:bg-[#212121]">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[#b4b4b4] group-hover:text-[#ececec]">{icon}</span>
      <div className="flex-1 truncate">{label}</div>
    </button>
  );
}

function ModeSelector({
  value,
  onChange,
  models
}: {
  value: Mode;
  onChange: (mode: Mode) => void;
  models: ProviderModelInfo | null;
}) {
  const [open, setOpen] = useState(false);
  const options: Array<{ value: Mode; label: string; model: string; icon: React.ReactNode }> = [
    {
      value: "chat",
      label: "聊天",
      model: models?.chatModel || "读取中",
      icon: (
        <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path>
        </svg>
      )
    },
    {
      value: "image",
      label: "生图",
      model: DISPLAY_IMAGE_MODEL,
      icon: (
        <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <circle cx="8.5" cy="8.5" r="1.5"></circle>
          <polyline points="21 15 16 10 5 21"></polyline>
        </svg>
      )
    }
  ];
  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    <div className="relative">
      {open ? <button type="button" className="fixed inset-0 z-10 cursor-default" aria-label="关闭模式菜单" onClick={() => setOpen(false)} /> : null}
      <div
        className={`absolute bottom-full left-0 z-20 mb-2 w-64 origin-bottom-left rounded-[1.35rem] bg-[#333333] p-2 shadow-2xl ring-1 ring-white/10 transition ${
          open ? "translate-y-0 scale-100 opacity-100" : "pointer-events-none translate-y-1 scale-95 opacity-0"
        }`}
      >
        <p className="px-3 pb-1 pt-2 text-sm font-medium text-[#a3a3a3]">模式</p>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              onChange(option.value);
              setOpen(false);
            }}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-base font-semibold text-[#f4f4f4] transition hover:bg-white/10"
          >
            <span className="grid h-7 w-7 place-items-center rounded-full text-[#f4f4f4] ring-1 ring-white/30">{option.icon}</span>
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <span>{option.label}</span>
              <span className="truncate text-sm font-medium text-[#b4b4b4]">{option.model}</span>
            </span>
            {option.value === value ? <span className="text-xl leading-none text-white">✓</span> : null}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        className={`flex h-8 items-center gap-2 rounded-full px-3 text-sm font-semibold transition ${
          open ? "bg-[#31465c] text-[#9dccff]" : "bg-transparent text-[#c7c7c7] hover:bg-white/10"
        }`}
        title="选择聊天或生图"
      >
        <span className={`grid h-6 w-6 place-items-center rounded-full ${open ? "bg-[#243447]" : "bg-white/10"}`}>
          {selected.icon}
        </span>
        <span className="max-w-[180px] truncate">
          {selected.label} {selected.model}
        </span>
        <span className={`text-xs transition-transform ${open ? "rotate-180" : ""}`}>⌄</span>
      </button>
    </div>
  );
}

function SidebarIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.15" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2.8" ry="2.8"></rect>
      <line x1="10" y1="4" x2="10" y2="20"></line>
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5"></line>
      <polyline points="5 12 12 5 19 12"></polyline>
    </svg>
  );
}

function StopGeneratingIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="3" />
    </svg>
  );
}

function NewChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"></circle>
      <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"></polyline>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
    </svg>
  );
}

function ChatGPTMarkIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3927.6813l5.8145 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865a4.504 4.504 0 0 1-1.6513-6.1219zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4945 4.4945 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z"
        fill="currentColor"
      />
    </svg>
  );
}

function getKeyInitial(name?: string) {
  const value = name?.trim();
  return value ? value.slice(0, 1).toUpperCase() : "K";
}

function KeyUsageCard({ accessKey, onLogout }: { accessKey: AccessKeyInfo | null; onLogout: () => void }) {
  const used = accessKey?.usedCount ?? 0;
  const limitText = !accessKey ? "读取中" : accessKey.maxUses === 0 ? "不限" : String(accessKey.maxUses);
  const remainingText = !accessKey ? "读取中" : accessKey.remaining === null ? "不限" : String(accessKey.remaining);
  const progress =
    accessKey && accessKey.maxUses > 0
      ? Math.min(100, Math.max(0, Math.round((accessKey.usedCount / accessKey.maxUses) * 100)))
      : 0;

  return (
    <div className="rounded-xl bg-[#212121] p-3 ring-1 ring-white/5">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-blue-600 text-sm font-semibold text-white ring-1 ring-white/10">
          {getKeyInitial(accessKey?.name)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[#ececec]" title={accessKey?.name || "当前密钥"}>
            {accessKey?.name || "当前密钥"}
          </p>
          <p className="mt-0.5 truncate text-xs text-[#b4b4b4]" title={accessKey?.remark || "访问密钥"}>
            {accessKey?.remark || "访问密钥"}
          </p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-[#171717] px-2 py-2">
          <p className="text-[#8f8f8f]">已用对话</p>
          <p className="mt-1 font-semibold text-[#ececec]">{accessKey ? used : "读取中"}</p>
        </div>
        <div className="rounded-lg bg-[#171717] px-2 py-2">
          <p className="text-[#8f8f8f]">剩余对话</p>
          <p className="mt-1 font-semibold text-[#ececec]">{remainingText}</p>
        </div>
      </div>

      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-[11px] text-[#8f8f8f]">
          <span>对话上限</span>
          <span>{limitText}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-[#333333]">
          <div
            className={`h-full rounded-full ${accessKey?.maxUses === 0 ? "w-full bg-emerald-500/70" : "bg-blue-500"}`}
            style={accessKey?.maxUses === 0 ? undefined : { width: `${progress}%` }}
          />
        </div>
      </div>

      <button
        type="button"
        onClick={onLogout}
        className="mt-3 w-full rounded-full border border-white/20 px-3 py-2 text-center text-xs font-medium text-white transition hover:border-white/35 hover:bg-white/10"
      >
        退出当前密钥
      </button>
    </div>
  );
}

function MessageBubble({
  message,
  onImagePreview
}: {
  message: Message;
  onImagePreview: (src: string, alt: string) => void;
}) {
  const isUser = message.role === "user";
  const imageDownloadName = `generated-image-${message.id}.png`;

  return (
    <article className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={isUser ? "max-w-[78%] rounded-[1.35rem] bg-[#303030] px-5 py-3 text-[#f4f4f4]" : "w-full text-[#f4f4f4]"}>
        {message.kind === "image" && message.imageUrl ? (
          <div className="space-y-3">
            <div className="group relative inline-block max-w-full">
              <button
                type="button"
                onClick={() => onImagePreview(message.imageUrl!, message.content || "生成图片")}
                className="block max-w-full cursor-zoom-in overflow-hidden rounded-2xl text-left"
                title="点击放大"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={message.imageUrl}
                  alt={message.content || "生成图片"}
                  className="max-h-[560px] max-w-full rounded-2xl object-contain ring-1 ring-white/10 transition group-hover:brightness-95"
                />
              </button>
              <a
                href={message.imageUrl}
                download={imageDownloadName}
                onClick={(event) => event.stopPropagation()}
                className="absolute right-3 top-3 rounded-full bg-black/75 px-3 py-2 text-xs font-medium text-white opacity-0 shadow-lg backdrop-blur transition hover:bg-white hover:text-black group-hover:opacity-100"
                title="下载图片"
              >
                下载
              </a>
            </div>
            <MarkdownContent content={message.content} className="text-[#d7d7d7]" />
          </div>
        ) : (
          isUser ? (
            <p className="whitespace-pre-wrap text-[15px] leading-7">{message.content || " "}</p>
          ) : (
            <MarkdownContent content={message.content || " "} />
          )
        )}
      </div>
    </article>
  );
}

function isMarkdownSpecialLine(line: string) {
  return (
    /^\s*```/.test(line) ||
    /^\s{0,3}#{1,6}\s+/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)
  );
}

function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const fenceMatch = line.match(/^\s*```([\w-]*)\s*$/);
    if (fenceMatch) {
      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }

      if (index < lines.length) index += 1;
      blocks.push({
        type: "code",
        language: fenceMatch[1] || "",
        code: codeLines.join("\n")
      });
      continue;
    }

    const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        text: headingMatch[2]
      });
      index += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const itemMatch = lines[index].match(/^\s*[-*+]\s+(.+)$/);
        if (!itemMatch) break;
        items.push(itemMatch[1]);
        index += 1;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const itemMatch = lines[index].match(/^\s*\d+\.\s+(.+)$/);
        if (!itemMatch) break;
        items.push(itemMatch[1]);
        index += 1;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quotes: string[] = [];
      while (index < lines.length) {
        const quoteMatch = lines[index].match(/^\s*>\s?(.*)$/);
        if (!quoteMatch) break;
        quotes.push(quoteMatch[1]);
        index += 1;
      }
      blocks.push({ type: "quote", text: quotes.join(" ") });
      continue;
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    const paragraphLines = [trimmed];
    index += 1;

    while (index < lines.length && lines[index].trim() && !isMarkdownSpecialLine(lines[index])) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }

    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

function parseInlineMarkdown(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(\*\*.+?\*\*|`[^`]+?`|\[[^\]]+?\]\([^)]+?\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let partIndex = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `${keyPrefix}-${partIndex}`;

    if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <strong key={key} className="font-semibold text-[#f4f4f4]">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code key={key} className="rounded-md bg-white/10 px-1.5 py-0.5 font-mono text-[0.9em] text-[#f4f4f4]">
          {token.slice(1, -1)}
        </code>
      );
    } else {
      const linkMatch = token.match(/^\[([^\]]+?)\]\(([^)]+?)\)$/);
      const href = linkMatch?.[2]?.trim() || "";
      const safeHref = /^(https?:|mailto:)/i.test(href) ? href : "";

      nodes.push(
        safeHref ? (
          <a key={key} href={safeHref} target="_blank" rel="noreferrer" className="text-[#8ab4ff] underline decoration-white/30 underline-offset-4 hover:text-[#b7d1ff]">
            {linkMatch?.[1]}
          </a>
        ) : (
          token
        )
      );
    }

    lastIndex = pattern.lastIndex;
    partIndex += 1;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function MarkdownContent({ content, className = "" }: { content: string; className?: string }) {
  const blocks = parseMarkdownBlocks(content || " ");

  return (
    <div className={`text-[15px] leading-7 ${className}`}>
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return <CodeBlock key={index} language={block.language} code={block.code} />;
        }

        if (block.type === "heading") {
          const sizeClass = block.level <= 2 ? "mt-5 text-xl" : block.level === 3 ? "mt-4 text-lg" : "mt-3 text-base";
          return (
            <p key={index} className={`${sizeClass} mb-2 font-semibold text-[#f4f4f4]`}>
              {parseInlineMarkdown(block.text, `h-${index}`)}
            </p>
          );
        }

        if (block.type === "ul") {
          return (
            <ul key={index} className="my-2 list-disc space-y-1 pl-6 marker:text-[#b4b4b4]">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} className="pl-1">
                  {parseInlineMarkdown(item, `ul-${index}-${itemIndex}`)}
                </li>
              ))}
            </ul>
          );
        }

        if (block.type === "ol") {
          return (
            <ol key={index} className="my-2 list-decimal space-y-1 pl-6 marker:text-[#b4b4b4]">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex} className="pl-1">
                  {parseInlineMarkdown(item, `ol-${index}-${itemIndex}`)}
                </li>
              ))}
            </ol>
          );
        }

        if (block.type === "quote") {
          return (
            <blockquote key={index} className="my-3 border-l-2 border-white/20 pl-4 text-[#c7c7c7]">
              {parseInlineMarkdown(block.text, `q-${index}`)}
            </blockquote>
          );
        }

        if (block.type === "hr") {
          return <div key={index} className="my-4 h-px bg-white/10" />;
        }

        if (block.type === "paragraph") {
          return (
            <p key={index} className="my-2 whitespace-pre-wrap">
              {parseInlineMarkdown(block.text, `p-${index}`)}
            </p>
          );
        }

        return null;
      })}
    </div>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  async function copyCode() {
    if (!code) return;

    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="relative my-3 overflow-hidden rounded-2xl bg-[#111111] ring-1 ring-white/10">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3 text-sm text-[#d7d7d7]">
        <div className="flex min-w-0 items-center gap-2">
          <CodeIcon />
          <span className="truncate font-medium text-[#f4f4f4]">{language || "代码"}</span>
        </div>
        <button
          type="button"
          onClick={() => void copyCode()}
          className="group relative grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white transition hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          title={copied ? "已复制" : "复制"}
        >
          <CopyIcon />
          <span className="pointer-events-none absolute right-0 top-full z-10 mt-2 whitespace-nowrap rounded-xl bg-black px-2.5 py-1 text-[13px] font-bold leading-none text-white opacity-0 shadow-lg transition group-hover:opacity-100">
            {copied ? "已复制" : "复制"}
          </span>
        </button>
      </div>
      <pre className="chat-scrollbar overflow-x-auto p-4 text-sm leading-6">
        <code className="font-mono text-[#f4f4f4]">{code || " "}</code>
      </pre>
    </div>
  );
}

function CodeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-white">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="8" y="4" width="12" height="12" rx="3" />
      <rect x="4" y="8" width="12" height="12" rx="3" />
    </svg>
  );
}

function ImageGeneratingPlaceholder() {
  return (
    <article className="flex justify-start">
      <div className="w-full rounded-[1.4rem] px-1 py-3">
        <div className="mb-3 flex items-center gap-2 text-sm text-[#b4b4b4]">
          <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
          正在生成图片，请稍候...
        </div>
        <div className="image-generating-placeholder relative aspect-square w-full max-w-[560px] overflow-hidden rounded-[2rem] bg-[#343434]">
          <div className="image-generating-dots-field absolute inset-[14px]">
            {generatingDots.map((dot) => (
              <span
                key={dot.id}
                className="image-generating-dot"
                style={{
                  left: `${dot.x}%`,
                  top: `${dot.y}%`,
                  width: dot.size,
                  height: dot.size,
                  animationDelay: `${dot.delay}s`
                }}
              />
            ))}
          </div>
          <div className="image-generating-grain absolute inset-0" />
          <div className="absolute inset-0 bg-gradient-to-br from-transparent via-transparent to-black/10" />
        </div>
      </div>
    </article>
  );
}

function MaskEditorModal({
  image,
  existingMask,
  onClose,
  onSave
}: {
  image: InputImage | null;
  existingMask: string | null;
  onClose: () => void;
  onSave: (targetImage: InputImage, maskDataUrl: string) => void;
}) {
  const imageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [tool, setTool] = useState<"brush" | "eraser">("brush");
  const [brushSize, setBrushSize] = useState(64);
  const [error, setError] = useState("");

  function fillWhiteMask(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("当前浏览器不支持 Canvas。");
    context.globalCompositeOperation = "source-over";
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  function renderPreview() {
    const previewCanvas = previewCanvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    if (!previewCanvas || !maskCanvas) return;

    const context = previewCanvas.getContext("2d");
    if (!context) return;

    context.save();
    context.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    context.globalCompositeOperation = "source-over";
    context.fillStyle = "rgba(59, 130, 246, 0.55)";
    context.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    context.globalCompositeOperation = "destination-out";
    context.drawImage(maskCanvas, 0, 0);
    context.restore();
  }

  useEffect(() => {
    if (!image) return;
    const currentImage = image;
    let cancelled = false;

    async function load() {
      try {
        setError("");
        const source = await loadHtmlImage(currentImage.dataUrl);
        if (cancelled) return;

        const nextSize = {
          width: source.naturalWidth,
          height: source.naturalHeight
        };
        const imageCanvas = imageCanvasRef.current;
        const previewCanvas = previewCanvasRef.current;
        const maskCanvas = maskCanvasRef.current;
        if (!imageCanvas || !previewCanvas || !maskCanvas) return;

        for (const canvas of [imageCanvas, previewCanvas, maskCanvas]) {
          canvas.width = nextSize.width;
          canvas.height = nextSize.height;
        }

        const imageContext = imageCanvas.getContext("2d");
        if (!imageContext) throw new Error("当前浏览器不支持 Canvas。");
        imageContext.clearRect(0, 0, imageCanvas.width, imageCanvas.height);
        imageContext.drawImage(source, 0, 0);
        fillWhiteMask(maskCanvas);

        if (existingMask) {
          const maskImage = await loadHtmlImage(existingMask).catch(() => null);
          if (!cancelled && maskImage && maskImage.naturalWidth === nextSize.width && maskImage.naturalHeight === nextSize.height) {
            const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
            maskContext?.drawImage(maskImage, 0, 0);
          }
        }

        if (!cancelled) {
          setSize(nextSize);
          renderPreview();
        }
      } catch (error) {
        if (!cancelled) setError(error instanceof Error ? error.message : "遮罩编辑器加载失败。");
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [image, existingMask]);

  if (!image) return null;

  function getCanvasPoint(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height
    };
  }

  function drawDot(point: { x: number; y: number }) {
    const canvas = maskCanvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) return;

    context.save();
    context.globalCompositeOperation = tool === "brush" ? "destination-out" : "source-over";
    context.fillStyle = "#fff";
    context.beginPath();
    context.arc(point.x, point.y, brushSize / 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
    renderPreview();
  }

  function drawLine(from: { x: number; y: number }, to: { x: number; y: number }) {
    const canvas = maskCanvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) return;

    context.save();
    context.globalCompositeOperation = tool === "brush" ? "destination-out" : "source-over";
    context.strokeStyle = "#fff";
    context.lineWidth = brushSize;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    context.restore();
    renderPreview();
  }

  function handleSave() {
    const imageCanvas = imageCanvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    if (!imageCanvas || !maskCanvas || !image) return;

    onSave(
      {
        id: createLocalImageId(),
        name: image.name,
        dataUrl: imageCanvas.toDataURL("image/png")
      },
      maskCanvas.toDataURL("image/png")
    );
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className="flex max-h-full w-full max-w-5xl flex-col rounded-3xl bg-[#202020] p-4 text-[#ececec] shadow-2xl ring-1 ring-white/10">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">编辑遮罩</h3>
            <p className="mt-1 text-xs text-[#a3a3a3]">蓝色透明覆盖区域会被编辑；橡皮会恢复未编辑区域。</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-white/10 px-3 py-1.5 text-sm transition hover:bg-white/15">
            关闭
          </button>
        </div>

        {error ? <div className="mb-3 rounded-2xl bg-red-500/10 px-4 py-3 text-sm text-red-200 ring-1 ring-red-500/20">{error}</div> : null}

        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-3xl bg-black/35 p-3">
          <div
            className="relative w-[900px] max-w-[90vw] overflow-hidden rounded-2xl bg-black"
            style={{ aspectRatio: size ? `${size.width} / ${size.height}` : "1 / 1", maxHeight: "65vh" }}
          >
            <canvas ref={imageCanvasRef} className="absolute inset-0 h-full w-full" />
            <canvas
              ref={previewCanvasRef}
              className="absolute inset-0 h-full w-full touch-none"
              onPointerDown={(event) => {
                event.preventDefault();
                drawingRef.current = true;
                event.currentTarget.setPointerCapture(event.pointerId);
                const point = getCanvasPoint(event);
                lastPointRef.current = point;
                drawDot(point);
              }}
              onPointerMove={(event) => {
                if (!drawingRef.current || !lastPointRef.current) return;
                event.preventDefault();
                const point = getCanvasPoint(event);
                drawLine(lastPointRef.current, point);
                lastPointRef.current = point;
              }}
              onPointerUp={(event) => {
                drawingRef.current = false;
                lastPointRef.current = null;
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                drawingRef.current = false;
                lastPointRef.current = null;
              }}
            />
            <canvas ref={maskCanvasRef} className="hidden" />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setTool("brush")}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${tool === "brush" ? "bg-blue-500 text-white" : "bg-white/10 text-[#d7d7d7] hover:bg-white/15"}`}
            >
              画笔
            </button>
            <button
              type="button"
              onClick={() => setTool("eraser")}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${tool === "eraser" ? "bg-blue-500 text-white" : "bg-white/10 text-[#d7d7d7] hover:bg-white/15"}`}
            >
              橡皮
            </button>
            <label className="flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm text-[#d7d7d7]">
              笔刷 {brushSize}
              <input
                type="range"
                min={8}
                max={220}
                value={brushSize}
                onChange={(event) => setBrushSize(Number(event.target.value))}
                className="w-32 accent-blue-500"
              />
            </label>
            <button
              type="button"
              onClick={() => {
                const canvas = maskCanvasRef.current;
                if (!canvas) return;
                fillWhiteMask(canvas);
                renderPreview();
              }}
              className="rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-[#d7d7d7] transition hover:bg-white/15"
            >
              清空遮罩
            </button>
          </div>

          <button type="button" onClick={handleSave} className="rounded-full bg-white px-5 py-2 text-sm font-semibold text-black transition hover:bg-blue-100">
            保存遮罩
          </button>
        </div>
      </div>
    </div>
  );
}

function ImagePreviewModal({
  src,
  alt,
  onClose
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);
  const zoomPercent = Math.round(zoom * 100);

  function clampZoom(nextZoom: number) {
    return Math.min(4, Math.max(0.5, Number(nextZoom.toFixed(2))));
  }

  function applyView(nextZoom: number, nextPan: { x: number; y: number }) {
    zoomRef.current = nextZoom;
    panRef.current = nextPan;
    setZoom(nextZoom);
    setPan(nextPan);
  }

  function updateZoom(nextZoom: number, anchor?: { x: number; y: number }) {
    const next = clampZoom(nextZoom);
    const previous = zoomRef.current;
    const viewer = viewerRef.current;

    if (!viewer || next === previous) {
      applyView(next, next === 1 ? { x: 0, y: 0 } : panRef.current);
      return;
    }

    const rect = viewer.getBoundingClientRect();
    const anchorX = anchor?.x ?? rect.left + rect.width / 2;
    const anchorY = anchor?.y ?? rect.top + rect.height / 2;
    const pointX = anchorX - (rect.left + rect.width / 2);
    const pointY = anchorY - (rect.top + rect.height / 2);
    const currentPan = panRef.current;

    const nextPan =
      next === 1
        ? { x: 0, y: 0 }
        : {
            x: pointX - ((pointX - currentPan.x) / previous) * next,
            y: pointY - ((pointY - currentPan.y) / previous) * next
          };

    applyView(next, nextPan);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div className="relative flex h-full w-full flex-col items-center justify-center" onClick={(event) => event.stopPropagation()}>
        <div className="absolute top-0 z-10 flex flex-wrap items-center justify-center gap-2 rounded-full bg-slate-950/55 p-2 text-white shadow-xl ring-1 ring-white/10 backdrop-blur">
          <a
            href={src}
            download="generated-image.png"
            className="rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-emerald-100"
          >
            下载图片
          </a>
          <button
            type="button"
            onClick={() => updateZoom(zoomRef.current - 0.25)}
            className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-lg transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={zoom <= 0.5}
            title="缩小"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => updateZoom(1)}
            className="h-9 rounded-full bg-white/10 px-3 text-sm font-medium transition hover:bg-white/20"
            title="重置缩放"
          >
            {zoomPercent}%
          </button>
          <button
            type="button"
            onClick={() => updateZoom(zoomRef.current + 0.25)}
            className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-lg transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={zoom >= 4}
            title="放大"
          >
            +
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
          >
            关闭
          </button>
        </div>

        <div
          ref={viewerRef}
          className="mt-14 grid h-[calc(100vh-6rem)] w-[94vw] touch-none place-items-center overflow-hidden rounded-3xl"
          onWheel={(event) => {
            event.preventDefault();
            updateZoom(zoomRef.current + (event.deltaY < 0 ? 0.12 : -0.12), {
              x: event.clientX,
              y: event.clientY
            });
          }}
          onPointerDown={(event) => {
            dragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              panX: panRef.current.x,
              panY: panRef.current.y
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag) return;
            const nextPan = {
              x: drag.panX + event.clientX - drag.startX,
              y: drag.panY + event.clientY - drag.startY
            };
            panRef.current = nextPan;
            setPan(nextPan);
          }}
          onPointerUp={(event) => {
            dragRef.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            dragRef.current = null;
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            draggable={false}
            className="max-h-[82vh] max-w-[92vw] select-none rounded-3xl object-contain shadow-2xl ring-1 ring-white/20"
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
              transformOrigin: "center center",
              willChange: "transform",
              cursor: dragRef.current ? "grabbing" : "grab"
            }}
            onDoubleClick={() => updateZoom(zoomRef.current === 1 ? 2 : 1)}
          />
        </div>
      </div>
    </div>
  );
}
