import type {
  ConfigGetCompactionResultEvent,
  ConfigSetCompactionResultEvent,
} from "@helix/protocol";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID } from "@helix/protocol";
import type { WsCommandContext } from "./context";

/**
 * config 族命令处理（压缩参数配置；全局命令，无会话归属）。依赖面 =
 * WsCommandContext.compactionConfig（CompactionConfigPort 读/写面）+ 共享
 * 辅助。结果经 *.result 结果帧点对点回执（model 族同构）。
 */

/** config.get_compaction：压缩参数读面（点对点回执）。 */
export function handleConfigGetCompaction(ctx: WsCommandContext): void {
  if (ctx.compactionConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（compactionConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const c = ctx.compactionConfig.current();
  const frame: ConfigGetCompactionResultEvent = {
    v: PROTOCOL_VERSION,
    sessionId: SYSTEM_SESSION_ID,
    channel: "model",
    type: "config.get_compaction.result",
    payload: { reserveTokens: c.reserveTokens, keepRecentTokens: c.keepRecentTokens },
  };
  ctx.sendNow(sender, frame);
}

/** config.set_compaction：压缩参数写面（点对点回执；非负整数校验）。 */
export function handleConfigSetCompaction(ctx: WsCommandContext): void {
  if (ctx.compactionConfig === undefined) {
    return ctx.commandError(ctx.type, "command.unimplemented", "config 族命令未装配（compactionConfig）");
  }
  const sender = ctx.ws.data.sender ?? ctx.rawSender();
  const reserveTokens = ctx.payload.reserveTokens;
  const keepRecentTokens = ctx.payload.keepRecentTokens;
  if (
    typeof reserveTokens !== "number" ||
    typeof keepRecentTokens !== "number" ||
    !Number.isInteger(reserveTokens) ||
    !Number.isInteger(keepRecentTokens) ||
    reserveTokens < 0 ||
    keepRecentTokens < 0
  ) {
    return ctx.commandError(
      ctx.type,
      "command.invalid_payload",
      "payload.reserveTokens/keepRecentTokens 应为非负整数",
    );
  }
  void ctx.compactionConfig
    .set({ reserveTokens, keepRecentTokens })
    .then(() => {
      const frame: ConfigSetCompactionResultEvent = {
        v: PROTOCOL_VERSION,
        sessionId: SYSTEM_SESSION_ID,
        channel: "model",
        type: "config.set_compaction.result",
        payload: { reserveTokens, keepRecentTokens },
      };
      ctx.sendNow(sender, frame);
    })
    .catch((err) => ctx.commandError(ctx.type, "command.invalid_payload", (err as Error).message));
}
