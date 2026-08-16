import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SCHEDULING } from "../domain/agent/SchedulingPolicy";

/**
 * 配置加载（AD-13 architecture.md §7.2 + AD-2 §6.4 瘦身，T2.3）：
 * 读取 `<home>/config.json`——**纯 daemon 运行参数**（port / maxConcurrent /
 * maxQueued / staticDir）。模型位与 key 位已迁出（取代边界，AD-2 §6.5）：
 * - model → SQLite 默认模型表（DefaultModelStore）；
 * - apiKeys → ~/.helix/auth.json（AuthStore，0600+文件锁）。
 *
 * 旧格式兼容（启动迁移）：旧 config.json 含 model / apiKeys 字段时
 * loadConfig 将其读出放 legacy（不报错、不丢字段）——组合根负责迁移
 * （写新位 + config.json 重写瘦身形态），迁移后本字段不再出现。
 *
 * 写入语义（AG-09）：首次创建（文件不存在）时由 ensureConfigTemplate
 * 生成模板并以 0600 权限落盘；任何写回都经 writeConfig（**全字段序列化**
 * ——T2.3 修复只写三字段导致的截断），统一 chmod 0600。
 *
 * 报错语义（daemon 启动期 fail-fast）：文件缺失 → 不抛错，返回默认值
 * （port 7333）；model 缺失不再 fail-fast（缺省走 SQLite 默认值 + builtin
 * 兜底，AD-2）。
 */

/** daemon 配置（`<home>/config.json`，瘦身形态——纯运行参数）。 */
export interface DaemonConfig {
  /** WS 端口，默认 7333；0 = 随机（启动日志输出实际端口，test-design §5.4）。 */
  port: number;
  /** SubAgent 并发上限（daemon 全局，AD-7①；缺省 3，与 SchedulingPolicy 同源）。 */
  maxConcurrent: number;
  /** SubAgent FIFO 队列上限（AD-7②；缺省 8，队列满才报错回 LLM）。 */
  maxQueued: number;
  /** 前端构建产物目录（static-serve；缺省不激活，daemon 照常启动）。 */
  staticDir?: string;
}

/** 旧格式遗留位（AD-2 迁移读面：组合根写新位后重写瘦身 config.json）。 */
export interface LegacyModelConfig {
  /** 旧 model 字符串 → 迁 SQLite 默认模型表。 */
  model?: string;
  /** 旧 provider → apiKey 映射 → 迁 auth.json。 */
  apiKeys?: Record<string, string>;
}

/** loadConfig 结果：瘦身配置 + 旧格式遗留位（无遗留 = 空对象）。 */
export interface LoadedConfig {
  readonly config: DaemonConfig;
  readonly legacy: LegacyModelConfig;
}

/** 默认端口（§7.2 示例值）。 */
export const DEFAULT_PORT = 7333;

/**
 * 加载配置文件。configFilePath 应来自 paths.ts 的 `configPath()`（AD-14）。
 * 语义见文件头注释；本函数同步执行（daemon 启动期一次性读取）。
 */
