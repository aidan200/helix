import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SCHEDULING } from "../domain/agent/SchedulingPolicy";
import type { McpServerConfig } from "../adapters/driven/mcp/types";

/**
 * 配置加载（AD-13 architecture.md §7.2 + AD-2 §6.4 瘦身）：
 * 读取 `<home>/config.json`——**纯 daemon 运行参数**（port / maxConcurrent /
 * maxQueued / staticDir / rgPath）。模型位与 key 位已迁出（取代边界，AD-2 §6.5）：
 * - model → SQLite 默认模型表（DefaultModelStore）；
 * - apiKeys → ~/.helix/auth.json（AuthStore，0600+文件锁）。
 *
 * 旧格式兼容（启动迁移）：旧 config.json 含 model / apiKeys 字段时
 * loadConfig 将其读出放 legacy（不报错、不丢字段）——组合根负责迁移
 * （写新位 + config.json 重写瘦身形态），迁移后本字段不再出现。
 *
 * 写入语义（AG-09）：首次创建（文件不存在）时由 ensureConfigTemplate
 * 生成模板并以 0600 权限落盘；任何写回都经 writeConfig（**全字段序列化**
 * ——修复只写三字段导致的截断），统一 chmod 0600。
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
  /** rg 可执行文件显式路径（rg 三级解析第②级，AD-2/F3.1 §4.4；缺省跳过该级）。 */
  rgPath?: string;
  /** codegraph 可执行文件显式路径（三级解析第②级，T2.1/AF-2；缺省跳过该级）。 */
  codegraphPath?: string;
  /**
   * MCP server 声明面（mcp 批）：任意 stdio MCP server——daemon 启动
   * 异步预热（到位即推，不阻塞启动）+ 设置页 CRUD 运行期增删。
   * 缺省 = 无 server（零配置兼容）。行形状见 McpServerConfig（driven/mcp）。
   */
  mcpServers?: McpServerConfig[];
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
        `{ port?, maxConcurrent?, maxQueued?, staticDir?, rgPath? }，实际不是对象。`,
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

  // SubAgent 调度预算（AD-7①②；非法值 fail-fast，缺省与 domain 同源）
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

  let rgPath: string | undefined;
  if (obj.rgPath !== undefined) {
    if (typeof obj.rgPath !== "string" || obj.rgPath.trim() === "") {
      throw new Error(
        `配置文件字段 rgPath 格式错误：${configFilePath}，应为非空字符串（rg 可执行文件显式路径，AD-2/F3.1）。`,
      );
    }
    rgPath = obj.rgPath;
  }

  let codegraphPath: string | undefined;
  if (obj.codegraphPath !== undefined) {
    if (typeof obj.codegraphPath !== "string" || obj.codegraphPath.trim() === "") {
      throw new Error(
        `配置文件字段 codegraphPath 格式错误：${configFilePath}，应为非空字符串（codegraph 可执行文件显式路径，T2.1/AF-2）。`,
      );
    }
    codegraphPath = obj.codegraphPath;
  }

  // mcp 批：mcpServers 段（行形状非法即抛——启动 fail-fast）
  const mcpServers = obj.mcpServers === undefined ? undefined : parseMcpServers(obj.mcpServers);

  return {
    config: {
      port,
      maxConcurrent,
      maxQueued,
      ...(staticDir !== undefined ? { staticDir } : {}),
      ...(rgPath !== undefined ? { rgPath } : {}),
      ...(codegraphPath !== undefined ? { codegraphPath } : {}),
      ...(mcpServers !== undefined && mcpServers.length > 0 ? { mcpServers } : {}),
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
 * 写入配置文件（**全字段序列化**——修复截断：port/maxConcurrent/
 * maxQueued/staticDir/rgPath/codegraphPath 全量落盘，旧实现只写三字段会静默丢字段）。
 * 父目录不存在则创建；写入后显式 chmod（覆盖既有宽权限文件时同样收严）。
 * 原子写（tmp+rename，code-review M28；对齐 auth-store persist 先例）——
 * 崩溃窗口不留半截 config.json（直写下启动 loadConfig 会抛错 fail-fast）。
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
        ...(config.rgPath !== undefined ? { rgPath: config.rgPath } : {}),
        ...(config.codegraphPath !== undefined ? { codegraphPath: config.codegraphPath } : {}),
        ...(config.mcpServers !== undefined && config.mcpServers.length > 0
          ? { mcpServers: config.mcpServers }
          : {}),
      },
      null,
      2,
    ) + "\n";
  const tmp = `${configFilePath}.tmp`;
  writeFileSync(tmp, body, { encoding: "utf8" });
  chmodSync(tmp, CONFIG_FILE_MODE);
  renameSync(tmp, configFilePath);
}

/**
 * 首次创建配置模板（0600）：文件已存在则不动（幂等）。
 * 瘦身形态：纯运行参数模板（模型/key 位不在 config.json——缺省走
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
