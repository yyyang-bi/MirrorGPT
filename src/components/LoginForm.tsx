"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginForm({ adminMode = false }: { adminMode?: boolean }) {
  const router = useRouter();
  const [accessKey, setAccessKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        accessKey
      })
    });

    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      role?: "admin" | "user";
    };
    setLoading(false);

    if (!response.ok) {
      setError(payload.error || "登录失败，请检查访问密钥。");
      return;
    }

    router.replace(payload.role === "admin" ? "/admin" : "/chat");
    router.refresh();
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-slate-50">
      {/* 动态背景修饰 */}
      <div className="absolute -top-[20%] -left-[10%] w-[70%] h-[70%] rounded-full bg-emerald-400/10 blur-[120px] mix-blend-multiply pointer-events-none" />
      <div className="absolute -bottom-[20%] -right-[10%] w-[70%] h-[70%] rounded-full bg-blue-400/10 blur-[120px] mix-blend-multiply pointer-events-none" />

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-4 py-10 sm:px-6">
        <section className="grid w-full overflow-hidden rounded-[2.5rem] bg-white shadow-[0_20px_80px_-20px_rgba(0,0,0,0.1)] ring-1 ring-slate-200/50 md:grid-cols-[1.1fr_0.9fr]">
          {/* 左侧说明面板 */}
          <div className="relative hidden min-h-[620px] bg-ink p-10 text-white md:block overflow-hidden">
            <div className="absolute inset-0 opacity-80 [background:linear-gradient(135deg,rgba(16,185,129,.4),transparent_40%),radial-gradient(circle_at_80%_20%,rgba(59,130,246,.5),transparent_40%),radial-gradient(circle_at_20%_80%,rgba(139,92,246,.3),transparent_40%)]" />
            
            <div className="absolute -top-32 -right-32 h-96 w-96 rounded-full bg-blue-500/20 blur-3xl mix-blend-screen" />
            <div className="absolute -bottom-32 -left-32 h-96 w-96 rounded-full bg-emerald-500/20 blur-3xl mix-blend-screen" />

            <div className="relative z-10 flex h-full flex-col justify-between">
              <div>
                <div className="mb-10 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm text-white/80 backdrop-blur-md">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                  AI 智能助手
                </div>
                <h1 className="max-w-lg text-5xl font-bold leading-tight tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-white to-white/70">
                  探索未来的<br/>智能对话与创作
                </h1>
                <p className="mt-6 max-w-md text-base leading-relaxed text-slate-300">
                  您的专属 AI 工作台。无论是日常问答、灵感获取、文本创作，还是天马行空的图像生成，都在这里一触即发。
                </p>
              </div>

              <div className="grid gap-3 text-sm text-slate-300">
                {[
                  { title: "智能上下文记忆", desc: "如同与真人交谈般流畅自然" },
                  { title: "极速响应体验", desc: "无需等待，所想即刻呈现" },
                  { title: "AI 高清图库生成", desc: "用文字描绘并生成令人惊叹的视觉画面" }
                ].map((item) => (
                  <div key={item.title} className="group flex items-center gap-4 rounded-2xl bg-white/5 p-4 ring-1 ring-white/10 backdrop-blur-sm transition-all hover:bg-white/10 hover:ring-white/20 hover:scale-[1.02]">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-400/20 text-emerald-200 transition-colors group-hover:bg-emerald-400/30 group-hover:text-emerald-300">
                      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    </span>
                    <div>
                      <div className="font-medium text-white/90">{item.title}</div>
                      <div className="text-white/50 text-xs mt-0.5">{item.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* 右侧登录面板 */}
          <div className="flex min-h-[620px] items-center justify-center p-8 sm:p-12 bg-white/50 backdrop-blur-xl">
            <form onSubmit={onSubmit} className="w-full max-w-sm">
              <div className="mb-10">
                <p 
                  className="mb-3 w-fit text-sm font-medium text-emerald-600 select-none cursor-default"
                  onDoubleClick={() => !adminMode && router.replace("/login?admin=1")}
                >
                  {adminMode ? "管理员入口" : "欢迎回来"}
                </p>
                <h2 className="text-3xl font-bold tracking-tight text-slate-900">
                  {adminMode ? "输入管理密码" : "验证您的访问权限"}
                </h2>
                <p className="mt-3 text-sm leading-6 text-slate-500">
                  {adminMode
                    ? "请输入配置文件中的管理密码，验证通过后即可管理系统设置。"
                    : "请输入管理员为您分配的访问密钥，开启智能之旅。"}
                </p>
              </div>

              <div className="space-y-6">
                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700" htmlFor="accessKey">
                    {adminMode ? "管理密码" : "访问密钥"}
                  </label>
                  <input
                    id="accessKey"
                    autoFocus
                    type="password"
                    value={accessKey}
                    onChange={(event) => setAccessKey(event.target.value)}
                    placeholder={adminMode ? "请输入管理密码" : "请输入访问密钥"}
                    className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 outline-none transition-all focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/20"
                  />
                </div>

                <div className="min-h-[52px]" aria-live="polite">
                  {error ? (
                    <div className="rounded-2xl bg-red-50 p-4 text-sm text-red-600 ring-1 ring-red-100 flex items-center gap-2">
                      <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      {error}
                    </div>
                  ) : null}
                </div>

                <button
                  disabled={loading || !accessKey.trim()}
                  className="group relative flex h-12 w-full items-center justify-center overflow-hidden rounded-2xl bg-slate-900 font-medium text-white transition-all hover:bg-slate-800 focus:ring-4 focus:ring-slate-900/20 disabled:cursor-not-allowed disabled:opacity-50"
                  type="submit"
                >
                  <span className="relative z-10 flex items-center gap-2">
                    {loading ? (
                      <>
                        <svg className="h-4 w-4 animate-spin text-white/80" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        正在验证...
                      </>
                    ) : (
                      adminMode ? "进入管理后台" : "进入工作台"
                    )}
                  </span>
                </button>

                {adminMode && (
                  <button
                    type="button"
                    onClick={() => router.replace("/login")}
                    className="w-full rounded-2xl px-4 py-3 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
                  >
                    返回普通登录
                  </button>
                )}
              </div>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}
