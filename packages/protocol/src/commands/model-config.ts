/** 全局配置域命令族：model.* / config.* / auth.* / thinking.set（全局命令，信封 sessionId 省略）。 */
import type { CommandFrame } from "../envelope";
import type {
  AuthListResultPayload,
  AuthSetKeyResultPayload,
  AuthVerifyResultPayload,
  ModelCatalogResultPayload,
  ModelGetDefaultResultPayload,
  ModelGetResultPayload,
  ModelSetDefaultResultPayload,
} from "../events/model";
import type { EmptyPayload } from "./session";

// ── v0.2 新增：model 族（契约 C §1；AD-2，G-6 定名） ──

/** model.set 载荷：运行期切换（P-3，F(3.3).2）——信封 sessionId 必填（per-session），下一 turn 生效 */
export interface ModelSetPayload {
  /** "provider/model-id" 完整 id */
  model: string;
}
export interface ModelSetCommand extends CommandFrame<ModelSetPayload> {
  type: "model.set";
}

/**
 * model.get 结果载荷（与 events/model.ts ModelGetResultPayload 同形双定义
 * 收敛为别名——SessionListResult 同规先例：权威位 = 事件线载荷，本名为
 * 兼容别名，协议面 additive 纪律 TR-AD-18 不删导出名）。
 */
export type ModelGetResult = ModelGetResultPayload;

/** model.get 载荷：信封 sessionId 必填（per-session） */
export interface ModelGetCommand extends CommandFrame<EmptyPayload> {
  type: "model.get";
}

/** 目录结果载荷（model.catalog / model.catalog_refresh 共用；事件线载荷别名，同 ModelGetResult 收敛先例） */
export type ModelCatalogResult = ModelCatalogResultPayload;

/** model.catalog 载荷：全局命令（4h 缓存口径，T2.3 落地） */
export interface ModelCatalogCommand extends CommandFrame<EmptyPayload> {
  type: "model.catalog";
}

/** model.catalog_refresh 载荷：绕过 4h 缓存强制拉 pi.dev（失败降级 builtin，响应含说明） */
export interface ModelCatalogRefreshCommand extends CommandFrame<EmptyPayload> {
  type: "model.catalog_refresh";
}

/** model.set_default 结果载荷（事件线载荷别名，同 ModelGetResult 收敛先例） */
export type ModelSetDefaultResult = ModelSetDefaultResultPayload;

/** model.set_default 载荷：全局默认值（无信封 sessionId；SQLite 读面，T2.3 落地） */
export interface ModelSetDefaultPayload {
  model: string;
}
export interface ModelSetDefaultCommand extends CommandFrame<ModelSetDefaultPayload> {
  type: "model.set_default";
}

/**
 * model.set_thinking_default 载荷（R7 全局推理强度兜底批）：全局默认推理
 * 强度——level = 档位字符串透传（pi-ai ThinkingLevel，AD-2）；null = 清除
 *（回退未配置态：各 agent 未配槽位 → 默认关）。与 model.set_default 同构
 *（全局命令，无信封 sessionId；runtime_config 单键存储）。
 */
export interface ModelSetThinkingDefaultPayload {
  level: string | null;
}
export interface ModelSetThinkingDefaultCommand extends CommandFrame<ModelSetThinkingDefaultPayload> {
  type: "model.set_thinking_default";
}

/**
 * model.get_default 结果载荷（事件线载荷别名，同 ModelGetResult 收敛先例——
 * 别名化同时修复双定义漂移：本地旧定义缺 thinkingDefault，权威形以
 * ModelGetDefaultResultPayload 为准）。
 */
export type ModelGetDefaultResult = ModelGetDefaultResultPayload;

/** model.get_default 载荷：全局命令 */
export interface ModelGetDefaultCommand extends CommandFrame<EmptyPayload> {
  type: "model.get_default";
}

// ── config 族（压缩参数配置；全局命令，无信封 sessionId；runtime_config 单键 JSON） ──

/** config.set_compaction 载荷：压缩参数（token 绝对值）。 */
export interface ConfigSetCompactionPayload {
  reserveTokens: number;
  keepRecentTokens: number;
}
export interface ConfigSetCompactionCommand extends CommandFrame<ConfigSetCompactionPayload> {
  type: "config.set_compaction";
}

