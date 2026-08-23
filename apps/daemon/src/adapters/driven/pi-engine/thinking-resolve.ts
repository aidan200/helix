import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

/**
 * 主会话 thinkingLevel 解析链（architecture.md §3.1 落点一 / §3.3，thinking 批 T1.2）。
 *
 * 链顺序 = [会话覆盖, 主 session profile 槽位, 兜底 "medium"]，逐值过能力适配
 * 取首个生效值：
 * - 能力适配 = pi-ai `clampThinkingLevel`（档位语义 SoT 在 pi-ai，AD-2——helix
 *   不维护第二份枚举）：覆盖档超出当前模型能力时钳制到最近支持档（契约 ①
 *   「xhigh → high（模型能力所限）」轻提示语义，test-design §2.2）；
 * - `model.reasoning !== true` → 整链 undefined（不传 thinking 参数，provider
 *   默认，AD-3）；
 * - clamp 落 "off"（helix 无 off 语义：未知档/全档显式 null 的回落值）→ 按
 *   未配置跳过，链继续；全链落 off → undefined；
 * - 缺位（undefined/空串）= 未配置 → 后续档。
 *
 * 防腐墙：pi-ai 类型不出本域（adapters/driven/pi-engine）；调用面全链字符串
 * 透传。覆盖值本体不丢（换模只改生效档，切回自动恢复——意图/生效分离 AD-3）。
 */
export function resolveEffectiveThinking(
  chain: readonly (string | undefined)[],
  model: Model<any>,
): string | undefined {
  if (model.reasoning !== true) return undefined;
  for (const value of chain) {
    if (value === undefined || value === "") continue;
    const clamped = clampThinkingLevel(model, value as ModelThinkingLevel);
    if (clamped !== "off") return clamped;
  }
  return undefined;
}
