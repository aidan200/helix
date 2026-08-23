import { describe, expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { resolveEffectiveThinking } from "../../src/adapters/driven/pi-engine/thinking-resolve";

/**
 * thinkingLevel 解析链（test-design §2.1/§2.2；architecture §3.1 落点一/§3.3）：
 * - 链顺序 = [会话覆盖, 主 session profile 槽位, 兜底 "medium"]，逐值过能力
 *   适配取首个生效值；
 * - 能力适配 = pi-ai clampThinkingLevel（SoT 在 pi-ai）：覆盖档超出模型能力
 *   时钳制到最近支持档（契约 ①「xhigh → high（模型能力所限）」轻提示语义）；
 * - model.reasoning = false / 全链 clamp 落 off → undefined（不传参，
 *   provider 默认）；helix 无 off 语义（off 链值按未配置跳过）。
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

describe("解析链优先级矩阵（覆盖 > 槽位 > 兜底 medium）", () => {
  test("三级各在位/缺位组合", () => {
    // 三级全在：覆盖胜
    expect(resolveEffectiveThinking(["low", "high", "medium"], TRI)).toBe("low");
    // 覆盖缺位 → 槽位
    expect(resolveEffectiveThinking([undefined, "high", "medium"], TRI)).toBe("high");
    // 覆盖空串 = 未配置 → 槽位
    expect(resolveEffectiveThinking(["", "low", "medium"], TRI)).toBe("low");
    // 覆盖 + 槽位双缺位 → 兜底 medium
    expect(resolveEffectiveThinking([undefined, undefined, "medium"], TRI)).toBe("medium");
  });

  test("覆盖钳制后即生效（不再落后续档）：xhigh 覆盖 + 三档模型 → high", () => {
    expect(resolveEffectiveThinking(["xhigh", undefined, "medium"], TRI)).toBe("high");
    // 槽位在位也不取——覆盖钳制值优先（契约 ①「xhigh → high（模型能力所限）」）
    expect(resolveEffectiveThinking(["xhigh", "low", "medium"], TRI)).toBe("high");
  });

  test("全开放模型：覆盖原样生效；xhigh/max 无显式映射不支持 → 钳到 high", () => {
    expect(resolveEffectiveThinking(["xhigh", undefined, "medium"], OPEN)).toBe("high");
    expect(resolveEffectiveThinking(["high", undefined, "medium"], OPEN)).toBe("high");
    expect(resolveEffectiveThinking(["minimal", undefined, "medium"], OPEN)).toBe("minimal");
  });
});

describe("按能力过滤（supportsLevel = reasoning && thinkingLevelMap 非 null 键）", () => {
  test("reasoning=false → 全链 undefined（不传参，provider 默认）", () => {
    expect(resolveEffectiveThinking(["high", "low", "medium"], NO_REASONING)).toBeUndefined();
    expect(resolveEffectiveThinking([undefined, undefined, "medium"], NO_REASONING)).toBeUndefined();
  });

  test("单档模型：低于/高于该档的覆盖均钳回唯一支持档", () => {
    expect(resolveEffectiveThinking(["minimal", undefined, "medium"], SINGLE)).toBe("medium");
    expect(resolveEffectiveThinking(["max", undefined, "medium"], SINGLE)).toBe("medium");
  });

  test("全档显式 null（reasoning=true）→ undefined（全链不支持）", () => {
    expect(resolveEffectiveThinking(["high", "low", "medium"], ALL_NULL)).toBeUndefined();
  });

  // T3.1 边界变体补登（test-design §4 thinkingLevels 变体矩阵）：
  // ① 覆盖档低于全集最低支持档 → 上钳到 levels[0]（与「超出最高档下钳」对称）；
  // ② 全链缺位（含兜底缺位）→ undefined（函数面边界；生产链兜底恒为 "medium"）。
  test("边界变体：覆盖档低于最低支持档 → 上钳 levels[0]（minimal@三档 → low）", () => {
    expect(resolveEffectiveThinking(["minimal", undefined, "medium"], TRI)).toBe("low");
    // 槽位档同理（过滤判据与覆盖位一致，不分位次）
    expect(resolveEffectiveThinking([undefined, "minimal", "medium"], TRI)).toBe("low");
  });

  test("边界变体：全链缺位（兜底亦缺位）→ undefined（不传参，provider 默认）", () => {
    expect(resolveEffectiveThinking([undefined, undefined, undefined], TRI)).toBeUndefined();
    expect(resolveEffectiveThinking([], TRI)).toBeUndefined();
  });

  test("helix 无 off 语义：链值 off 按未配置跳过", () => {
    expect(resolveEffectiveThinking(["off", "low", "medium"], TRI)).toBe("low");
    expect(resolveEffectiveThinking(["off", undefined, "medium"], TRI)).toBe("medium");
  });

  test("未知档位字符串：clamp 落 off（首个可用档）→ 按不支持跳过，链继续（helix 不做档位校验，SoT 在 pi-ai）", () => {
    // pi-ai clamp 对未知档回落 availableLevels[0] = "off" → helix 无 off 语义按未配置跳过
    expect(resolveEffectiveThinking(["nonsense", undefined, "medium"], TRI)).toBe("medium");
  });
});
