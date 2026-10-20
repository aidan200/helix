/**
 * shared/api/commands/model —— model / thinking 域（运行期模型与推理档位切换、目录快照、全局默认读写）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  ModelCatalogCommand,
  ModelCatalogRefreshCommand,
  ModelGetDefaultCommand,
  ModelSetCommand,
  ModelSetDefaultCommand,
  ModelSetThinkingDefaultCommand,
  ThinkingSetCommand,
} from "@helix/protocol";

// ── model / auth 命令族（契约 C §1；T3.3 P-3/P-4）────────

/** model.set：运行期切换（P-3 选中即切；信封 sessionId 必填，下一 turn 生效）。 */
export function modelSetCommand(model: string, sessionId: string): ModelSetCommand {
  return { v: PROTOCOL_VERSION, type: "model.set", sessionId, payload: { model } };
}

/** thinking.set：会话推理强度覆盖（thinking 批①，契约 v0.11 §17.11；T2.1
 *  P-1 滑块选档；信封 sessionId 必填，下一 turn 生效；level 字符串透传
 *  ——AD-2，helix 不校验档位；生效回执 = thinking.changed 广播）。 */
export function thinkingSetCommand(level: string, sessionId: string): ThinkingSetCommand {
  return { v: PROTOCOL_VERSION, type: "thinking.set", sessionId, payload: { level } };
}

/** model.catalog：目录快照（全局命令，4h 缓存口径；P-3 打开 / P-4 进入拉取）。 */
export function modelCatalogCommand(): ModelCatalogCommand {
  return { v: PROTOCOL_VERSION, type: "model.catalog", payload: {} };
}

/** model.catalog_refresh：绕过 4h 缓存强制拉 pi.dev（P-4 刷新按钮）。 */
export function modelCatalogRefreshCommand(): ModelCatalogRefreshCommand {
  return { v: PROTOCOL_VERSION, type: "model.catalog_refresh", payload: {} };
}

/** model.get_default：全局默认读面（全局命令；P-3 DEFAULT 徽标 / 重置入口数据源）。 */
export function modelGetDefaultCommand(): ModelGetDefaultCommand {
  return { v: PROTOCOL_VERSION, type: "model.get_default", payload: {} };
}

/** model.set_thinking_default：写全局默认 thinking 档位（全局命令；level null =
 *  恢复跟随模型缺省）。 */
export function modelSetThinkingDefaultCommand(level: string | null): ModelSetThinkingDefaultCommand {
  return { v: PROTOCOL_VERSION, type: "model.set_thinking_default", payload: { level } };
}

export function modelSetDefaultCommand(model: string): ModelSetDefaultCommand {
  return { v: PROTOCOL_VERSION, type: "model.set_default", payload: { model } };
}
