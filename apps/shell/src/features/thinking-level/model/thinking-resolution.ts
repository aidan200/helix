/**
 * thinking-level 档位解析纯函数段（features/thinking-level/model；thinking 批
 * T2.2，P-2 展示位）。与 thinking-capability.ts 同段纪律：纯函数（AG-14），
 * 无 React / 无 IO / 不 import pi-ai。
 *
 * 职责边界（AD-2/AD-3）：helix 全链字符串透传、不做档位校验；spawn 时的
 * 按能力解析权威在 daemon（SubagentLauncher.resolveThinkingFor，pi-ai
 * clamp 同源）。本模块的 canonical 序只是**展示位镜像**——用于 P-2 字段把
 * 已配置档映射到当前槽位模型能力下的显示位 + 轻提示组装（「xhigh → high
 * （模型能力所限）」），配置值本体永不改写。未知档位字符串视为高于全部
 * 已知档（展示位落最高被支持档，徽标仍原样显示配置值）。
 */

/** pi-ai ThinkingLevel canonical 升序（展示位镜像，非第二份枚举 SoT；
 *  档位语义唯一事实源在 pi-ai——本表只回答「展示时谁比谁高」）。 */
const CANONICAL_ORDER: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** canonical 位次；未知字符串 = +∞（展示上视为最高，与「引擎按能力过滤」同向）。 */
function rankOf(level: string): number {
  const i = CANONICAL_ORDER.indexOf(level);
  return i === -1 ? Number.POSITIVE_INFINITY : i;
}

/**
 * 配置档 → 槽位模型能力下的生效展示位（原型 resolveEffective 同源规则）：
 * 能力集内 canonical 序 ≤ want 的最高档；全低于 want 无匹配时落最低档；
 * 空能力集 → null（UI 落禁用/加载位）。
 */
export function resolveEffectiveLevel(levels: readonly string[], want: string): string | null {
  if (levels.length === 0) return null;
  const wantRank = rankOf(want);
  let best: string | null = null;
  for (const lv of levels) {
    const r = rankOf(lv);
    if (r <= wantRank && (best === null || r > rankOf(best))) best = lv;
  }
  return best ?? levels[0]!;
}
