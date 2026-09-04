/**
 * v0.11 thinking 批 additive 断言（iter-20260823-6ps5 T1.1；契约 =
 * development/contracts/thinking-protocol.md；PROTOCOL-CHANGELOG.md §17.11）：
 * - ThinkingSetCommand（仿 ModelSetCommand：信封 sessionId 必填，per-session）；
 * - ThinkingChangedEvent（payload { override, effective }；channel = thinking 族）；
 * - CatalogModel + reasoning / thinkingLevels（防腐能力位）；
 * - AgentInstantiatedPayload + thinkingLevel（只落盘不广播语义不变，AF-6）；
 * - 目录登记断言（COMMAND_TYPES / EVENT_TYPES / EVENT_CHANNELS）；
 * - additive 零破坏：既有命令/事件签名不变 + chat.send 零字段负断言（AD-4①）；
 * - 字符串透传红线（AD-2）：全字段 `string`，protocol 不维护第二份档位枚举。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COMMAND_TYPES, EVENT_CHANNELS, EVENT_TYPES, PROTOCOL_VERSION } from "../../src/index";
import type {
  AgentInstantiatedPayload,
  CatalogModel,
  ChatSendPayload,
  ModelChangedPayload,
  ModelSetPayload,
  ThinkingChangedEvent,
  ThinkingChangedPayload,
  ThinkingSetCommand,
} from "../../src/index";
import type { Equal, Expect } from "./samples/helpers";
import { dispatchCommand, summarizeEvent } from "./samples/helpers";
import {
  agentInstantiatedThinking,
  catalogModelNoReasoning,
  catalogModelReasoning,
  thinkingChanged,
  thinkingChangedUnsupported,
  thinkingSet,
} from "./samples/v011";

// ── 类型级断言（编译期；任一不满足 → tsc --noEmit 失败） ──

// ① thinking.set：type 字面量 + payload 形状（level: string 字符串透传；无关闭态）
type _ThinkingSetType = Expect<Equal<ThinkingSetCommand["type"], "thinking.set">>;
type _ThinkingSetPayload = Expect<Equal<ThinkingSetCommand["payload"], { level: string }>>;

// ① thinking.changed：payload 恰为 { override, effective }（string|null 双位）
type _ThinkingChangedPayload = Expect<
  Equal<ThinkingChangedPayload, { override: string | null; effective: string | null }>
>;
type _ThinkingChangedChannel = Expect<Equal<ThinkingChangedEvent["channel"], "thinking" | undefined>>;

// ② CatalogModel 防腐能力位（additive 两字段；thinkingLevels = 字符串数组非枚举）
type _CatalogReasoning = Expect<Equal<CatalogModel["reasoning"], boolean>>;
type _CatalogThinkingLevels = Expect<Equal<CatalogModel["thinkingLevels"], string[]>>;

// ④ agent.instantiated payload additive + thinkingLevel（可选，string 透传；
//    Sub 未配置 → 缺席 = 默认关，iter-20260823 后续批升格）
type _InstantiatedThinkingLevel = Expect<Equal<AgentInstantiatedPayload["thinkingLevel"], string | undefined>>;

// additive 零破坏（类型级）：既有 model.set / model.changed 签名原样
type _ModelSetUnchanged = Expect<Equal<ModelSetPayload, { model: string }>>;
type _ModelChangedUnchanged = Expect<
  Equal<ModelChangedPayload, { sessionId: string; model: string; previous: string; effective: "next-turn" }>
>;

// chat.send 零 thinking 字段负断言（AD-4①：thinking 是会话状态非逐消息参数，
// 无逐消息入口；mode 例外——P1 会话模式 D4 拍板：mode 随 draft 建会话链
// 透传 = 唯一设置入口，§18 微批登记）
type _ChatSendNoThinking = Expect<
  Equal<keyof ChatSendPayload, "text" | "draft" | "model" | "images" | "mode">
>;

// 版本位单值（批次集合标记）
type _ProtocolVersionV011 = Expect<Equal<typeof PROTOCOL_VERSION, "0.11">>;

describe("v0.11：thinking 批 additive（T1.1，AD-2/AD-4）", () => {
  test("目录登记：thinking.set ∈ COMMAND_TYPES；thinking.changed ∈ EVENT_TYPES/EVENT_CHANNELS（thinking 族）", () => {
    expect(COMMAND_TYPES).toContain("thinking.set");
    expect(EVENT_TYPES).toContain("thinking.changed");
    expect(EVENT_CHANNELS["thinking.changed"]).toBe("thinking");
    // 计数：27 → 28 命令 / 47 → 48 事件（thinking 批历史口径；当前常量含后续 kg 批 +6/+6、workspace 批 +2/+3、task 批 +9/+1、kg-bootstrap 批 +5/+5、kg 维护批 +2/+2 → 52/65）
    expect(COMMAND_TYPES.length).toBe(61); // task.retry 批 +1 后当前值
    expect(EVENT_TYPES.length).toBe(78); // code.review.create 批 +1（code.review.create.result）
    expect(Object.keys(EVENT_CHANNELS).length).toBe(78); // code.review.create 批 +1
  });

  test("thinking.set：信封 sessionId 必填（per-session），payload level 字符串透传", () => {
    expect(thinkingSet.sessionId).toBe("sess-1");
    expect(thinkingSet.payload).toEqual({ level: "xhigh" });
    expect(dispatchCommand(thinkingSet)).toBe("thinking-set:sess-1:xhigh");
  });

  test("thinking.changed：override/effective 双位广播（override ≠ effective = 能力所限轻提示数据源）", () => {
    expect(thinkingChanged.channel).toBe("thinking");
    expect(thinkingChanged.payload).toEqual({ override: "xhigh", effective: "high" });
    expect(summarizeEvent(thinkingChanged)).toBe("thinking-changed:xhigh:high");
    // 全链不支持：effective = null（不传参 provider 默认，不报错）
    expect(thinkingChangedUnsupported.payload.effective).toBeNull();
    expect(summarizeEvent(thinkingChangedUnsupported)).toBe("thinking-changed:high:null");
  });

  test("CatalogModel 能力位：reasoning=true → 升序档序列；reasoning=false → 空数组（UI 禁用推理控件）", () => {
    expect(catalogModelReasoning.reasoning).toBe(true);
    expect(catalogModelReasoning.thinkingLevels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(catalogModelNoReasoning.reasoning).toBe(false);
    expect(catalogModelNoReasoning.thinkingLevels).toEqual([]);
    // 既有五字段原样（additive 零破坏抽样）
    expect(catalogModelReasoning.id).toBe("anthropic/claude-sonnet-4-5");
    expect(catalogModelReasoning.source).toBe("builtin");
  });

  test("agent.instantiated：payload 携带 thinkingLevel（只落盘不广播语义不变；可选——Sub 未配置 → 缺席）", () => {
    expect(agentInstantiatedThinking.payload.thinkingLevel).toBe("medium");
    expect(summarizeEvent(agentInstantiatedThinking)).toBe("instantiated:agent-1:subagent-worker:zai/glm-5.3:medium");
  });

  test("chat.send 零字段负断言：payload 键恰为 text/draft/model/images（无 thinking 位）", () => {
    const full: ChatSendPayload = { text: "t", draft: true, model: "m", images: [] };
    expect(Object.keys(full).sort()).toEqual(["draft", "images", "model", "text"]);
  });

  test("版本位 0.10 → 0.11（envelope 单点；批次集合标记非协商位）", () => {
    expect(PROTOCOL_VERSION).toBe("0.11");
    expect(thinkingSet.v).toBe("0.11");
    expect(thinkingChanged.v).toBe("0.11");
  });

  // ── v0.11 sot 断言（T3.1 补）：envelope 单点 ↔ PROTOCOL-CHANGELOG.md §17.11 批次登记一致性（protocol-split 批：批次备案迁 CHANGELOG，断言随迁）──
  // sot-consistency ①~⑤ 守护面（§17.3 口径）之外的批次专断：§17.N 登记节与当前
  // 版本位/批次内容的一致。解析失败必须红（缺节/缺登记点 → throw），永真断言 = 未生效。
  test("v0.11 sot：§17.11 批次登记节与 envelope 版本位 + 四块登记一致", () => {
    const doc = readFileSync(fileURLToPath(new URL("../../PROTOCOL-CHANGELOG.md", import.meta.url)), "utf8");
    // ① 批次登记节存在且批次号 == PROTOCOL_VERSION（envelope 单点 ↔ 文档登记锚一致）
    const batchAnchor = new RegExp(`^### 17\\.11 v${PROTOCOL_VERSION.replace(/\./g, "\\.")} 批次登记$`, "m");
    const head = doc.match(batchAnchor);
    if (!head || head.index === undefined) {
      throw new Error(`PROTOCOL-CHANGELOG.md 解析失败：未找到批次登记节「### 17.11 v${PROTOCOL_VERSION} 批次登记」`);
    }
    const after = doc.slice(head.index + head[0].length);
    const stop = after.match(/^### |^## /m);
    const section = stop && stop.index !== undefined ? after.slice(0, stop.index) : after;
    // ② 四块登记点在批次节内有叙述锚（缺任一 = 登记不完整，红）
    for (const anchor of ["thinking.set", "thinking.changed", "reasoning", "thinkingLevels", "thinkingLevel"]) {
      if (!section.includes(anchor)) {
        throw new Error(`PROTOCOL-CHANGELOG.md 解析失败：§17.11 批次节缺登记点「${anchor}」`);
      }
    }
    // ③ 批次声明计数与常量目录实况一致（27 → 28 / 47 → 48；历史声明不动，
    // 当前常量含后续 kg 批 +6/+6、workspace 批 +2/+3、task 批 +9/+1 → 45/58）
    expect(section).toContain("27 → 28");
    expect(section).toContain("47 → 48");
    expect(COMMAND_TYPES.length).toBe(61); // task.retry 批 +1 后当前值
    expect(EVENT_TYPES.length).toBe(78); // code.review.create 批 +1 后当前值
    // ④ chat.send 零字段负断言在批次节有登记（NFR-2① 红线文档面）
    expect(section).toContain("chat.send` **零字段**");
  });
});
