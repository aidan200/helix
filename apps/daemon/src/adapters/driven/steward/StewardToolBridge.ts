/**
 * StewardToolBridge —— 管家工具中立规格 → pi AgentTool 投影（段B）。
 *
 * 同轨定位（用户裁定：管家也是 Agent，与其他 agent 共轨）：本桥是管家
 * 面的 resolveTools 供应体（适配器标准选项——与主会话 CoreToolExecutor.
 * resolveTools 同位），不是第二条工具轨道。driven/steward 是管家面防腐墙
 * （TTS/STT adapter 同构，AG 白名单根）：application 只见 StewardToolSpec
 * （零 pi import），本桥是管家面 pi 符号唯一出现点。
 *
 * 映射面：
 * - execute(args, {toolCallId, signal, onUpdate}) → pi 四参 execute
 *  （toolCallId, params, signal, onUpdate）——spec 的 onUpdate 文本增量包为
 *   AgentToolResult 分量（pi onUpdate 收结果形状非裸文本）；
 * - 结果：text → content 单 text 块；isError 透传（pi AgentToolResult.isError
 *  ——错误框定不强制，与闸 block 路径的强制 isError 不同面）；terminate
 *   透传（防火墙语义）。
 * - 抛错语义：spec execute 抛错 = pi 契约 throw on failure（pi agent-loop
 *   原生承接错误框定）。
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { StewardToolSpec } from "../../../application/ports/outbound/StewardToolSpec";

export function projectStewardTools(specs: readonly StewardToolSpec[]): AgentTool<any, any>[] {
  return specs.map((spec) => ({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: spec.parameters as never,
    execute: async (
      toolCallId: string,
      args: unknown,
      signal?: AbortSignal,
      onUpdate?: (partialResult: AgentToolResult<any>) => void,
    ) => {
      const result = await spec.execute(args, {
        toolCallId,
        signal,
        onUpdate:
          onUpdate === undefined
            ? undefined
            : (text) =>
                onUpdate({
                  content: [{ type: "text" as const, text }],
                  details: {},
                }),
      });
      return {
        content: [{ type: "text" as const, text: result.text }],
        details: {},
        ...(result.isError !== undefined ? { isError: result.isError } : {}),
        ...(result.terminate === true ? { terminate: true } : {}),
      };
    },
  }));
}
