import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "../adapters/driven/mcp/types";

/**
 * 配置加载（AD-13 architecture.md §7.2 + AD-2 §6.4 瘦身 + config 瘦身批
 * 2026-09-05）：读取 `<home>/config.json`——**纯进程引导参数**
 * （staticDir / rgPath）。其余全部迁出：
 * - model → SQLite 默认模型表（DefaultModelStore）；
 * - apiKeys → ~/.helix/auth.json（AuthStore，0600+文件锁）；
 * - port → runtime_config KV `daemon_port` 键（argv --port 本次运行优先；
 *   设置页 config.set_port 写入，重启生效）；
 * - maxConcurrent/maxQueued → KV `scheduling_config` 单键（运行期可调）；
 * - mcpServers → helix.db `mcp_server` 表（McpConfigStore）。
 *
 * 旧格式兼容（启动迁移，AD-2 同款）：旧 config.json 含上述任一字段时
 * loadConfig 读入 legacy（不报错不丢字段）——组合根迁移写新位 + config.json
 * 重写瘦身形态，迁移后字段不再出现。
 *
 * 写入语义（AG-09）：首次创建（文件不存在）由 ensureConfigTemplate 生成
 * 空对象模板并以 0600 落盘；任何写回都经 writeConfig（全字段序列化），
 * 统一 chmod 0600。
 *
 * 报错语义（daemon 启动期 fail-fast）：文件缺失 → 不抛错，返回空配置；
 * model 缺失不 fail-fast（缺省走 SQLite 默认值 + builtin 兜底，AD-2）。
 */

/** daemon 配置（`<home>/config.json`，瘦身形态——纯进程引导参数）。 */
export interface DaemonConfig {
  /** 前端构建产物目录（static-serve；缺省不激活，daemon 照常启动）。 */
  staticDir?: string;
  /** rg 可执行文件显式路径（rg 三级解析第②级，AD-2/F3.1 §4.4；缺省跳过该级）。 */
  rgPath?: string;
}

/** 旧格式遗留位（AD-2 + config 瘦身批迁移读面：组合根写新位后重写瘦身 config.json）。 */
export interface LegacyModelConfig {
  /** 旧 model 字符串 → 迁 SQLite 默认模型表。 */
  model?: string;
  /** 旧 provider → apiKey 映射 → 迁 auth.json。 */
  apiKeys?: Record<string, string>;
  /** 旧 port 数字 → 迁 KV daemon_port（config 瘦身批）。 */
  port?: number;
  /** 旧 maxConcurrent/maxQueued → 迁 KV scheduling_config 单键。 */
  maxConcurrent?: number;
  maxQueued?: number;
  /** 旧 mcpServers 段 → 迁 mcp_server 表。 */
  mcpServers?: McpServerConfig[];
}

/** loadConfig 结果：瘦身配置 + 旧格式遗留位（无遗留 = 空对象）。 */
export interface LoadedConfig {
  readonly config: DaemonConfig;
  readonly legacy: LegacyModelConfig;
}

/** 默认端口（§7.2 示例值；config 瘦身批后单源常量——KV daemon_port 未设时的缺省回落）。 */
export const DEFAULT_PORT = 7333;

/**
 * 加载配置文件。configFilePath 应来自 paths.ts 的 `configPath()`（AD-14）。
 * 语义见文件头注释；本函数同步执行（daemon 启动期一次性读取）。
 */
