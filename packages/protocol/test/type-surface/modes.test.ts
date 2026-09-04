/**
 * modes：会话模式注册表 + mode 帧字段（P1 会话模式框架 T2，
 * mode-framework-p1；PROTOCOL-CHANGELOG.md §18 微批登记——版本位不 bump）。
 *
 * 守护面：
 * ① MODES 完整性/唯一性（注册表单点：default 恰一条，id 无重复）；
 * ② 类型级保障（ModeId 联合派生自 MODES 常量；schema 可表达
 *    single/staged/orchestrated 三 kind 不返工——staged 为 P2 预留）；
 * ③ mode 帧字段 additive（chat.send / session.snapshot /
 *    connection.welcome 三处可选 mode，携带/缺省两形态——旧客户端零破坏）。
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_MODE_ID, MODES, PROTOCOL_VERSION } from "../../src/index";
import type {
  ChatSendCommand,
  ChatSendPayload,
  ConnectionWelcomeEvent,
  ConnectionWelcomePayload,
  ModeId,
  ModeSpec,
  SessionSnapshotDto,
  SessionSnapshotEvent,
  StageSpec,
} from "../../src/index";
import type { Equal, Expect } from "./samples/helpers";
import { dispatchCommand } from "./samples/helpers";

// ── 类型级断言（编译期；任一不满足 → tsc --noEmit 失败） ──

// ModeId 联合自 MODES 常量派生：当前注册表恰 "default" 一员
//（新增模式条目 → 联合自动扩员；注册表外 id 编译期不可表达为 ModeId）
type _ModeIdDerived = Expect<Equal<ModeId, "default">>;

// schema 表达力：kind 三值恰等（P2 phase=staged / P3 workflow=orchestrated 不返工）
type _ModeKindDomain = Expect<
  Equal<ModeSpec["kind"], "single" | "staged" | "orchestrated">
>;

// StageSpec：staged 模式阶段（P2 预留）——id/profileKind 必填 + welcomeKey 可选
type _StageWelcomeKey = Expect<Equal<StageSpec["welcomeKey"], string | undefined>>;

// mode 帧字段全部 string（AD-2 字符串透传同构：协议面不校验注册表成员资格，
// 未知 mode 由 daemon 侧注册表 fallback default——T3 职责）
type _ChatSendMode = Expect<Equal<ChatSendPayload["mode"], string | undefined>>;
type _SnapshotMode = Expect<Equal<SessionSnapshotDto["mode"], string | undefined>>;
type _WelcomeMode = Expect<Equal<ConnectionWelcomePayload["mode"], string | undefined>>;

// ── 样例帧（additive 两形态：携带 / 缺省） ──

/** chat.send：草稿建会话链携带 mode（daemon 按 mode 解析 profileKind 建会话，T3 消费）。 */
const chatSendWithMode: ChatSendCommand = {
  v: PROTOCOL_VERSION,
  type: "chat.send",
  payload: { text: "你好", draft: true, mode: "default" },
};

/** chat.send：缺省形态（旧客户端 / 无模式面——缺省 = "default"，零字段旧形态仍合法）。 */
const chatSendLegacy: ChatSendCommand = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  type: "chat.send",
  payload: { text: "继续" },
};

/** connection.welcome：携带 mode（daemon 当前模式面；与 draft 字段同构）。 */
const welcomeWithMode: ConnectionWelcomeEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "notification",
  type: "connection.welcome",
  payload: { sessionId: "sess-1", model: "anthropic/claude-sonnet-4-5", agentState: "idle", mode: "default" },
};

/** connection.welcome：缺省形态（旧 daemon 不带——读侧按 "default" 兜底）。 */
const welcomeLegacy: ConnectionWelcomeEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "notification",
  type: "connection.welcome",
  payload: { sessionId: "sess-1", model: "anthropic/claude-sonnet-4-5", agentState: "idle" },
};

/** session.snapshot：携带 mode（建会话定格值回带；首条消息后锁定，无第二条写路径）。 */
const snapshotWithMode: SessionSnapshotEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "session",
  type: "session.snapshot",
  payload: {
    snapshot: {
      sessionId: "sess-1",
      model: "anthropic/claude-sonnet-4-5",
      agentState: "idle",
      revision: 0,
      entries: [],
      mode: "default",
    },
  },
};

/** session.snapshot：缺省形态（旧剧本兼容——mode 未携带）。 */
const snapshotLegacy: SessionSnapshotEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "session",
  type: "session.snapshot",
  payload: {
    snapshot: {
      sessionId: "sess-1",
      model: "anthropic/claude-sonnet-4-5",
      agentState: "idle",
      revision: 0,
      entries: [],
    },
  },
};

describe("modes：模式注册表（P1 T2）", () => {
  test("MODES 完整性：default 恰一条——single kind + main-session profileKind 绑定 + 无 stages", () => {
    expect(MODES.length).toBe(1);
    expect(MODES[0]).toEqual({ id: "default", kind: "single", profileKind: "main-session" });
    // 条目读回宽型 ModeSpec 再访问可选 stages（as const 字面量无该键 = P1 无 staged 模式）
    expect((MODES[0] as ModeSpec).stages).toBeUndefined(); // stages 为 P2 phase 预留
  });

  test("MODES 唯一性：id 无重复（模式选择器/daemon 注册表查重锚）", () => {
    const ids = MODES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("DEFAULT_MODE_ID === 'default' 且在 MODES 内（缺省语义单点——chat.send 缺省 / daemon fallback 同源）", () => {
    expect(DEFAULT_MODE_ID).toBe("default");
    expect(MODES.some((m) => m.id === DEFAULT_MODE_ID)).toBe(true);
  });
});

describe("modes：mode 帧字段 additive（携带 / 缺省两形态）", () => {
  test("chat.send：draft 链携带 mode 可窄化消费；缺省旧形态仍合法", () => {
    expect(chatSendWithMode.payload.mode).toBe("default");
    expect(chatSendWithMode.payload.draft).toBe(true);
    expect(dispatchCommand(chatSendWithMode)).toBe("send:你好");
    expect(chatSendLegacy.payload.mode).toBeUndefined(); // 旧客户端零字段旧形态
    expect(dispatchCommand(chatSendLegacy)).toBe("send:继续");
  });

  test("connection.welcome：携带 mode（daemon 当前模式面）；缺省 = 旧 daemon 形态", () => {
    expect(welcomeWithMode.payload.mode).toBe("default");
    expect(welcomeLegacy.payload.mode).toBeUndefined();
  });

  test("session.snapshot：snapshot.mode 回带已定格模式；缺省 = 旧剧本形态", () => {
    expect(snapshotWithMode.payload.snapshot.mode).toBe("default");
    expect(snapshotLegacy.payload.snapshot.mode).toBeUndefined();
  });
});