export function loadConfig(configFilePath: string): LoadedConfig {
  if (!existsSync(configFilePath)) {
    // 文件缺失 → 全默认值（首启场景；模型缺省走 SQLite 默认 + builtin 兜底）
    return {
      config: {
        port: DEFAULT_PORT,
        maxConcurrent: DEFAULT_SCHEDULING.maxConcurrent,
        maxQueued: DEFAULT_SCHEDULING.maxQueued,
      },
      legacy: {},
    };
  }

  const raw = readFileSync(configFilePath, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `配置文件不是合法的 JSON：${configFilePath}（${(err as Error).message}），` +
        `请检查 config.json 语法后重试。`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `配置文件格式错误：${configFilePath}，应为 JSON 对象 ` +
        `{ port?, maxConcurrent?, maxQueued?, staticDir? }，实际不是对象。`,
    );
  }

  const obj = parsed as Record<string, unknown>;

  // ── 旧格式遗留位（迁移读面；不校验强语义——迁移写新位时逐条落位） ──
  const legacy: LegacyModelConfig = {};
  if (typeof obj.model === "string" && obj.model.trim() !== "") legacy.model = obj.model;
  if (obj.apiKeys !== undefined) {
    if (typeof obj.apiKeys === "object" && obj.apiKeys !== null && !Array.isArray(obj.apiKeys)) {
      const apiKeys: Record<string, string> = {};
      for (const [provider, key] of Object.entries(obj.apiKeys as Record<string, unknown>)) {
        if (typeof key === "string" && key.trim() !== "") apiKeys[provider] = key;
      }
      if (Object.keys(apiKeys).length > 0) legacy.apiKeys = apiKeys;
    }
  }

  let port: number = DEFAULT_PORT;
  if (obj.port !== undefined) {
    if (typeof obj.port !== "number" || !Number.isInteger(obj.port) || obj.port < 0 || obj.port > 65535) {
      throw new Error(
        `配置文件字段 port 格式错误：${configFilePath}，应为 0–65535 整数（0 = 随机端口；默认 ${DEFAULT_PORT}）。`,
      );
    }
    port = obj.port;
  }

  // SubAgent 调度预算（T2.1，K4：AD-7①②；非法值 fail-fast，缺省与 domain 同源）
  let maxConcurrent: number = DEFAULT_SCHEDULING.maxConcurrent;
  if (obj.maxConcurrent !== undefined) {
    if (typeof obj.maxConcurrent !== "number" || !Number.isInteger(obj.maxConcurrent) || obj.maxConcurrent < 1) {
      throw new Error(
        `配置文件字段 maxConcurrent 格式错误：${configFilePath}，应为 ≥ 1 的整数` +
          `（SubAgent 并发上限，默认 ${DEFAULT_SCHEDULING.maxConcurrent}）。`,
      );
    }
    maxConcurrent = obj.maxConcurrent;
  }

  let maxQueued: number = DEFAULT_SCHEDULING.maxQueued;
  if (obj.maxQueued !== undefined) {
    if (typeof obj.maxQueued !== "number" || !Number.isInteger(obj.maxQueued) || obj.maxQueued < 0) {
      throw new Error(
        `配置文件字段 maxQueued 格式错误：${configFilePath}，应为 ≥ 0 的整数` +
          `（SubAgent FIFO 队列上限，默认 ${DEFAULT_SCHEDULING.maxQueued}）。`,
      );
    }
    maxQueued = obj.maxQueued;
  }

  let staticDir: string | undefined;
  if (obj.staticDir !== undefined) {
    if (typeof obj.staticDir !== "string" || obj.staticDir.trim() === "") {
      throw new Error(
        `配置文件字段 staticDir 格式错误：${configFilePath}，应为非空字符串（前端构建产物目录）。`,
      );
    }
    staticDir = obj.staticDir;
  }

  return {
    config: { port, maxConcurrent, maxQueued, ...(staticDir !== undefined ? { staticDir } : {}) },
    legacy,
  };
}

/** config.json 文件权限（统一 0600：历史形态曾含 apiKeys 敏感信息，AG-09）。 */
export const CONFIG_FILE_MODE = 0o600;

/**
 * 写入配置文件（**全字段序列化**——T2.3 修复截断：port/maxConcurrent/
 * maxQueued/staticDir 全量落盘，旧实现只写三字段会静默丢字段）。
 * 父目录不存在则创建；写入后显式 chmod（覆盖既有宽权限文件时同样收严）。
 */
export function writeConfig(configFilePath: string, config: DaemonConfig): void {
  mkdirSync(path.dirname(configFilePath), { recursive: true });
  const body =
    JSON.stringify(
      {
        port: config.port,
        maxConcurrent: config.maxConcurrent,
        maxQueued: config.maxQueued,
        ...(config.staticDir !== undefined ? { staticDir: config.staticDir } : {}),
      },
      null,
      2,
    ) + "\n";
  writeFileSync(configFilePath, body, { encoding: "utf8" });
  chmodSync(configFilePath, CONFIG_FILE_MODE);
}

/**
 * 首次创建配置模板（0600）：文件已存在则不动（幂等）。
 * T2.3 瘦身形态：纯运行参数模板（模型/key 位不在 config.json——缺省走
 * SQLite 默认模型 + auth.json，无需用户先改文件才能启动）。
 */
export function ensureConfigTemplate(configFilePath: string): { created: boolean } {
  if (existsSync(configFilePath)) return { created: false };
  writeConfig(configFilePath, {
    port: DEFAULT_PORT,
    maxConcurrent: DEFAULT_SCHEDULING.maxConcurrent,
    maxQueued: DEFAULT_SCHEDULING.maxQueued,
  });
  return { created: true };
}
