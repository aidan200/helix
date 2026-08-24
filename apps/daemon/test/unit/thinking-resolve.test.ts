import { describe, expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { resolveEffectiveThinking } from "../../src/adapters/driven/pi-engine/thinking-resolve";

/**
 * thinkingLevel 解析链（test-design §2.1/§2.2；architecture §3.1 落点一/§3.3）：
 * - 链顺序 = [会话覆盖, 主 session profile 槽位]，逐值过能力适配取首个
 *   生效值；**全链未配置 → undefined = 默认关**（pi-ai 不传 reasoning 即
 *   显式关思考；D 方案：无 medium 兜底）；
 * - 能力适配 = pi-ai clampThinkingLevel（SoT 在 pi-ai）：覆盖档超出模型能力
 *   时钳制到最近支持档（契约 ①「xhigh → high（模型能力所限）」轻提示语义）；
 * - `"off"` = **显式关**：链值 off 在 clamp 前短路整链 → undefined（后续
 *   请求不带 reasoning）。反例依据：off:null map 模型的 clamp("off") 会
 *   **向上**找最近支持档（想关反而开，语义反转）——off 短路必须先于 clamp；
 * - model.reasoning = false → 整链 undefined；clamp 落 off（未知档回落值）
 *   → 按未配置跳过，链继续；全链落 off → undefined。
 *
 * 防腐墙：本文件是 pi-ai 类型的合法所在（adapters/driven/pi-engine 域内）；
 * 出墙全链字符串透传（AD-2）。
 */

/** 测试夹具模型（只声明解析相关字段；Model 全字段面此处不需要）。 */
function fixtureModel(over: { reasoning: boolean; thinkingLevelMap?: Record<string, string | null> }): Model<any> {
  return {
    id: "fixture",
    provider: "fake",
    ...over,
  } as unknown as Model<any>;
}

/** 三档模型（tri fixture）：仅 low/medium/high 支持（minimal/xhigh/max 显式 null）。 */
const TRI = fixtureModel({
  reasoning: true,
  thinkingLevelMap: { minimal: null, low: "l", medium: "m", high: "h", xhigh: null, max: null },
});
/** 全开放模型（map 缺省 = minimal~high 支持；pi-ai 判据：xhigh/max 需显式映射才支持）。 */
const OPEN = fixtureModel({ reasoning: true });
/** 无推理模型。 */
const NO_REASONING = fixtureModel({ reasoning: false });
/** 单档模型（仅 medium 支持——低于/高于该档的覆盖均钳回 medium）。 */
const SINGLE = fixtureModel({
  reasoning: true,
  thinkingLevelMap: { minimal: null, low: null, medium: "m", high: null, xhigh: null, max: null },
});
/** reasoning=true 但全档显式 null（全链不支持的边界形态）。 */
const ALL_NULL = fixtureModel({
  reasoning: true,
  thinkingLevelMap: { minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
});
/** off:null 模型（off 显式关、high 支持——约 19% 的真实目录形态）。 */
const OFF_NULL = fixtureModel({
  reasoning: true,
  thinkingLevelMap: { off: null, high: "h" },
});

describe("解析链优先级矩阵（覆盖 > 槽位；全链未配置 = 默认关）", () => {
  test("两级各在位/缺位组合", () => {
    // 两级全在：覆盖胜
    expect(resolveEffectiveThinking(["low", "high"], TRI)).toBe("low");
    // 覆盖缺位 → 槽位
    expect(resolveEffectiveThinking([undefined, "high"], TRI)).toBe("high");
    // 覆盖空串 = 未配置 → 槽位
    expect(resolveEffectiveThinking(["", "low"], TRI)).toBe("low");
    // 覆盖 + 槽位双缺位 → undefined = 默认关（无兜底，D 方案）
    expect(resolveEffectiveThinking([undefined, undefined], TRI)).toBeUndefined();
    expect(resolveEffectiveThinking([], TRI)).toBeUndefined();
  });

  test("覆盖钳制后即生效（不再落后续档）：xhigh 覆盖 + 三档模型 → high", () => {
    expect(resolveEffectiveThinking(["xhigh", undefined], TRI)).toBe("high");
    // 槽位在位也不取——覆盖钳制值优先（契约 ①「xhigh → high（模型能力所限）」）
    expect(resolveEffectiveThinking(["xhigh", "low"], TRI)).toBe("high");
  });

  test("全开放模型：覆盖原样生效；xhigh/max 无显式映射不支持 → 钳到 high", () => {
    expect(resolveEffectiveThinking(["xhigh", undefined], OPEN)).toBe("high");
    expect(resolveEffectiveThinking(["high", undefined], OPEN)).toBe("high");
    expect(resolveEffectiveThinking(["minimal", undefined], OPEN)).toBe("minimal");
  });
});

describe("按能力过滤（supportsLevel = reasoning && thinkingLevelMap 非 null 键）", () => {
  test("reasoning=false → 全链 undefined（不传参，provider 默认）", () => {
    expect(resolveEffectiveThinking(["high", "low"], NO_REASONING)).toBeUndefined();
    expect(resolveEffectiveThinking([undefined, undefined], NO_REASONING)).toBeUndefined();
  });

  test("单档模型：低于/高于该档的覆盖均钳回唯一支持档", () => {
    expect(resolveEffectiveThinking(["minimal", undefined], SINGLE)).toBe("medium");
    expect(resolveEffectiveThinking(["max", undefined], SINGLE)).toBe("medium");
  });

  test("全档显式 null（reasoning=true）→ undefined（全链不支持）", () => {
    expect(resolveEffectiveThinking(["high", "low"], ALL_NULL)).toBeUndefined();
  });

  // T3.1 边界变体补登（test-design §4 thinkingLevels 变体矩阵）：
  // 覆盖档低于全集最低支持档 → 上钳到 levels[0]（与「超出最高档下钳」对称）。
  test("边界变体：覆盖档低于最低支持档 → 上钳 levels[0]（minimal@三档 → low）", () => {
    expect(resolveEffectiveThinking(["minimal", undefined], TRI)).toBe("low");
    // 槽位档同理（过滤判据与覆盖位一致，不分位次）
    expect(resolveEffectiveThinking([undefined, "minimal"], TRI)).toBe("low");
  });
});

describe("off 显式关（合法 override 值：clamp 前短路整链）", () => {
  test("链值 off → 立即 undefined（槽位在位也不取——显式关不是未配置）", () => {
    expect(resolveEffectiveThinking(["off", "low"], TRI)).toBeUndefined();
    expect(resolveEffectiveThinking(["off", undefined], TRI)).toBeUndefined();
    // 槽位档为 off 同样短路（任何链位）
    expect(resolveEffectiveThinking([undefined, "off"], TRI)).toBeUndefined();
  });

  // 本任务最重要的反例钉桩：off:null map（约 19% 真实目录形态）下
  // pi-ai clamp("off") 会向上找最近支持档——若 off 不在 clamp 前短路，
  // 「想关反而开」（effective 被钳成支持档而非 null）。
  test("off:null 模型反例：off 短路先于 clamp，不被钳成支持档", () => {
    // 佐证反转面：非 off 档位正常走 clamp（high → "h" 支持，原样生效）
    expect(resolveEffectiveThinking(["high", undefined], OFF_NULL)).toBe("high");
    // off 短路 → undefined（旧语义 clamp 会升到支持档——语义反转）
    expect(resolveEffectiveThinking(["off", "high"], OFF_NULL)).toBeUndefined();
    expect(resolveEffectiveThinking(["off", undefined], OFF_NULL)).toBeUndefined();
  });

  test("未知档位字符串：clamp 落 off（首个可用档）→ 按不支持跳过，链继续（helix 不做档位校验，SoT 在 pi-ai）", () => {
    // pi-ai clamp 对未知档回落 availableLevels[0] = "off" → 按未配置跳过 →
    // 链尾未配置 → undefined（默认关）
    expect(resolveEffectiveThinking(["nonsense", undefined], TRI)).toBeUndefined();
    // 后续槽位在位则生效（未知档 = 未配置，非显式关）
    expect(resolveEffectiveThinking(["nonsense", "medium"], TRI)).toBe("medium");
  });
});
