import { PROTOCOL_VERSION } from "../../../src/index";
import type {
  CatalogModel,
  CommandEnvelope,
  CompactionCompletedEvent,
  EventEnvelope,
  ModelChangedEvent,
  SessionListChangedEvent,
  SessionMeta,
  SessionSnapshotDto,
} from "../../../src/index";
import { chatSendRouted } from "./v0";
import { compactionEntry, snapshotV01, thinkingEntry } from "./v01";

/**
 * v0.2 样例帧（session 元数据与章印信封/新命令族/结果载荷/微批结果帧/compaction 扩字段/快照尾窗）
 * （T3.4 自 test/type-surface.test.ts 按版本批次归档迁出，批次身份保留；const 导出，语义随导出保留。）
 */
// ── v0.2 样例帧（契约 A §1/§2、B §1/§2、C §1/§2；构造即类型检查） ──

/** 会话元数据样例（SessionMeta：session.list / session.list_changed 同源） */
export const sampleSessionMeta: SessionMeta = {
  sessionId: "sess-1",
  title: "帮我看看 protocol 包的类型",
  lastActivityAt: 1760000099999,
  runState: "streaming",
  loaded: true,
};

/** 全章印信封样例：v="0.8"（随 PROTOCOL_VERSION bump，当前 v0.8）+ sessionId 必发 + channel 判别 */
export const listChangedV02: SessionListChangedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "__system__",
  channel: "session", // 契约 A §2：session 族（系统级广播 sessionId 占位）
  type: "session.list_changed",
  payload: { kind: "created", sessionId: "sess-1", session: sampleSessionMeta },
};
export const modelChangedV02: ModelChangedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "model",
  type: "model.changed",
  payload: { sessionId: "sess-1", model: "moonshot/kimi-k2", previous: "kimi-k2", effective: "next-turn" },
};
export const v02Events: EventEnvelope[] = [listChangedV02, modelChangedV02];

/** v0.2 新命令族样例：会话作用域走信封 sessionId，全局命令省略 */
export const v02Commands: CommandEnvelope[] = [
  chatSendRouted,
  { v: PROTOCOL_VERSION, type: "session.list", payload: {} },
  { v: PROTOCOL_VERSION, sessionId: "sess-1", type: "session.loadHistory", payload: { beforeEntryId: "e1" } },
  { v: PROTOCOL_VERSION, sessionId: "sess-1", type: "session.loadHistory", payload: { beforeEntryId: "e1", limit: 100 } },
  { v: PROTOCOL_VERSION, sessionId: "sess-1", type: "session.delete", payload: {} },
  { v: PROTOCOL_VERSION, sessionId: "sess-1", type: "session.subscribe", payload: {} },
  { v: PROTOCOL_VERSION, sessionId: "sess-1", type: "model.set", payload: { model: "moonshot/kimi-k2" } },
  { v: PROTOCOL_VERSION, sessionId: "sess-1", type: "model.get", payload: {} },
  { v: PROTOCOL_VERSION, type: "model.catalog", payload: {} },
  { v: PROTOCOL_VERSION, type: "model.catalog_refresh", payload: {} },
  { v: PROTOCOL_VERSION, type: "model.set_default", payload: { model: "moonshot/kimi-k2" } },
  { v: PROTOCOL_VERSION, type: "model.get_default", payload: {} },
  { v: PROTOCOL_VERSION, type: "auth.list", payload: {} },
  { v: PROTOCOL_VERSION, type: "auth.set_key", payload: { providerId: "moonshot", apiKey: "sk-xxx" } },
  { v: PROTOCOL_VERSION, type: "auth.delete_key", payload: { providerId: "moonshot" } },
  { v: PROTOCOL_VERSION, type: "auth.verify", payload: { providerId: "moonshot" } },
];

/** v0.2 结果载荷样例（类型级登记；daemon 行为 T2.x 落地） */
export const sampleCatalogModel: CatalogModel = {
  id: "moonshot/kimi-k2",
  providerId: "moonshot",
  contextWindow: 131_072,
  cost: { input: 4, output: 16, cacheRead: 1, cacheWrite: 8 },
  source: "builtin",
};

/**
 * v0.2 model/auth 命令结果帧样例（T2.3-result-frames 微批；点对点回执 +
 * channel=model；model.get.result 信封 sessionId = 目标会话 id，全局命令 =
 * SYSTEM_SESSION_ID——与 session 族结果帧同构，契约 C §2.2）。
 */
export const v02ResultEvents: EventEnvelope[] = [
  { v: PROTOCOL_VERSION, sessionId: "sess-1", channel: "model", type: "model.get.result", payload: { model: "moonshot/kimi-k2", isDefault: false, defaultModel: "anthropic/claude-sonnet-4-5" } },
  { v: PROTOCOL_VERSION, sessionId: "__system__", channel: "model", type: "model.catalog.result", payload: { models: [sampleCatalogModel], refreshedAt: 1_760_000_100_000, source: "builtin" } },
  { v: PROTOCOL_VERSION, sessionId: "__system__", channel: "model", type: "model.catalog_refresh.result", payload: { models: [sampleCatalogModel], refreshedAt: 1_760_000_100_000, source: "builtin", degraded: ["moonshot: 拉取失败：ENOTFOUND"] } },
  { v: PROTOCOL_VERSION, sessionId: "__system__", channel: "model", type: "model.set_default.result", payload: { previous: "anthropic/claude-sonnet-4-5" } },
  { v: PROTOCOL_VERSION, sessionId: "__system__", channel: "model", type: "model.get_default.result", payload: { model: "anthropic/claude-sonnet-4-5" } },
  { v: PROTOCOL_VERSION, sessionId: "__system__", channel: "model", type: "auth.list.result", payload: { providers: [{ providerId: "moonshot", configured: true, keyMasked: "····7f3a" }] } },
  { v: PROTOCOL_VERSION, sessionId: "__system__", channel: "model", type: "auth.set_key.result", payload: { keyMasked: "····7f3a" } },
  { v: PROTOCOL_VERSION, sessionId: "__system__", channel: "model", type: "auth.delete_key.result", payload: {} },
  { v: PROTOCOL_VERSION, sessionId: "__system__", channel: "model", type: "auth.verify.result", payload: { status: "fail", reason: "provider \"moonshot\" 未录入 API key" } },
];

/** v0.2 compaction 扩字段样例（tailKept / filesCompacted 命名定稿） */
export const compactionCompletedV02: CompactionCompletedEvent = {
  v: PROTOCOL_VERSION,
  sessionId: "sess-1",
  channel: "compaction",
  type: "compaction.completed",
  payload: { entry: compactionEntry, tailKept: 30, filesCompacted: 12 },
};

/** v0.2 快照尾窗 additive 样例：tail / totalEntries / tailStartCursor + instances[].channels */
export const snapshotV02: SessionSnapshotDto = {
  ...snapshotV01,
  tail: snapshotV01.entries.slice(0, 2), // 主时间轴尾窗（默认 30，G-1；样例取 2）
  totalEntries: 128,
  tailStartCursor: "m1", // null = 已含全部历史
  instances: [
    ...(snapshotV01.instances ?? []).map((i) =>
      i.instanceId === "agent-0"
        ? { ...i, channels: { thinking: [thinkingEntry], messages: snapshotV01.entries.filter((e) => e.kind === "message") } }
        : i,
    ),
  ],
};