export function loadConfig(configFilePath: string): LoadedConfig {
  if (!existsSync(configFilePath)) {
    // 文件缺失 → 空配置（首启场景：port/scheduling 走 KV 缺省，模型走 SQLite + builtin 兜底）
    return { config: {}, legacy: {} };
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
        `{ staticDir?, rgPath? }，实际不是对象。`,
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
  if (typeof obj.port === "number" && Number.isInteger(obj.port) && obj.port >= 0 && obj.port <= 65535) {
    legacy.port = obj.port;
  }
  if (typeof obj.maxConcurrent === "number" && Number.isInteger(obj.maxConcurrent) && obj.maxConcurrent >= 1) {
    legacy.maxConcurrent = obj.maxConcurrent;
  }
  if (typeof obj.maxQueued === "number" && Number.isInteger(obj.maxQueued) && obj.maxQueued >= 0) {
    legacy.maxQueued = obj.maxQueued;
  }
  if (obj.mcpServers !== undefined && Array.isArray(obj.mcpServers) && obj.mcpServers.length > 0) {
    const servers = parseMcpServers(obj.mcpServers); // 行形状非法即抛（与旧语义一致——迁移前不吞错）
    if (servers.length > 0) legacy.mcpServers = servers;
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

  let rgPath: string | undefined;
  if (obj.rgPath !== undefined) {
    if (typeof obj.rgPath !== "string" || obj.rgPath.trim() === "") {
      throw new Error(
        `配置文件字段 rgPath 格式错误：${configFilePath}，应为非空字符串（rg 可执行文件显式路径，AD-2/F3.1）。`,
      );
    }
    rgPath = obj.rgPath;
  }

  return {
    config: {
      ...(staticDir !== undefined ? { staticDir } : {}),
      ...(rgPath !== undefined ? { rgPath } : {}),
    },
    legacy,
  };
}

/**
 * mcpServers 段解析（mcp 批）：行形状校验——name/command 必填非空、
 * args/env/timeoutMs 类型正确；非法行抛错（启动 fail-fast——配置面错误
 * 应在启动时暴露而非静默缺席）。工具命名空间约束：name 不得含 "__"
 * （与分隔符撞）；未含 command 的行同样抛错。
 */
function parseMcpServers(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) {
    throw new Error("config.json mcpServers 应为数组");
  }
  const out: McpServerConfig[] = [];
  for (const [index, row] of value.entries()) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error(`config.json mcpServers[${index}] 应为对象`);
    }
    const r = row as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const command = typeof r.command === "string" ? r.command.trim() : "";
    if (name === "" || command === "") {
      throw new Error(`config.json mcpServers[${index}] 缺 name/command（均必填非空）`);
    }
    if (name.includes("__")) {
      throw new Error(`config.json mcpServers[${index}].name 不得含 "__"（工具命名空间分隔符）`);
    }
    if (r.args !== undefined && (!Array.isArray(r.args) || r.args.some((a) => typeof a !== "string"))) {
      throw new Error(`config.json mcpServers[${index}].args 应为 string[]`);
    }
    if (r.env !== undefined && (typeof r.env !== "object" || r.env === null || Array.isArray(r.env))) {
      throw new Error(`config.json mcpServers[${index}].env 应为 Record<string, string>`);
    }
    if (r.timeoutMs !== undefined && (typeof r.timeoutMs !== "number" || r.timeoutMs <= 0)) {
      throw new Error(`config.json mcpServers[${index}].timeoutMs 应为正数`);
    }
    out.push({
      name,
      command,
      ...(Array.isArray(r.args) ? { args: r.args as string[] } : {}),
      ...(r.env !== undefined ? { env: r.env as Record<string, string> } : {}),
      ...(typeof r.cwd === "string" && r.cwd !== "" ? { cwd: r.cwd } : {}),
      ...(typeof r.enabled === "boolean" ? { enabled: r.enabled } : {}),
      ...(typeof r.timeoutMs === "number" ? { timeoutMs: r.timeoutMs } : {}),
    });
  }
  return out;
}

/** config.json 文件权限（统一 0600：历史形态曾含 apiKeys 敏感信息，AG-09）。 */
export const CONFIG_FILE_MODE = 0o600;

/**
 * 写入配置文件（全字段序列化：staticDir/rgPath；旧字段已迁出不再出现）。
 * 父目录不存在则创建；写入后显式 chmod（覆盖既有宽权限文件时同样收严）。
 * 原子写（tmp+rename，code-review M28；对齐 auth-store persist 先例）——
 * 崩溃窗口不留半截 config.json（直写下启动 loadConfig 会抛错 fail-fast）。
 */
export function writeConfig(configFilePath: string, config: DaemonConfig): void {
  mkdirSync(path.dirname(configFilePath), { recursive: true });
  const body =
    JSON.stringify(
      {
        ...(config.staticDir !== undefined ? { staticDir: config.staticDir } : {}),
        ...(config.rgPath !== undefined ? { rgPath: config.rgPath } : {}),
      },
      null,
      2,
    ) + "\n";
  const tmp = `${configFilePath}.tmp`;
  // 创建即收权（tmp 每次新建）：免「先写后 chmod」窗口期按 umask 宽权限可见
  writeFileSync(tmp, body, { encoding: "utf8", mode: CONFIG_FILE_MODE });
  chmodSync(tmp, CONFIG_FILE_MODE); // 兑底：既有 tmp 残留时收权（mode 不改已存文件）
  renameSync(tmp, configFilePath);
}

/**
 * 首次创建配置模板（0600）：文件已存在则不动（幂等）。
 * 瘦身形态：空对象模板（全部运行参数已迁 KV/表——文件在 = 已初始化标记；
 * staticDir/rgPath 按需手写）。
 */
export function ensureConfigTemplate(configFilePath: string): { created: boolean } {
  if (existsSync(configFilePath)) return { created: false };
  writeConfig(configFilePath, {});
  return { created: true };
}
