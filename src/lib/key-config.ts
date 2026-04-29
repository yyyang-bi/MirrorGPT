import crypto from "crypto";
import fs from "fs";
import path from "path";

export type AccessKeyConfig = {
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

export type AuthConfig = {
  adminPassword: string;
  keys: AccessKeyConfig[];
};

export const AUTH_CONFIG_PATH = path.join(process.cwd(), "config", "auth.json");

const DEFAULT_CONFIG: AuthConfig = {
  adminPassword: "admin123456",
  keys: [
    {
      id: "dev-default",
      name: "默认访问密钥",
      remark: "",
      key: "change-me-local",
      enabled: true,
      maxUses: 0,
      usedCount: 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: null
    }
  ]
};

function ensureConfigFile() {
  const dir = path.dirname(AUTH_CONFIG_PATH);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(AUTH_CONFIG_PATH)) {
    fs.writeFileSync(AUTH_CONFIG_PATH, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
  }
}

function normalizeConfig(input: Partial<AuthConfig> | null | undefined): AuthConfig {
  const adminPassword =
    typeof input?.adminPassword === "string" && input.adminPassword.trim()
      ? input.adminPassword
      : DEFAULT_CONFIG.adminPassword;

  const keys = Array.isArray(input?.keys)
    ? input.keys
        .filter((item) => item && typeof item.key === "string" && item.key.trim())
        .map((item, index) => ({
          id: typeof item.id === "string" && item.id.trim() ? item.id : crypto.randomUUID(),
          name: typeof item.name === "string" && item.name.trim() ? item.name : `访问密钥 ${index + 1}`,
          remark: typeof item.remark === "string" ? item.remark.trim() : "",
          key: item.key.trim(),
          enabled: item.enabled !== false,
          maxUses: Number.isFinite(Number(item.maxUses)) ? Math.max(0, Math.floor(Number(item.maxUses))) : 0,
          usedCount: Number.isFinite(Number(item.usedCount)) ? Math.max(0, Math.floor(Number(item.usedCount))) : 0,
          createdAt:
            typeof item.createdAt === "string" && item.createdAt.trim()
              ? item.createdAt
              : new Date().toISOString(),
          lastUsedAt: typeof item.lastUsedAt === "string" && item.lastUsedAt.trim() ? item.lastUsedAt : null
        }))
    : DEFAULT_CONFIG.keys;

  return {
    adminPassword,
    keys
  };
}

export function readAuthConfig(): AuthConfig {
  ensureConfigFile();

  try {
    const raw = fs.readFileSync(AUTH_CONFIG_PATH, "utf8");
    return normalizeConfig(JSON.parse(raw) as Partial<AuthConfig>);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function writeAuthConfig(config: AuthConfig) {
  ensureConfigFile();
  const normalized = normalizeConfig(config);
  fs.writeFileSync(AUTH_CONFIG_PATH, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

export function generateAccessKey() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const keyLength = 24;
  const chars: string[] = [];

  // 生成 ak_ + 24 位大小写字母/数字，例如：ak_7x9KpL2mQ8sN4vB6yT3zR1cD
  while (chars.length < keyLength) {
    const bytes = crypto.randomBytes(keyLength);

    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      // 避免取模偏差：只使用 0-247，248 是 62 的整数倍。
      if (byte >= 248) continue;
      chars.push(alphabet[byte % alphabet.length]);
      if (chars.length === keyLength) break;
    }
  }

  return `ak_${chars.join("")}`;
}

export function createAccessKey(input: { name?: string; remark?: string; maxUses?: number }) {
  const config = readAuthConfig();
  const now = new Date().toISOString();
  let key = generateAccessKey();

  while (config.keys.some((item) => item.key === key)) {
    key = generateAccessKey();
  }

  const record: AccessKeyConfig = {
    id: crypto.randomUUID(),
    name: input.name?.trim() || "新访问密钥",
    remark: input.remark?.trim() || "",
    key,
    enabled: true,
    maxUses: Number.isFinite(Number(input.maxUses)) ? Math.max(0, Math.floor(Number(input.maxUses))) : 0,
    usedCount: 0,
    createdAt: now,
    lastUsedAt: null
  };

  config.keys.unshift(record);
  writeAuthConfig(config);
  return record;
}

export function updateAccessKey(
  id: string,
  input: {
    name?: string;
    remark?: string;
    enabled?: boolean;
    maxUses?: number;
    resetUsedCount?: boolean;
  }
) {
  const config = readAuthConfig();
  const key = config.keys.find((item) => item.id === id);

  if (!key) return null;

  if (typeof input.name === "string") {
    key.name = input.name.trim() || key.name;
  }

  if (typeof input.remark === "string") {
    key.remark = input.remark.trim();
  }

  if (typeof input.enabled === "boolean") {
    key.enabled = input.enabled;
  }

  if (input.maxUses !== undefined) {
    key.maxUses = Math.max(0, Math.floor(Number(input.maxUses) || 0));
  }

  if (input.resetUsedCount) {
    key.usedCount = 0;
    key.lastUsedAt = null;
  }

  writeAuthConfig(config);
  return key;
}

export function consumeAccessKeyDialog(id: string) {
  const config = readAuthConfig();
  const key = config.keys.find((item) => item.id === id);

  if (!key) {
    return {
      ok: false,
      error: "访问密钥不存在，请重新登录。",
      status: 401
    };
  }

  if (!key.enabled) {
    return {
      ok: false,
      error: "该访问密钥已停用。",
      status: 403
    };
  }

  if (key.maxUses > 0 && key.usedCount >= key.maxUses) {
    return {
      ok: false,
      error: "该访问密钥的可用对话次数已用完。",
      status: 403
    };
  }

  key.usedCount += 1;
  key.lastUsedAt = new Date().toISOString();
  writeAuthConfig(config);

  return {
    ok: true,
    key
  };
}

export function checkAccessKeyDialog(id: string) {
  const config = readAuthConfig();
  const key = config.keys.find((item) => item.id === id);

  if (!key) {
    return {
      ok: false,
      error: "访问密钥不存在，请重新登录。",
      status: 401
    };
  }

  if (!key.enabled) {
    return {
      ok: false,
      error: "该访问密钥已停用。",
      status: 403
    };
  }

  if (key.maxUses > 0 && key.usedCount >= key.maxUses) {
    return {
      ok: false,
      error: "该访问密钥的可用对话次数已用完。",
      status: 403
    };
  }

  return {
    ok: true,
    key
  };
}

export function deleteAccessKey(id: string) {
  const config = readAuthConfig();
  const before = config.keys.length;
  config.keys = config.keys.filter((item) => item.id !== id);

  if (config.keys.length === before) return false;

  writeAuthConfig(config);
  return true;
}

export function updateAdminPassword(adminPassword: string) {
  const nextPassword = adminPassword.trim();

  if (nextPassword.length < 6) {
    throw new Error("管理密码至少需要 6 位。");
  }

  const config = readAuthConfig();
  config.adminPassword = nextPassword;
  writeAuthConfig(config);
}
