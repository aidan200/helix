import type { EventFrame } from "../envelope";

// ── config 族命令结果帧（压缩参数配置；全局命令，无会话归属）──

/** config.get_compaction.result：压缩参数读面回执（点对点；全局命令） */
export interface ConfigGetCompactionResultPayload {
  reserveTokens: number;
  keepRecentTokens: number;
}
export interface ConfigGetCompactionResultEvent extends EventFrame<ConfigGetCompactionResultPayload> {
  channel?: "model";
  type: "config.get_compaction.result";
}

/** config.set_compaction.result：压缩参数写回执（点对点；全局命令） */
export interface ConfigSetCompactionResultPayload {
  reserveTokens: number;
  keepRecentTokens: number;
}
export interface ConfigSetCompactionResultEvent extends EventFrame<ConfigSetCompactionResultPayload> {
  channel?: "model";
  type: "config.set_compaction.result";
}

/** config.get_scheduling.result：SubAgent 调度预算读面回执（点对点；全局命令） */
export interface ConfigGetSchedulingResultPayload {
  maxConcurrent: number;
  maxQueued: number;
}
export interface ConfigGetSchedulingResultEvent extends EventFrame<ConfigGetSchedulingResultPayload> {
  channel?: "model";
  type: "config.get_scheduling.result";
}

/** config.set_scheduling.result：调度预算写回执（点对点；全局命令） */
export interface ConfigSetSchedulingResultPayload {
  maxConcurrent: number;
  maxQueued: number;
}
export interface ConfigSetSchedulingResultEvent extends EventFrame<ConfigSetSchedulingResultPayload> {
  channel?: "model";
  type: "config.set_scheduling.result";
}

/** config.get_port.result：WS 端口读面回执（点对点；全局命令） */
export interface ConfigGetPortResultPayload {
  /** 当前监听端口（本次运行实际值——argv 覆盖时为 argv 值）。 */
  effectivePort: number;
  /** 存储端口（runtime_config daemon_port；重启后生效值）。 */
  storedPort: number | null;
  /** 本次运行是否经 argv --port 显式覆盖（true 时改存储不影响本次）。 */
  overriddenByArgv: boolean;
}
export interface ConfigGetPortResultEvent extends EventFrame<ConfigGetPortResultPayload> {
  channel?: "model";
  type: "config.get_port.result";
}

/** config.set_port.result：WS 端口写回执（点对点；重启生效提示在 UI 层）。 */
export interface ConfigSetPortResultPayload {
  port: number;
}
export interface ConfigSetPortResultEvent extends EventFrame<ConfigSetPortResultPayload> {
  channel?: "model";
  type: "config.set_port.result";
}

/** config.get_sandbox.result：沙箱开关读面回执（点对点；全局命令）。 */
export interface ConfigGetSandboxResultPayload {
  enabled: boolean;
}
export interface ConfigGetSandboxResultEvent extends EventFrame<ConfigGetSandboxResultPayload> {
  channel?: "model";
  type: "config.get_sandbox.result";
}

/** config.set_sandbox.result：沙箱开关写回执（点对点；生效时机提示在 UI 层）。 */
export interface ConfigSetSandboxResultPayload {
  enabled: boolean;
}
export interface ConfigSetSandboxResultEvent extends EventFrame<ConfigSetSandboxResultPayload> {
  channel?: "model";
  type: "config.set_sandbox.result";
}