/** config.get_compaction 载荷：全局命令。 */
export interface ConfigGetCompactionCommand extends CommandFrame<EmptyPayload> {
  type: "config.get_compaction";
}

/** config.set_scheduling 载荷：SubAgent 调度预算（运行期可调——下一次预算判定生效）。 */
export interface ConfigSetSchedulingPayload {
  maxConcurrent: number;
  maxQueued: number;
}
export interface ConfigSetSchedulingCommand extends CommandFrame<ConfigSetSchedulingPayload> {
  type: "config.set_scheduling";
}

/** config.get_scheduling 载荷：全局命令。 */
export interface ConfigGetSchedulingCommand extends CommandFrame<EmptyPayload> {
  type: "config.get_scheduling";
}

/** config.set_port 载荷：WS 监听端口（重启生效；argv --port 本次运行优先）。 */
export interface ConfigSetPortPayload {
  port: number;
}
export interface ConfigSetPortCommand extends CommandFrame<ConfigSetPortPayload> {
  type: "config.set_port";
}

/** config.get_port 载荷：全局命令。 */
export interface ConfigGetPortCommand extends CommandFrame<EmptyPayload> {
  type: "config.get_port";
}

// ── v0.2 新增：auth 管理族（契约 C §1.3；G-6 定名） ──

/** auth.list 结果载荷（事件线载荷别名，同 ModelGetResult 收敛先例） */
export type AuthListResult = AuthListResultPayload;

/** auth.list 载荷：全局命令 */
export interface AuthListCommand extends CommandFrame<EmptyPayload> {
  type: "auth.list";
}

/** auth.set_key 结果载荷（事件线载荷别名，同 ModelGetResult 收敛先例） */
export type AuthSetKeyResult = AuthSetKeyResultPayload;

/** auth.set_key 载荷：daemon 写 ~/.helix/auth.json（0600 + 文件锁）；空 apiKey = 协议层 error */
export interface AuthSetKeyPayload {
  providerId: string;
  apiKey: string;
}
export interface AuthSetKeyCommand extends CommandFrame<AuthSetKeyPayload> {
  type: "auth.set_key";
}

/** auth.delete_key 载荷 */
export interface AuthDeleteKeyPayload {
  providerId: string;
}
export interface AuthDeleteKeyCommand extends CommandFrame<AuthDeleteKeyPayload> {
  type: "auth.delete_key";
}

/** auth.verify 结果载荷：不缓存，每次真实请求（provider 最小请求探活）；事件线载荷别名，同 ModelGetResult 收敛先例 */
export type AuthVerifyResult = AuthVerifyResultPayload;

/** auth.verify 载荷 */
export interface AuthVerifyPayload {
  providerId: string;
}
export interface AuthVerifyCommand extends CommandFrame<AuthVerifyPayload> {
  type: "auth.verify";
}


// ── v0.11 新增：thinking 族（thinking 批 ①，iter-20260823-6ps5 T1.1；AD-2/AD-4，契约 = PROTOCOL-CHANGELOG.md §17.11） ──

/**
 * thinking.set 载荷：会话 thinking 档覆盖（P-1/F1.1）——信封 sessionId 必填
 *（per-session，仿 model.set（ModelSetPayload）形态），下一 turn 生效。level 为 pi-ai
 * ThinkingLevel 字符串透传（AD-2：helix 不维护第二份档位枚举，SoT 在 pi-ai，
 * 协议层不校验未知档位）；无关闭态（未覆盖 = 不发命令）。chat.send 零字段
 *（AD-4①：thinking 是会话状态非逐消息参数，引擎 turn 开始读解析结果）。
 * 生效回执 = thinking.changed 广播（events/thinking.ts）。
 */
export interface ThinkingSetPayload {
  /** pi-ai ThinkingLevel 字符串透传（如 "medium" / "high"；未知档位由引擎按能力过滤） */
  level: string;
}
export interface ThinkingSetCommand extends CommandFrame<ThinkingSetPayload> {
  type: "thinking.set";
}

