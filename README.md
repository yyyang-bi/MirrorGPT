# MirrorGPT

MirrorGPT 是一个基于 Next.js 的自托管 ChatGPT 镜像 Web 应用，内置访问密钥登录、后台管理、流式聊天、AI 生图和本地会话持久化。项目支持 OpenAI 及 OpenAI-compatible 接口，适合个人、团队或私有环境快速搭建一个可控的 AI 聊天与生图入口。

## 功能特性

- 🔐 **访问密钥登录**：通过访问密钥进入聊天室，支持启用 / 停用密钥。
- 🛠️ **后台管理**：在 `/admin` 管理 API 地址、API Key、聊天模型、生图模型和访问密钥。
- 🔁 **多 API Key 轮询**：支持配置多个 API Key，后端自动轮换调用。
- 💬 **流式聊天**：基于 OpenAI-compatible `chat/completions` 接口实现 SSE 流式输出。
- 🖼️ **AI 生图**：支持 Images API 与 Responses API 两种生图模式，可配置尺寸、质量、格式、压缩等参数。
- 📎 **参考图输入**：支持上传 / 拖拽参考图片进行图片生成或改图。
- 🗂️ **多会话管理**：支持新建、切换、删除、搜索会话。
- 🧩 **用户数据隔离**：不同访问密钥的会话记录相互隔离。
- 📊 **次数限制**：可为访问密钥设置最大对话次数，用于临时分享或限量使用。
- 💾 **本地持久化**：使用 Prisma + SQLite 保存会话、消息和生成图片记录。

## 技术栈

- [Next.js 14](https://nextjs.org/) / App Router
- React 18
- TypeScript
- Tailwind CSS
- Prisma ORM
- SQLite
- OpenAI-compatible API

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 创建环境变量

复制示例文件：

```bash
cp .env.example .env
```

按需修改 `.env`：

```env
DATABASE_URL="file:./chat_sessions.db"
OPENAI_API_KEY="sk-..."
OPENAI_BASE_URL="https://api.openai.com/v1"
OPENAI_CHAT_MODEL="gpt-5.5"
OPENAI_IMAGE_MODEL="gpt-image-2"
OPENAI_RESPONSES_IMAGE_MODEL="gpt-5.5"
```

> API 配置也可以在后台页面中修改。首次启动时，项目会根据 `.env` 生成 `config/openai.json`。

### 3. 初始化数据库

```bash
npm run db:push
```

### 4. 启动开发服务

```bash
npm run dev
```

打开：

```txt
http://localhost:3000
```

## 默认账号信息

默认访问密钥：

```txt
change-me-local
```

后台地址：

```txt
http://localhost:3000/admin
```

默认管理密码：

```txt
admin123456
```

> ⚠️ 部署前请务必修改默认访问密钥和管理密码。

## 配置说明

### 访问密钥配置

访问密钥配置文件：

```txt
config/auth.json
```

示例文件：

```txt
config/auth.example.json
```

支持字段包括：

- `adminPassword`：后台管理密码
- `keys`：访问密钥列表
- `enabled`：是否启用
- `maxUses`：最大对话次数，`0` 表示不限
- `usedCount`：已使用次数

### OpenAI / Provider 配置

接口配置文件：

```txt
config/openai.json
```

示例文件：

```txt
config/openai.example.json
```

示例：

```json
{
  "apiKeys": ["sk-..."],
  "baseUrl": "https://api.openai.com/v1",
  "chatModel": "gpt-5.5",
  "imageModel": "gpt-image-2",
  "responsesImageModel": "gpt-5.5",
  "imageApiMode": "images",
  "imageCompatibilityMode": "auto"
}
```

后端调用路径：

```txt
聊天接口：{baseUrl}/chat/completions
生图接口：{baseUrl}/images/generations 或 {baseUrl}/images/edits
Responses 生图：{baseUrl}/responses
模型列表：{baseUrl}/models
```

## 常用命令

```bash
# 开发环境
npm run dev

# 构建生产版本
npm run build

# 启动生产服务
npm run start

# 同步 Prisma 数据库结构
npm run db:push

# 生成 Prisma Client
npm run prisma:generate

# 代码检查
npm run lint
```

## 项目结构

```txt
MirrorGPT/
├── config/                 # 本地配置文件与示例配置
├── prisma/                 # Prisma schema 与 SQLite 数据库
├── public/                 # 静态资源
├── src/
│   ├── app/                # Next.js App Router 页面和 API 路由
│   ├── components/         # 聊天室、登录页、后台管理组件
│   └── lib/                # 鉴权、配置、OpenAI 调用、Prisma 等工具
├── .env.example            # 环境变量示例
├── package.json
└── README.md
```

## 提交到 GitHub 前检查

项目已在 `.gitignore` 中忽略敏感和本地生成文件，请确认不要提交以下内容：

- `.env`
- `config/auth.json`
- `config/openai.json`
- `prisma/chat_sessions.db`
- `node_modules/`
- `.next/`

建议只提交示例配置文件：

- `.env.example`
- `config/auth.example.json`
- `config/openai.example.json`

## 部署提示

1. 在服务器安装 Node.js 18+。
2. 配置 `.env` 或在后台配置 Provider 信息。
3. 执行 `npm install` 与 `npm run db:push`。
4. 执行 `npm run build`。
5. 使用 `npm run start` 或 PM2 / Docker / 反向代理部署。
6. 首次上线后立即修改默认管理密码和访问密钥。

## License

当前项目暂未指定开源协议。如需开源发布，建议在仓库中补充 `LICENSE` 文件。
