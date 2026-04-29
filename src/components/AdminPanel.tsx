"use client";

import { Dispatch, FormEvent, SetStateAction, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type AccessKey = {
  id: string;
  name: string;
  remark: string;
  key: string;
  enabled: boolean;
  maxUses: number;
  usedCount: number;
  createdAt: string;
  lastUsedAt: string | null;
};

type AdminConfig = {
  configPath: string;
  keyCount: number;
  keys: AccessKey[];
};

type ProviderConfig = {
  configPath: string;
  apiKeys: string[];
  baseUrl: string;
  chatModel: string;
  imageModel: string;
  responsesImageModel: string;
  imageApiMode: "images" | "responses";
  imageCompatibilityMode: "auto" | "standard" | "codex";
};

type ProviderDraft = {
  apiKeysText: string;
  baseUrl: string;
  chatModel: string;
  imageModel: string;
  responsesImageModel: string;
  imageApiMode: "images" | "responses";
  imageCompatibilityMode: "auto" | "standard" | "codex";
};

type KeyDraft = {
  name: string;
  remark: string;
  maxUses: string;
  enabled: boolean;
};

type AdminSection = "provider" | "access" | "system";

export default function AdminPanel() {
  const router = useRouter();
  const [section, setSection] = useState<AdminSection>("provider");
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [provider, setProvider] = useState<ProviderConfig | null>(null);
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>({
    apiKeysText: "",
    baseUrl: "",
    chatModel: "",
    imageModel: "",
    responsesImageModel: "",
    imageApiMode: "images",
    imageCompatibilityMode: "auto"
  });
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, KeyDraft>>({});
  const [newKeyName, setNewKeyName] = useState("临时访问密钥");
  const [newKeyRemark, setNewKeyRemark] = useState("");
  const [newKeyMaxUses, setNewKeyMaxUses] = useState("0");
  const [newAdminPassword, setNewAdminPassword] = useState("");
  const [copiedKeyId, setCopiedKeyId] = useState("");
  const [showChatKeyModal, setShowChatKeyModal] = useState(false);
  const [selectingChatKeyId, setSelectingChatKeyId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const keys = config?.keys ?? [];
  const totalRemaining = useMemo(
    () =>
      keys.reduce((sum, key) => {
        if (!key.enabled) return sum;
        if (key.maxUses === 0) return sum;
        return sum + Math.max(0, key.maxUses - key.usedCount);
      }, 0),
    [keys]
  );

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => ({}));

    if (response.status === 401 || response.status === 403) {
      router.replace("/login?admin=1");
      throw new Error(payload.error || "需要管理员权限。");
    }

    if (!response.ok) {
      throw new Error(payload.error || "请求失败。");
    }

    return payload as T;
  }

  function syncDrafts(nextKeys: AccessKey[]) {
    setDrafts(
      Object.fromEntries(
        nextKeys.map((key) => [
          key.id,
          {
            name: key.name,
            remark: key.remark || "",
            maxUses: String(key.maxUses),
            enabled: key.enabled
          }
        ])
      )
    );
  }

  function syncProviderDraft(nextProvider: ProviderConfig) {
    setProviderDraft({
      apiKeysText: nextProvider.apiKeys.join(","),
      baseUrl: nextProvider.baseUrl,
      chatModel: nextProvider.chatModel,
      imageModel: nextProvider.imageModel,
      responsesImageModel: nextProvider.responsesImageModel,
      imageApiMode: nextProvider.imageApiMode,
      imageCompatibilityMode: nextProvider.imageCompatibilityMode
    });
  }

  async function loadAll() {
    setLoading(true);
    setError("");

    try {
      const [authPayload, providerPayload] = await Promise.all([
        apiJson<{ config: AdminConfig }>("/api/admin/config"),
        apiJson<{ provider: ProviderConfig }>("/api/admin/provider")
      ]);

      setConfig(authPayload.config);
      syncDrafts(authPayload.config.keys);
      setProvider(providerPayload.provider);
      syncProviderDraft(providerPayload.provider);
    } catch (error) {
      setError(error instanceof Error ? error.message : "加载失败。");
    } finally {
      setLoading(false);
    }
  }

  async function loadAccessConfig() {
    setError("");
    const payload = await apiJson<{ config: AdminConfig }>("/api/admin/config");
    setConfig(payload.config);
    syncDrafts(payload.config.keys);
  }

  async function saveProvider(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");

    try {
      const payload = await apiJson<{ provider: ProviderConfig }>("/api/admin/provider", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(providerDraft)
      });

      setProvider(payload.provider);
      syncProviderDraft(payload.provider);
      setNotice("服务商配置已保存，聊天和生图会立即使用新配置。");
    } catch (error) {
      setError(error instanceof Error ? error.message : "服务商配置保存失败。");
    } finally {
      setSaving(false);
    }
  }

  async function testProvider() {
    setTesting(true);
    setError("");
    setNotice("");

    try {
      const payload = await apiJson<{ message: string; models?: string[] }>("/api/admin/provider", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(providerDraft)
      });

      setFetchedModels(payload.models ?? []);
      setNotice(payload.message || "服务商检测成功。");
    } catch (error) {
      setError(error instanceof Error ? error.message : "服务商检测失败。");
    } finally {
      setTesting(false);
    }
  }

  async function createKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");

    try {
      const payload = await apiJson<{ key: AccessKey }>("/api/admin/keys", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: newKeyName,
          remark: newKeyRemark,
          maxUses: Number(newKeyMaxUses) || 0
        })
      });

      const nextKeys = [payload.key, ...keys];
      setConfig((previous) =>
        previous
          ? {
              ...previous,
              keyCount: nextKeys.length,
              keys: nextKeys
            }
          : previous
      );
      syncDrafts(nextKeys);
      setNewKeyRemark("");
      setNotice("已生成新的访问密钥。");
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : "生成失败。");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveKey(id: string, resetUsedCount = false) {
    const draft = drafts[id];
    if (!draft) return;

    setSaving(true);
    setError("");
    setNotice("");

    try {
      const payload = await apiJson<{ key: AccessKey }>("/api/admin/keys", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          id,
          name: draft.name,
          remark: draft.remark,
          enabled: draft.enabled,
          maxUses: Number(draft.maxUses) || 0,
          resetUsedCount
        })
      });

      const nextKeys = keys.map((key) => (key.id === id ? payload.key : key));
      setConfig((previous) => (previous ? { ...previous, keys: nextKeys } : previous));
      syncDrafts(nextKeys);
      setNotice(resetUsedCount ? "已重置对话次数。" : "密钥设置已保存。");
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存失败。");
    } finally {
      setSaving(false);
    }
  }

  async function removeKey(id: string) {
    if (!window.confirm("确定删除这个访问密钥吗？删除后无法用它登录。")) return;

    setSaving(true);
    setError("");
    setNotice("");

    try {
      await apiJson<{ ok: boolean }>("/api/admin/keys", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          id
        })
      });

      const nextKeys = keys.filter((key) => key.id !== id);
      setConfig((previous) =>
        previous
          ? {
              ...previous,
              keyCount: nextKeys.length,
              keys: nextKeys
            }
          : previous
      );
      syncDrafts(nextKeys);
      setNotice("密钥已删除。");
    } catch (error) {
      setError(error instanceof Error ? error.message : "删除失败。");
    } finally {
      setSaving(false);
    }
  }

  async function changeAdminPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");

    try {
      await apiJson<{ ok: boolean }>("/api/admin/config", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          adminPassword: newAdminPassword
        })
      });

      setNewAdminPassword("");
      setNotice("管理密码已更新，配置文件已同步。");
    } catch (error) {
      setError(error instanceof Error ? error.message : "更新管理密码失败。");
    } finally {
      setSaving(false);
    }
  }

  async function copyKey(key: AccessKey) {
    await navigator.clipboard.writeText(key.key);
    setCopiedKeyId(key.id);
    window.setTimeout(() => setCopiedKeyId(""), 1400);
  }

  async function chooseChatKey(keyId: string) {
    setSelectingChatKeyId(keyId);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/admin/keys", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          id: keyId
        })
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || "选择访问密钥失败。");
      }

      setShowChatKeyModal(false);
      router.replace("/chat");
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "选择访问密钥失败。");
    } finally {
      setSelectingChatKeyId("");
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", {
      method: "POST"
    });
    router.replace("/login");
    router.refresh();
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-slate-50 px-4 py-6 text-slate-950 md:px-8">
      {/* 动态背景修饰 */}
      <div className="absolute -top-[20%] -left-[10%] w-[70%] h-[70%] rounded-full bg-emerald-400/10 blur-[120px] mix-blend-multiply pointer-events-none" />
      <div className="absolute -bottom-[20%] -right-[10%] w-[70%] h-[70%] rounded-full bg-blue-400/10 blur-[120px] mix-blend-multiply pointer-events-none" />
      <div className="relative z-10 mx-auto grid max-w-7xl gap-6 lg:grid-cols-[260px_1fr]">
        <aside className="h-fit rounded-[1.75rem] bg-slate-900/95 p-4 text-white shadow-2xl backdrop-blur-xl ring-1 ring-white/10 lg:sticky lg:top-6">
          <div className="mb-6 rounded-3xl bg-white/5 p-4 ring-1 ring-white/10">
            <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-emerald-400/10 px-2.5 py-1 text-xs font-medium text-emerald-300 ring-1 ring-emerald-400/20">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
              </span>
              Admin Console
            </div>
            <h1 className="mt-1 text-xl font-bold tracking-tight">后台管理</h1>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">配置服务商、模型、API 密钥和访问限制。</p>
          </div>

          <nav className="space-y-2">
            <SidebarButton active={section === "provider"} label="服务商配置" hint="API 地址 / 模型 / 密钥" onClick={() => setSection("provider")} />
            <SidebarButton active={section === "access"} label="访问密钥" hint="登录密钥 / 对话限制" onClick={() => setSection("access")} />
            <SidebarButton active={section === "system"} label="系统管理" hint="管理密码 / 系统安全" onClick={() => setSection("system")} />
          </nav>

          <div className="mt-6 space-y-2 border-t border-white/10 pt-4">
            <button
              onClick={() => setShowChatKeyModal(true)}
              className="block w-full rounded-2xl px-4 py-3 text-left text-sm font-medium text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
            >
              选择密钥进入聊天室
            </button>
            <button
              onClick={() => void logout()}
              className="w-full rounded-2xl px-4 py-3 text-left text-sm font-medium text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
            >
              退出管理后台
            </button>
          </div>
        </aside>

        <section className="min-w-0">
          <header className="mb-6 rounded-[1.75rem] bg-white/70 p-6 shadow-sm backdrop-blur-xl ring-1 ring-slate-200/50">
            <p className="mb-2 text-sm font-medium text-emerald-600">
              {section === "provider" ? "Provider Settings" : section === "access" ? "Access Control" : "System Settings"}
            </p>
            <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
              {section === "provider" ? "服务商配置" : section === "access" ? "访问密钥管理" : "系统管理"}
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-500">
              {section === "provider"
                ? `配置文件：${provider?.configPath || "config/openai.json"}。聊天和生图会读取这里的服务商配置。`
                : section === "access"
                  ? `配置文件：${config?.configPath || "config/auth.json"}。访问密钥会写回这里。`
                  : `配置文件：${config?.configPath || "config/auth.json"}。管理密码会写回这里。`}
            </p>
          </header>

          <div className="mb-4 min-h-[44px]" aria-live="polite">
            {error ? (
              <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600 ring-1 ring-red-100">{error}</div>
            ) : notice ? (
              <div className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700 ring-1 ring-emerald-100">{notice}</div>
            ) : null}
          </div>

          {section === "provider" ? (
            <ProviderSettings
              draft={providerDraft}
              saving={saving}
              testing={testing}
              loading={loading}
              setDraft={setProviderDraft}
              onSubmit={saveProvider}
              onTest={() => void testProvider()}
              fetchedModels={fetchedModels}
            />
          ) : section === "access" ? (
            <AccessKeysSection
              keys={keys}
              drafts={drafts}
              totalRemaining={totalRemaining}
              loading={loading}
              saving={saving}
              copiedKeyId={copiedKeyId}
              newKeyName={newKeyName}
              newKeyRemark={newKeyRemark}
              newKeyMaxUses={newKeyMaxUses}
              setDrafts={setDrafts}
              setNewKeyName={setNewKeyName}
              setNewKeyRemark={setNewKeyRemark}
              setNewKeyMaxUses={setNewKeyMaxUses}
              createKey={createKey}
              reload={() => void loadAccessConfig()}
              saveKey={(id, reset) => void saveKey(id, reset)}
              removeKey={(id) => void removeKey(id)}
              copyKey={(key) => void copyKey(key)}
            />
          ) : (
            <SystemSettings
              saving={saving}
              newAdminPassword={newAdminPassword}
              setNewAdminPassword={setNewAdminPassword}
              changeAdminPassword={changeAdminPassword}
            />
          )}
        </section>
      </div>
      {showChatKeyModal ? (
        <SelectChatKeyModal
          keys={keys}
          selectingKeyId={selectingChatKeyId}
          onSelect={(keyId) => void chooseChatKey(keyId)}
          onClose={() => setShowChatKeyModal(false)}
        />
      ) : null}
    </main>
  );
}

