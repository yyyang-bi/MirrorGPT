import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ChatGPT",
  description: "一个支持密钥登录、在线聊天、生图和多会话管理的 ChatGPT 镜像 Web 页面",
  icons: {
    icon: [{ url: "/openai-logo.svg", type: "image/svg+xml" }],
    shortcut: [{ url: "/openai-logo.svg", type: "image/svg+xml" }]
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
