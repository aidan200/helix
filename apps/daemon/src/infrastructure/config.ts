import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";

/**
 * 配置加载（AD-13，architecture.md §7.2）：读取 `<home>/config.json`。
 *
 * 写入语义（T1.4 补齐，AG-09）：首次创建（文件不存在）时由
 * ensureConfigTemplate 生成模板并以 0600 权限落盘（apiKeys 属敏感信息）；
 * 任何写回都经 writeConfig，统一 chmod 0600。
 *
 * 报错语义（daemon 启动期 fail-fast）：
 * - 文件缺失 → 不抛错，返回默认值（port 7333，model 为 undefined）；
 * - 文件存在但 model 缺失/为空 → 抛带中文说明的错误（fail-fast）。
 */

/** daemon 配置（`<home>/config.json`）。 */
export interface DaemonConfig {
  /** 模型字符串（如 "anthropic/claude-…"）。文件缺失时为 undefined。 */
  model?: string;
  /** provider → apiKey 映射，显式传入 pi-ai 工厂函数（与环境变量彻底无缘，AD-11/13）。 */
  apiKeys?: Record<string, string>;
  /** WS 端口，默认 7333；0 = 随机（启动日志输出实际端口，test-design §5.4）。 */
  port: number;
  /** 前端构建产物目录（static-serve；缺省不激活，daemon 照常启动）。 */
  staticDir?: string;
}

/** 默认端口（§7.2 示例值）。 */
export const DEFAULT_PORT = 7333;

/**
 * 加载配置文件。configFilePath 应来自 paths.ts 的 `configPath()`（AD-14）。
 * 语义见文件头注释；本函数同步执行（daemon 启动期一次性读取）。
 */
export function loadConfig(configFilePath: string): DaemonConfig {
  if (!existsSync(configFilePath)) {
    // 文件缺失 → 全默认值（首次启动场景；真正需要 model 时由调用方 fail-fast）
    return { port: DEFAULT_PORT };
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
        `{ model, apiKeys?, port? }，实际不是对象。`,
    );
  }

  const obj = parsed as Record<string, unknown>;

  // model 缺失 → fail-fast（中文错误，指明文件路径与修复方法）
  if (typeof obj.model !== "string" || obj.model.trim() === "") {
    throw new Error(
      `配置文件缺少必需字段 model：${configFilePath}。` +
        `请在 config.json 中填写模型字符串（例如 "anthropic/claude-sonnet-4-5"）后重新启动 daemon。`,
    );
  }

  let apiKeys: Record<string, string> | undefined;
  if (obj.apiKeys !== undefined) {
    if (typeof obj.apiKeys !== "object" || obj.apiKeys === null || Array.isArray(obj.apiKeys)) {
      throw new Error(
        `配置文件字段 apiKeys 格式错误：${configFilePath}，` +
          `应为 { provider: apiKey } 形式的 JSON 对象。`,
      );
    }
    apiKeys = obj.apiKeys as Record<string, string>;
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

  let staticDir: string | undefined;
  if (obj.staticDir !== undefined) {
    if (typeof obj.staticDir !== "string" || obj.staticDir.trim() === "") {
      throw new Error(
        `配置文件字段 staticDir 格式错误：${configFilePath}，应为非空字符串（前端构建产物目录）。`,
      );
    }
    staticDir = obj.staticDir;
  }

  return { model: obj.model, apiKeys, port, staticDir };
}

/** config.json 文件权限（含 apiKeys 敏感信息，AG-09）。 */
export const CONFIG_FILE_MODE = 0o600;

/**
 * 写入配置文件（统一 0600：新建与覆盖同权限）。
 * 父目录不存在则创建；写入后显式 chmod（覆盖既有宽权限文件时同样收严）。
 */
export function writeConfig(configFilePath: string, config: DaemonConfig): void {
  mkdirSync(path.dirname(configFilePath), { recursive: true });
  const body =
    `{
` +
    `  "model": ${JSON.stringify(config.model ?? "")},\n` +
    `  "apiKeys": ${JSON.stringify(config.apiKeys ?? {}, null, 0).replace(/,/g, ", ")},\n` +
    `  "port": ${config.port}\n` +
    `}\n`;
  writeFileSync(configFilePath, body, { encoding: "utf8" });
  chmodSync(configFilePath, CONFIG_FILE_MODE);
}

/**
 * 首次创建配置模板（0600）：文件已存在则不动（幂等）。
 * 模板 model 为空串——随后 loadConfig 会以 fail-fast 中文错误引导用户填写。
 */
export function ensureConfigTemplate(configFilePath: string): { created: boolean } {
  if (existsSync(configFilePath)) return { created: false };
  writeConfig(configFilePath, { model: "", apiKeys: {}, port: DEFAULT_PORT });
  return { created: true };
}