function SelectChatKeyModal({
  keys,
  selectingKeyId,
  onSelect,
  onClose
}: {
  keys: AccessKey[];
  selectingKeyId: string;
  onSelect: (keyId: string) => void;
  onClose: () => void;
}) {
  const sortedKeys = [...keys].sort((left, right) => getTimestamp(right.createdAt) - getTimestamp(left.createdAt));
  const availableCount = sortedKeys.filter((key) => key.enabled && (key.maxUses === 0 || key.usedCount < key.maxUses)).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6 backdrop-blur-sm">
      <section className="w-full max-w-3xl rounded-[1.75rem] bg-white p-6 shadow-2xl ring-1 ring-slate-200">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-xl font-semibold">选择访问密钥进入聊天室</h3>
            <p className="mt-1 text-sm text-slate-500">管理员也必须选择一个访问密钥使用，聊天和生图会消耗该密钥的对话次数。</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-500 transition hover:bg-slate-200"
          >
            关闭
          </button>
        </div>

        {sortedKeys.length === 0 ? (
          <div className="rounded-2xl bg-slate-50 p-6 text-sm text-slate-500 ring-1 ring-slate-200">暂无访问密钥，请先在访问密钥管理中新增。</div>
        ) : (
          <div className="max-h-[460px] space-y-3 overflow-y-auto pr-1">
            {sortedKeys.map((key) => {
              const remaining = key.maxUses === 0 ? "不限" : String(Math.max(0, key.maxUses - key.usedCount));
              const unavailable = !key.enabled || (key.maxUses > 0 && key.usedCount >= key.maxUses);
              const reason = !key.enabled ? "已停用" : key.maxUses > 0 && key.usedCount >= key.maxUses ? "次数已用完" : "";

              return (
                <div key={key.id} className="rounded-3xl bg-slate-50 p-4 ring-1 ring-slate-200">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-slate-900">{key.name}</p>
                        <span
                          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                            key.enabled ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"
                          }`}
                        >
                          {key.enabled ? "启用" : "停用"}
                        </span>
                        {reason ? <span className="rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-600">{reason}</span> : null}
                      </div>
                      {key.remark ? <p className="mt-1 truncate text-sm text-slate-500">备注：{key.remark}</p> : null}
                      <p className="mt-2 text-xs text-slate-500">
                        已用对话：{key.usedCount} · 剩余对话：{remaining} · 新增：{formatTime(key.createdAt)}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={unavailable || Boolean(selectingKeyId)}
                      onClick={() => onSelect(key.id)}
                      className="shrink-0 rounded-2xl bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      {selectingKeyId === key.id ? "进入中..." : "使用此密钥"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {sortedKeys.length > 0 && availableCount === 0 ? (
          <p className="mt-4 text-sm text-red-600">没有可用密钥，请先启用密钥或重置/提高对话上限。</p>
        ) : null}
      </section>
    </div>
  );
}

function SidebarButton({
  active,
  label,
  hint,
  onClick
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`group w-full rounded-2xl px-4 py-3 text-left transition-all ${
        active ? "bg-white/10 text-white shadow-sm ring-1 ring-white/20" : "text-slate-400 hover:bg-white/5 hover:text-white"
      }`}
    >
      <span className={`block text-sm font-medium ${active ? "text-white" : ""}`}>{label}</span>
      <span className={`mt-1 block text-xs ${active ? "text-slate-300" : "text-slate-500 group-hover:text-slate-400"}`}>{hint}</span>
    </button>
  );
}

function ProviderSettings({
  draft,
  saving,
  testing,
  loading,
  fetchedModels,
  setDraft,
  onSubmit,
  onTest
}: {
  draft: ProviderDraft;
  saving: boolean;
  testing: boolean;
  loading: boolean;
  fetchedModels: string[];
  setDraft: (draft: ProviderDraft) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTest: () => void;
}) {
  const previewBase = normalizeClientBaseUrl(draft.baseUrl);

  return (
    <form onSubmit={onSubmit}>
      <section className="rounded-[1.75rem] bg-white/70 p-6 shadow-sm backdrop-blur-xl ring-1 ring-slate-200/50">
        <div className="mb-6">
          <h3 className="text-xl font-semibold">服务商连接配置</h3>
          <p className="mt-1 text-sm text-slate-500">API 密钥、接口地址和模型统一在这里维护；保存后聊天和生图会立即使用新配置。</p>
        </div>

        <div className="grid gap-5">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">API 密钥</span>
            <input
              type="text"
              value={draft.apiKeysText}
              onChange={(event) => setDraft({ ...draft, apiKeysText: event.target.value })}
              placeholder="sk-... 或多个密钥用英文逗号分隔"
              className="mt-2 h-12 w-full rounded-2xl border border-slate-200/50 bg-white/50 px-4 outline-none transition focus:border-emerald-400 focus:bg-white focus:ring-4 focus:ring-emerald-100"
            />
            <span className="mt-2 block text-xs text-slate-400">密钥以明文显示，方便查看和编辑；多个密钥使用英文逗号分隔。</span>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-700">API 地址</span>
            <input
              value={draft.baseUrl}
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              placeholder="https://api.openai.com/v1"
              className="mt-2 h-12 w-full rounded-2xl border border-slate-200/50 bg-white/50 px-4 outline-none transition focus:border-emerald-400 focus:bg-white focus:ring-4 focus:ring-emerald-100"
            />
            <span className="mt-2 block text-xs text-slate-400">填写 OpenAI 或兼容服务商地址；如果未包含 /v1，保存时会自动补全。</span>
          </label>

          <div className="grid gap-2 rounded-3xl bg-slate-50 px-4 py-3 text-xs text-slate-500 ring-1 ring-slate-200 md:grid-cols-2">
            <p>聊天预览：{previewBase}/chat/completions</p>
            <p>生图预览：{draft.imageApiMode === "responses" ? `${previewBase}/responses` : `${previewBase}/images/generations`}</p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="text-sm font-medium text-slate-700">聊天模型</span>
              <input
                value={draft.chatModel}
                onChange={(event) => setDraft({ ...draft, chatModel: event.target.value })}
                placeholder="gpt-5.5"
                className="mt-2 h-12 w-full rounded-2xl border border-slate-200/50 bg-white/50 px-4 outline-none transition focus:border-emerald-400 focus:bg-white focus:ring-4 focus:ring-emerald-100"
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-slate-700">生图模型</span>
              <input
                value={draft.imageModel}
                onChange={(event) => setDraft({ ...draft, imageModel: event.target.value })}
                placeholder="gpt-image-2"
                className="mt-2 h-12 w-full rounded-2xl border border-slate-200/50 bg-white/50 px-4 outline-none transition focus:border-emerald-400 focus:bg-white focus:ring-4 focus:ring-emerald-100"
              />
              <span className="mt-2 block text-xs text-slate-400">Images API 模式使用，例如 gpt-image-2。</span>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-slate-700">Responses 生图模型</span>
              <input
                value={draft.responsesImageModel}
                onChange={(event) => setDraft({ ...draft, responsesImageModel: event.target.value })}
                placeholder="gpt-5.5"
                className="mt-2 h-12 w-full rounded-2xl border border-slate-200/50 bg-white/50 px-4 outline-none transition focus:border-emerald-400 focus:bg-white focus:ring-4 focus:ring-emerald-100"
              />
              <span className="mt-2 block text-xs text-slate-400">Responses API 模式使用，需要支持 image_generation 工具。</span>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-slate-700">生图接口模式</span>
              <select
                value={draft.imageApiMode}
                onChange={(event) => setDraft({ ...draft, imageApiMode: event.target.value as ProviderDraft["imageApiMode"] })}
                className="mt-2 h-12 w-full rounded-2xl border border-slate-200/50 bg-white/50 px-4 outline-none transition focus:border-emerald-400 focus:bg-white focus:ring-4 focus:ring-emerald-100"
              >
                <option value="images">Images API (/v1/images)</option>
                <option value="responses">Responses API (/v1/responses)</option>
              </select>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-slate-700">生图兼容模式</span>
              <select
                value={draft.imageCompatibilityMode}
                onChange={(event) => setDraft({ ...draft, imageCompatibilityMode: event.target.value as ProviderDraft["imageCompatibilityMode"] })}
                className="mt-2 h-12 w-full rounded-2xl border border-slate-200/50 bg-white/50 px-4 outline-none transition focus:border-emerald-400 focus:bg-white focus:ring-4 focus:ring-emerald-100"
              >
                <option value="auto">自动检测 Codex CLI</option>
                <option value="standard">标准 OpenAI</option>
                <option value="codex">Codex CLI 兼容</option>
              </select>
              <span className="mt-2 block text-xs text-slate-400">自动模式会在 quality 不兼容或返回字段异常时缓存并切换兼容流程。</span>
            </label>
          </div>

          {fetchedModels.length > 0 ? (
            <div className="rounded-3xl bg-slate-50 p-4 ring-1 ring-slate-200">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-800">服务商返回模型</p>
                  <p className="mt-1 text-xs text-slate-500">可快速设为聊天模型或生图模型；也可以手动输入任意模型 ID。</p>
                </div>
                <span className="rounded-full bg-white px-3 py-1 text-xs text-slate-500 ring-1 ring-slate-200">
                  {fetchedModels.length}
                </span>
              </div>
              <div className="flex max-h-56 flex-wrap gap-2 overflow-y-auto">
                {fetchedModels.map((model) => (
                  <div key={model} className="flex items-center gap-1 rounded-full bg-white py-1 pl-3 pr-1 ring-1 ring-slate-200">
                    <span className="max-w-56 truncate text-xs font-medium text-slate-700">{model}</span>
                    <button
                      type="button"
                      onClick={() => setDraft({ ...draft, chatModel: model })}
                      className="rounded-full px-2 py-1 text-[11px] text-emerald-700 transition hover:bg-emerald-50"
                      title="设为聊天模型"
                    >
                      聊天
                    </button>
                    <button
                      type="button"
                      onClick={() => setDraft({ ...draft, imageModel: model })}
                      className="rounded-full px-2 py-1 text-[11px] text-blue-700 transition hover:bg-blue-50"
                      title="设为生图模型"
                    >
                      生图
                    </button>
                    <button
                      type="button"
                      onClick={() => setDraft({ ...draft, responsesImageModel: model })}
                      className="rounded-full px-2 py-1 text-[11px] text-purple-700 transition hover:bg-purple-50"
                      title="设为 Responses 生图模型"
                    >
                      响应生图
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-6 flex flex-wrap gap-3 border-t border-slate-200/60 pt-5">
          <button
            disabled={saving || loading}
            className="rounded-2xl bg-slate-950 px-6 py-3 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:bg-slate-300"
          >
            {saving ? "保存中..." : "保存服务商配置"}
          </button>
          <button
            type="button"
            disabled={testing || loading}
            onClick={onTest}
            className="rounded-2xl bg-white px-6 py-3 text-sm font-medium ring-1 ring-slate-200 transition hover:bg-slate-50 disabled:text-slate-300"
          >
            {testing ? "检测中..." : "检测服务商"}
          </button>
        </div>
      </section>
    </form>
  );
}

function AccessKeysSection({
  keys,
  drafts,
  totalRemaining,
  loading,
  saving,
  copiedKeyId,
  newKeyName,
  newKeyRemark,
  newKeyMaxUses,
  setDrafts,
  setNewKeyName,
  setNewKeyRemark,
  setNewKeyMaxUses,
  createKey,
  reload,
  saveKey,
  removeKey,
  copyKey
}: {
  keys: AccessKey[];
  drafts: Record<string, KeyDraft>;
  totalRemaining: number;
  loading: boolean;
  saving: boolean;
  copiedKeyId: string;
  newKeyName: string;
  newKeyRemark: string;
  newKeyMaxUses: string;
  setDrafts: Dispatch<SetStateAction<Record<string, KeyDraft>>>;
  setNewKeyName: (value: string) => void;
  setNewKeyRemark: (value: string) => void;
  setNewKeyMaxUses: (value: string) => void;
  createKey: (event: FormEvent<HTMLFormElement>) => Promise<boolean>;
  reload: () => void;
  saveKey: (id: string, reset?: boolean) => void;
  removeKey: (id: string) => void;
  copyKey: (key: AccessKey) => void;
}) {
  const [currentPage, setCurrentPage] = useState(1);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const PAGE_SIZE = 10;
  const sortedKeys = useMemo(
    () => [...keys].sort((left, right) => getTimestamp(right.createdAt) - getTimestamp(left.createdAt)),
    [keys]
  );
  const totalPages = Math.max(1, Math.ceil(sortedKeys.length / PAGE_SIZE));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pageStartIndex = (safeCurrentPage - 1) * PAGE_SIZE;
  const pagedKeys = sortedKeys.slice(pageStartIndex, pageStartIndex + PAGE_SIZE);
  const displayStart = sortedKeys.length === 0 ? 0 : pageStartIndex + 1;
  const displayEnd = Math.min(pageStartIndex + pagedKeys.length, sortedKeys.length);

  useEffect(() => {
    setCurrentPage(1);
  }, [keys.length]);

  return (
    <>
      <section className="mb-6 grid gap-4 md:grid-cols-3">
        <StatCard label="访问密钥" value={loading ? "..." : String(keys.length)} hint="可查看、复制、停用和删除" />
        <StatCard
          label="启用中"
          value={loading ? "..." : String(keys.filter((key) => key.enabled).length)}
          hint="已停用密钥不能登录"
        />
        <StatCard label="剩余对话次数" value={loading ? "..." : String(totalRemaining)} hint="0 次对话上限表示不限制" />
      </section>

      <section className="space-y-6">
        <section className="rounded-[1.75rem] bg-white/70 p-6 shadow-sm backdrop-blur-xl ring-1 ring-slate-200/50">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold">访问密钥列表</h3>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowCreateModal(true)}
                className="rounded-2xl bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-600"
              >
                新增密钥
              </button>
              <button onClick={reload} className="rounded-2xl bg-slate-100 px-4 py-2 text-sm font-medium transition hover:bg-slate-200">
                刷新
              </button>
            </div>
          </div>

          {loading ? (
            <div className="rounded-2xl bg-slate-50 p-6 text-sm text-slate-500">正在加载...</div>
          ) : keys.length === 0 ? (
            <div className="rounded-2xl bg-slate-50 p-6 text-sm text-slate-500">暂无访问密钥，请先生成。</div>
          ) : (
            <>
              <div className="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-slate-200">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1540px] divide-y divide-slate-200 text-left text-sm">
                    <thead className="bg-slate-50/80 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-4 py-3">名称</th>
                        <th className="px-4 py-3">密钥</th>
                        <th className="px-4 py-3">状态</th>
                        <th className="px-4 py-3 text-center">允许登录</th>
                        <th className="px-4 py-3">对话上限</th>
                        <th className="px-4 py-3">已用对话</th>
                        <th className="px-4 py-3">剩余对话</th>
                        <th className="px-4 py-3">新增时间</th>
                        <th className="px-4 py-3">最近对话</th>
                        <th className="px-4 py-3">备注</th>
                        <th className="px-4 py-3 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {pagedKeys.map((key) => (
                        <KeyListRow
                          key={key.id}
                          accessKey={key}
                          draft={drafts[key.id]}
                          saving={saving}
                          copied={copiedKeyId === key.id}
                          setDraft={(draft) => setDrafts((previous) => ({ ...previous, [key.id]: draft }))}
                          onSave={() => saveKey(key.id)}
                          onReset={() => saveKey(key.id, true)}
                          onDelete={() => removeKey(key.id)}
                          onCopy={() => copyKey(key)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="mt-6 flex flex-col gap-3 border-t border-slate-200/50 pt-5 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-slate-500">
                  显示第 {displayStart}-{displayEnd} 条，共 {sortedKeys.length} 条；每页 {PAGE_SIZE} 条
                </p>
                <div className="flex items-center gap-2">
                  <button
                    disabled={safeCurrentPage === 1 || loading || saving}
                    onClick={() => setCurrentPage(safeCurrentPage - 1)}
                    className="rounded-2xl bg-white px-4 py-2 text-sm font-medium ring-1 ring-slate-200 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    上一页
                  </button>
                  <span className="min-w-16 text-center text-sm font-medium text-slate-500">
                    {safeCurrentPage} / {totalPages}
                  </span>
                  <button
                    disabled={safeCurrentPage === totalPages || loading || saving}
                    onClick={() => setCurrentPage(safeCurrentPage + 1)}
                    className="rounded-2xl bg-white px-4 py-2 text-sm font-medium ring-1 ring-slate-200 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    下一页
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </section>

      {showCreateModal ? (
        <CreateKeyModal
          saving={saving}
          newKeyName={newKeyName}
          newKeyRemark={newKeyRemark}
          newKeyMaxUses={newKeyMaxUses}
          setNewKeyName={setNewKeyName}
          setNewKeyRemark={setNewKeyRemark}
          setNewKeyMaxUses={setNewKeyMaxUses}
          createKey={createKey}
          onClose={() => setShowCreateModal(false)}
        />
      ) : null}
    </>
  );
}

function CreateKeyModal({
  saving,
  newKeyName,
  newKeyRemark,
  newKeyMaxUses,
  setNewKeyName,
  setNewKeyRemark,
  setNewKeyMaxUses,
  createKey,
  onClose
}: {
  saving: boolean;
  newKeyName: string;
  newKeyRemark: string;
  newKeyMaxUses: string;
  setNewKeyName: (value: string) => void;
  setNewKeyRemark: (value: string) => void;
  setNewKeyMaxUses: (value: string) => void;
  createKey: (event: FormEvent<HTMLFormElement>) => Promise<boolean>;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6 backdrop-blur-sm">
      <form
        onSubmit={async (event) => {
          const created = await createKey(event);
          if (created) onClose();
        }}
        className="w-full max-w-lg rounded-[1.75rem] bg-white p-6 shadow-2xl ring-1 ring-slate-200"
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-xl font-semibold">新增访问密钥</h3>
            <p className="mt-1 text-sm text-slate-500">密钥由服务端随机生成，格式为 ak_ 加 24 位字符。</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-500 transition hover:bg-slate-200"
          >
            关闭
          </button>
        </div>

        <label className="block text-sm font-medium text-slate-700">名称</label>
        <input
          value={newKeyName}
          onChange={(event) => setNewKeyName(event.target.value)}
          className="mt-2 h-11 w-full rounded-2xl border border-slate-200/70 bg-white px-4 outline-none transition focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"
          placeholder="例如：客户A / 临时测试"
        />

        <label className="mt-4 block text-sm font-medium text-slate-700">备注</label>
        <textarea
          value={newKeyRemark}
          onChange={(event) => setNewKeyRemark(event.target.value)}
          rows={3}
          className="mt-2 w-full resize-none rounded-2xl border border-slate-200/70 bg-white px-4 py-3 outline-none transition focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"
          placeholder="例如：客户来源、用途、负责人等"
        />

        <label className="mt-4 block text-sm font-medium text-slate-700">最大对话次数</label>
        <input
          type="number"
          min={0}
          value={newKeyMaxUses}
          onChange={(event) => setNewKeyMaxUses(event.target.value)}
          className="mt-2 h-11 w-full rounded-2xl border border-slate-200/70 bg-white px-4 outline-none transition focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"
        />
        <p className="mt-2 text-xs text-slate-400">填 0 表示不限制；填 10 表示这个密钥最多可发起 10 次对话。</p>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-2xl bg-white px-5 py-2.5 text-sm font-medium ring-1 ring-slate-200 transition hover:bg-slate-50"
          >
            取消
          </button>
          <button
            disabled={saving}
            className="rounded-2xl bg-slate-950 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:bg-slate-300"
          >
            {saving ? "生成中..." : "生成密钥"}
          </button>
        </div>
      </form>
    </div>
  );
}

function SystemSettings({
  saving,
  newAdminPassword,
  setNewAdminPassword,
  changeAdminPassword
}: {
  saving: boolean;
  newAdminPassword: string;
  setNewAdminPassword: (value: string) => void;
  changeAdminPassword: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section className="rounded-[1.75rem] bg-white/70 p-6 shadow-sm backdrop-blur-xl ring-1 ring-slate-200/50">
      <form onSubmit={changeAdminPassword} className="max-w-xl">
        <h3 className="text-lg font-semibold">修改管理密码</h3>
        <p className="mt-1 text-sm text-slate-500">修改后会立即写入配置文件，并刷新当前管理员登录态。</p>

        <label className="mt-5 block text-sm font-medium text-slate-700">新管理密码</label>
        <input
          type="password"
          value={newAdminPassword}
          onChange={(event) => setNewAdminPassword(event.target.value)}
          className="mt-2 h-11 w-full rounded-2xl border border-slate-200/50 bg-white/50 px-4 outline-none transition focus:border-emerald-400 focus:bg-white focus:ring-4 focus:ring-emerald-100"
          placeholder="至少 6 位"
        />

        <button
          disabled={saving || newAdminPassword.trim().length < 6}
          className="mt-5 h-11 rounded-2xl bg-slate-950 px-6 text-sm font-medium text-white transition hover:bg-emerald-600 disabled:bg-slate-300"
        >
          保存管理密码
        </button>
      </form>
    </section>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-[1.5rem] bg-white/70 p-6 shadow-sm backdrop-blur-xl ring-1 ring-slate-200/50">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight">{value}</p>
      <p className="mt-2 text-xs text-slate-400">{hint}</p>
    </div>
  );
}

function KeyListRow({
  accessKey,
  draft,
  saving,
  copied,
  setDraft,
  onSave,
  onReset,
  onDelete,
  onCopy
}: {
  accessKey: AccessKey;
  draft?: KeyDraft;
  saving: boolean;
  copied: boolean;
  setDraft: (draft: KeyDraft) => void;
  onSave: () => void;
  onReset: () => void;
  onDelete: () => void;
  onCopy: () => void;
}) {
  const currentDraft =
    draft ?? {
      name: accessKey.name,
      remark: accessKey.remark || "",
      maxUses: String(accessKey.maxUses),
      enabled: accessKey.enabled
    };
  const remaining = accessKey.maxUses === 0 ? "不限" : String(Math.max(0, accessKey.maxUses - accessKey.usedCount));

  return (
    <tr className="align-middle transition hover:bg-slate-50/70">
      <td className="px-4 py-4">
        <input
          value={currentDraft.name}
          onChange={(event) => setDraft({ ...currentDraft, name: event.target.value })}
          className="h-10 w-44 rounded-2xl border border-slate-200 bg-white px-3 text-sm font-medium outline-none transition focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"
          title={accessKey.id}
        />
      </td>

      <td className="px-4 py-4">
        <button
          type="button"
          onClick={onCopy}
          className="group relative block max-w-[300px] overflow-x-auto rounded-2xl bg-slate-50 px-3 py-2 text-left ring-1 ring-slate-200 transition hover:bg-emerald-50 hover:ring-emerald-200"
          title="点击复制密钥"
        >
          <code className="whitespace-nowrap text-xs font-medium text-slate-800">{accessKey.key}</code>
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-slate-950 px-2 py-1 text-[10px] font-medium text-white opacity-0 shadow-sm transition group-hover:opacity-100">
            {copied ? "已复制" : "点击复制"}
          </span>
        </button>
      </td>

      <td className="px-4 py-4">
        <span
          className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
            accessKey.enabled ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"
          }`}
        >
          {accessKey.enabled ? "启用" : "停用"}
        </span>
      </td>

      <td className="px-4 py-4 text-center">
        <label className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-white ring-1 ring-slate-200">
          <input
            type="checkbox"
            checked={currentDraft.enabled}
            onChange={(event) => setDraft({ ...currentDraft, enabled: event.target.checked })}
            aria-label="允许登录"
          />
        </label>
      </td>

      <td className="px-4 py-4">
        <input
          type="number"
          min={0}
          value={currentDraft.maxUses}
          onChange={(event) => setDraft({ ...currentDraft, maxUses: event.target.value })}
          className="h-10 w-24 rounded-2xl border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"
          title="最大对话次数，0 表示不限"
        />
      </td>

      <td className="whitespace-nowrap px-4 py-4 text-sm font-medium text-slate-600">{accessKey.usedCount}</td>
      <td className="whitespace-nowrap px-4 py-4 text-sm font-medium text-slate-600">{remaining}</td>
      <td className="whitespace-nowrap px-4 py-4 text-sm text-slate-600">{formatTime(accessKey.createdAt)}</td>
      <td className="whitespace-nowrap px-4 py-4 text-sm text-slate-500">
        {accessKey.lastUsedAt ? formatTime(accessKey.lastUsedAt) : "暂无"}
      </td>

      <td className="px-4 py-4">
        <input
          value={currentDraft.remark}
          onChange={(event) => setDraft({ ...currentDraft, remark: event.target.value })}
          className="h-10 w-56 rounded-2xl border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100"
          placeholder="备注"
          title={currentDraft.remark || "备注"}
        />
      </td>

      <td className="px-4 py-4">
        <div className="flex min-w-[170px] flex-wrap justify-end gap-2">
          <button
            disabled={saving}
            onClick={onSave}
            className="rounded-2xl bg-white px-3 py-2 text-xs font-medium ring-1 ring-slate-200 transition hover:bg-slate-100 disabled:text-slate-300"
          >
            保存
          </button>
          <button
            disabled={saving}
            onClick={onReset}
            className="rounded-2xl bg-white px-3 py-2 text-xs font-medium ring-1 ring-slate-200 transition hover:bg-slate-100 disabled:text-slate-300"
          >
            重置
          </button>
          <button
            disabled={saving}
            onClick={onDelete}
            className="rounded-2xl bg-red-50 px-3 py-2 text-xs font-medium text-red-600 ring-1 ring-red-100 transition hover:bg-red-100 disabled:text-red-300"
          >
            删除
          </button>
        </div>
      </td>
    </tr>
  );
}

function normalizeClientBaseUrl(input: string) {
  const value = (input || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
  const v1Index = value.search(/\/v1(?:\/|$)/);
  if (v1Index >= 0) return value.slice(0, v1Index + 3);
  return `${value}/v1`;
}

function getTimestamp(value: string) {
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
