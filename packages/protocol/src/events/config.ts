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
