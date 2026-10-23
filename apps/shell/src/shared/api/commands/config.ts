/**
 * shared/api/commands/config —— config 域（压缩/调度/端口/沙箱/总结/知识库/语音模型等配置读写，全局命令）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  ConfigGetCompactionCommand,
  ConfigSetCompactionCommand,
  ConfigGetSchedulingCommand,
  ConfigSetSchedulingCommand,
  ConfigGetPortCommand,
  ConfigSetPortCommand,
  ConfigGetSandboxCommand,
  ConfigGetSummaryCommand,
  ConfigSetSummaryCommand,
  ConfigGetKgCommand,
  ConfigSetKgCommand,
  ConfigGetVoiceModelsCommand,
  ConfigSetVoiceModelsCommand,
  ConfigSetSandboxCommand,
  ConfigGetProxyCommand,
  ConfigSetProxyCommand,
  ConfigSetProxyPayload,
} from "@helix/protocol";

/** config.get_compaction：压缩参数读面（全局命令）。 */
export function configGetCompactionCommand(): ConfigGetCompactionCommand {
  return { v: PROTOCOL_VERSION, type: "config.get_compaction", payload: {} };
}

/** config.set_compaction：压缩参数写面（全局命令；token 绝对值）。 */
export function configSetCompactionCommand(reserveTokens: number, keepRecentTokens: number): ConfigSetCompactionCommand {
  return { v: PROTOCOL_VERSION, type: "config.set_compaction", payload: { reserveTokens, keepRecentTokens } };
}

/** config.get_scheduling：SubAgent 调度预算读面（全局命令；config 瘦身批）。 */
export function configGetSchedulingCommand(): ConfigGetSchedulingCommand {
  return { v: PROTOCOL_VERSION, type: "config.get_scheduling", payload: {} };
}

/** config.set_scheduling：调度预算写面（全局命令；运行期可调）。 */
export function configSetSchedulingCommand(maxConcurrent: number, maxQueued: number): ConfigSetSchedulingCommand {
  return { v: PROTOCOL_VERSION, type: "config.set_scheduling", payload: { maxConcurrent, maxQueued } };
}

/** config.get_port：WS 端口读面（全局命令；含 argv 覆盖信息）。 */
export function configGetPortCommand(): ConfigGetPortCommand {
  return { v: PROTOCOL_VERSION, type: "config.get_port", payload: {} };
}

/** config.set_port：WS 端口写面（全局命令；下次启动生效）。 */
export function configSetPortCommand(port: number): ConfigSetPortCommand {
  return { v: PROTOCOL_VERSION, type: "config.set_port", payload: { port } };
}

/** config.get_sandbox：沙箱开关读面（全局命令；沙箱开关批）。 */
export function configGetSandboxCommand(): ConfigGetSandboxCommand {
  return { v: PROTOCOL_VERSION, type: "config.get_sandbox", payload: {} };
}

/** config.set_sandbox：沙箱配置写面（全局命令；enabled/extraRoots 新会话/新任务生效，autoApprove 立即生效）。
 * 部分更新语义：enabled/extraRoots/autoApprove 任选至少一项，未携带项保留现值。 */
export function configSetSandboxCommand(patch: { enabled?: boolean; extraRoots?: string[]; autoApprove?: boolean }): ConfigSetSandboxCommand {
  return { v: PROTOCOL_VERSION, type: "config.set_sandbox", payload: patch };
}

/** config.get_proxy / config.set_proxy：网络代理读写面（全局命令；网络代理批）。
 * get = 现态读面；set 部分更新（enabled/url 任选至少一项，未携带项保留现值），
 * 启用时 url 必填、非空地址须满足协议单源 isValidProxyUrl（HTTP/HTTPS，可内嵌
 * 认证；不支持 SOCKS5）。写后即热：下一次出站请求生效。 */
export function configGetProxyCommand(): ConfigGetProxyCommand {
  return { v: PROTOCOL_VERSION, type: "config.get_proxy", payload: {} };
}

export function configSetProxyCommand(patch: ConfigSetProxyPayload): ConfigSetProxyCommand {
  return { v: PROTOCOL_VERSION, type: "config.set_proxy", payload: patch };
}

/** config.get_summary：总结配置读面（全局命令；总结器独立化批①）。 */
export function configGetSummaryCommand(): ConfigGetSummaryCommand {
  return { v: PROTOCOL_VERSION, type: "config.get_summary", payload: {} };
}

/** config.get_kg：知识库配置读面（全局命令；批2 WP-C「知识库」配置组——查重阈值）。 */
export function configGetKgCommand(): ConfigGetKgCommand {
  return { v: PROTOCOL_VERSION, type: "config.get_kg", payload: {} };
}

/** config.set_kg：查重阈值写面（全局命令；运行期即热）。
 * 部分更新语义：携带项写入，未携带项保留现值；回执恒回生效值。 */
export function configSetKgCommand(patch: {
  similarityWarn?: number;
  similarityDup?: number;
}): ConfigSetKgCommand {
  return { v: PROTOCOL_VERSION, type: "config.set_kg", payload: patch };
}

/** config.set_summary：总结配置写面（全局命令；运行期即热）。
 * 部分更新语义：携带项写入，未携带项保留现值。 */
export function configSetSummaryCommand(patch: {
  enabled?: boolean;
  everyTurns?: number;
  model?: string | null;
  task?: { enabled?: boolean; model?: string | null };
}): ConfigSetSummaryCommand {
  return { v: PROTOCOL_VERSION, type: "config.set_summary", payload: patch };
}

/** config.get_voice_models：ASR/TTS 模型配置读面（全局命令；模型配置接入 P0）。 */
export function configGetVoiceModelsCommand(): ConfigGetVoiceModelsCommand {
  return { v: PROTOCOL_VERSION, type: "config.get_voice_models", payload: {} };
}

/** config.set_voice_models：ASR/TTS 模型配置写面（运行期即热）。
 * 部分更新语义：携带项写入，未携带项保留现值；字段空串 = 回落默认值。 */
export function configSetVoiceModelsCommand(patch: {
  sttModel?: string;
  sttSiliconflowModel?: string;
  sttRealtimeModel?: string;
  ttsModel?: string;
  ttsStreamModel?: string;
}): ConfigSetVoiceModelsCommand {
  return { v: PROTOCOL_VERSION, type: "config.set_voice_models", payload: patch };
}
