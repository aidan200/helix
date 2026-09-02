/**
 * 目录完备性族：COMMAND_TYPES/EVENT_TYPES 恰等、全目录构造分发、八族登记与分族窄化、v0.4 计数。
 */
import { describe, expect, test } from "bun:test";
import { COMMAND_TYPES, EVENT_CHANNELS, EVENT_TYPES } from "../../src/index";
import type { CommandEnvelope, EventEnvelope } from "../../src/index";
import type { Equal, EnvelopeTypeOf, Expect, TypeOfChannel } from "./samples/helpers";
import { dispatchCommand, familyOf, summarizeEvent } from "./samples/helpers";
import { legacyCommands, legacyEvents } from "./samples/v0";
import { v01Commands, v01Events } from "./samples/v01";
import { compactionCompletedV02, v02Commands, v02Events, v02ResultEvents } from "./samples/v02";
import { v03Commands } from "./samples/v03";
import { traceQueryResult, v04Commands } from "./samples/v04";
import { v06Commands, v06Events } from "./samples/v06";
import { v07Commands, v07Events } from "./samples/v07";
import { v09Commands, v09Events } from "./samples/v09";
import { v010Commands, v010Events } from "./samples/v010";

// ── 类型级断言（编译期；任一不满足 → tsc --noEmit 失败） ──
// 命令目录常量 ↔ 命令信封联合 type 集合双向一致（v0.9：27 个）
type _CommandSync = Expect<Equal<EnvelopeTypeOf<CommandEnvelope>, (typeof COMMAND_TYPES)[number]>>;

// 事件目录常量 ↔ 事件信封联合 type 集合双向一致（v0.9 口径：47 个）
type _EventSync = Expect<Equal<EnvelopeTypeOf<EventEnvelope>, (typeof EVENT_TYPES)[number]>>;

type V01CommandTypes = "agent.kill" | "agent.subscribe" | "agent.unsubscribe";

type _V01CommandMembers = Expect<
  Equal<Extract<EnvelopeTypeOf<CommandEnvelope>, V01CommandTypes>, V01CommandTypes>
>;

type V01EventTypes =
  | "agent.spawned"
  | "agent.queued"
  | "agent.started"
  | "agent.stalled"
  | "agent.completed"
  | "agent.failed"
  | "agent.killed"
  | "thinking.stream.delta"
  | "thinking.completed"
  | "compaction.completed"
  | "usage.recorded";

type _V01EventMembers = Expect<
  Equal<Extract<EnvelopeTypeOf<EventEnvelope>, V01EventTypes>, V01EventTypes>
>;

// 新 13 命令 type 字面量全部在命令联合中（漏任一 → Extract 不等）
type V02CommandTypes =
  | "session.list"
  | "session.loadHistory"
  | "session.delete"
  | "model.set"
  | "model.get"
  | "model.catalog"
  | "model.catalog_refresh"
  | "model.set_default"
  | "model.get_default"
  | "auth.list"
  | "auth.set_key"
  | "auth.delete_key"
  | "auth.verify";

type _V02CommandMembers = Expect<
  Equal<Extract<EnvelopeTypeOf<CommandEnvelope>, V02CommandTypes>, V02CommandTypes>
>;

// 新 4 事件 type 字面量全部在事件联合中（T2.2 定稿：+session.list.result / session.loadHistory.result）
type V02EventTypes =
  | "session.list_changed"
  | "model.changed"
  | "session.list.result"
  | "session.loadHistory.result";

type _V02EventMembers = Expect<
  Equal<Extract<EnvelopeTypeOf<EventEnvelope>, V02EventTypes>, V02EventTypes>
>;

// 微批 9 结果事件 type 字面量全部在事件联合中（T2.3-result-frames；漏任一 → Extract 不等）
type V02ResultEventTypes =
  | "model.get.result"
  | "model.catalog.result"
  | "model.catalog_refresh.result"
  | "model.set_default.result"
  | "model.get_default.result"
  | "auth.list.result"
  | "auth.set_key.result"
  | "auth.delete_key.result"
  | "auth.verify.result";

type _V02ResultEventMembers = Expect<
  Equal<Extract<EnvelopeTypeOf<EventEnvelope>, V02ResultEventTypes>, V02ResultEventTypes>
>;

type _InteractionFamily = Expect<Equal<TypeOfChannel<"interaction">, never>>; // 占位族：无事件挂靠

// v0.6 新增 agent.config 族 type 字面量全部在联合中（漏任一 → Extract 不等）
type V06CommandTypes = "agent.config.list" | "agent.config.set_enabled";

type _V06CommandMembers = Expect<
  Equal<Extract<EnvelopeTypeOf<CommandEnvelope>, V06CommandTypes>, V06CommandTypes>
>;

type V06EventTypes =
  | "agent.config.changed"
  | "agent.config.list.result"
  | "agent.config.set_enabled.result";

type _V06EventMembers = Expect<
  Equal<Extract<EnvelopeTypeOf<EventEnvelope>, V06EventTypes>, V06EventTypes>
>;

// v0.7 新增 web 族 type 字面量全部在联合中（漏任一 → Extract 不等）
type V07CommandTypes = "web.status" | "web.stop";

type _V07CommandMembers = Expect<
  Equal<Extract<EnvelopeTypeOf<CommandEnvelope>, V07CommandTypes>, V07CommandTypes>
>;

type V07EventTypes = "web.status.result" | "web.stop.result" | "web.status.changed";

type _V07EventMembers = Expect<
  Equal<Extract<EnvelopeTypeOf<EventEnvelope>, V07EventTypes>, V07EventTypes>
>;

// v0.9 新增 web.start 命令/结果帧 type 字面量全部在联合中（漏任一 → Extract 不等）
type V09CommandTypes = "web.start";

type _V09CommandMembers = Expect<
  Equal<Extract<EnvelopeTypeOf<CommandEnvelope>, V09CommandTypes>, V09CommandTypes>
>;

type V09EventTypes = "web.start.result";

type _V09EventMembers = Expect<
  Equal<Extract<EnvelopeTypeOf<EventEnvelope>, V09EventTypes>, V09EventTypes>
>;

// task 批新增九命令 type 字面量全部在联合中（iter-20260829-ys7q T1.5；漏任一 → Extract 不等）
type TaskCommandTypes =
  | "task.list"
  | "task.detail"
  | "task.artifacts"
  | "task.subscribe"
  | "task.unsubscribe"
  | "task.pause"
  | "task.resume"
  | "task.cancel"
  | "task.delete";

type _TaskCommandMembers = Expect<
  Equal<Extract<EnvelopeTypeOf<CommandEnvelope>, TaskCommandTypes>, TaskCommandTypes>
>;

type _TaskEventMembers = Expect<
  Equal<Extract<EnvelopeTypeOf<EventEnvelope>, "task.changed">, "task.changed">
>;

describe("catalog：命令/事件目录完备性与八族登记（源 TP-CL2-③ / TP-v0.2-② / TP-v0.3-②）", () => {
  test("命令目录恰为 58 个 type（… + config 批 2 + kg 批 6 + workspace 批 2 + task 批 9 + kg-bootstrap 批 5 + kg 维护批 2 + kg 评审批 1 + kg.health 1 + kg.candidates.list 批 1）", () => {
    expect([...COMMAND_TYPES].sort()).toEqual(
      [
        "agent.config.list",
        "agent.config.set_enabled",
        "agent.kill",
        "agent.subscribe",
        "agent.unsubscribe",
        "auth.delete_key",
        "auth.list",
        "auth.set_key",
        "auth.verify",
        "chat.abort",
        "chat.send",
        "chat.steer",
        "config.get_compaction",
        "config.set_compaction",
        "kg.bootstrap.create",
        "kg.bootstrap.impact",
        "kg.bootstrap.produce",
        "kg.candidates.list",
        "kg.change.report",
        "kg.graph.purge",
        "kg.health",
        "kg.index.delete",
        "kg.index.status",
        "kg.list",
        "kg.node.confirm",
        "kg.node.detail",
        "kg.node.supersede",
        "kg.node.update",
        "kg.projects",
        "kg.review.create",
        "model.catalog",
        "model.catalog_refresh",
        "model.get",
        "model.get_default",
        "model.set",
        "model.set_default",
    "model.set_thinking_default",
        "session.delete",
        "session.list",
        "session.loadHistory",
        "session.subscribe",
        "session.unsubscribe",
        "task.artifacts",
        "task.cancel",
        "task.delete",
        "task.detail",
        "task.list",
        "task.pause",
        "task.resume",
        "task.subscribe",
        "task.unsubscribe",
        "thinking.set",
        "trace.query",
        "web.start",
        "web.status",
        "web.stop",
        "workspace.get",
        "workspace.open",
      ],
    );
  });

  test("事件目录恰为 74 个 type（… + config 批 2 + kg 评审批 1 + 网络重试批 1 + park/resume 批 2 + kg.candidates.list 批 1）", () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        "agent.completed",
        "agent.config.changed",
        "agent.config.list.result",
        "agent.config.set_enabled.result",
        "agent.failed",
        "agent.instantiated",
        "agent.killed",
        "agent.model.changed",
        "agent.parked",
        "agent.queued",
        "agent.resumed",
        "agent.spawned",
        "agent.stalled",
        "agent.started",
        "agent.state.changed",
        "auth.delete_key.result",
        "auth.list.result",
        "auth.set_key.result",
        "auth.verify.result",
        "chat.message.completed",
        "chat.stream.delta",
        "chat.turn.completed",
        "chat.turn.started",
        "compaction.completed",
        "config.get_compaction.result",
        "config.set_compaction.result",
        "connection.error",
        "connection.welcome",
        "engine.error",
        "engine.retrying",
        "kg.bootstrap.create.result",
        "kg.bootstrap.impact.result",
        "kg.bootstrap.produce.result",
        "kg.candidates.list.result",
        "kg.change.report.result",
        "kg.graph.purge.result",
        "kg.health.result",
        "kg.index.delete.result",
        "kg.index.status.result",
        "kg.list.result",
        "kg.node.confirm.result",
        "kg.node.detail.result",
        "kg.node.supersede.result",
        "kg.node.update.result",
        "kg.projects.result",
        "kg.review.create.result",
        "model.catalog.result",
        "model.catalog_refresh.result",
        "model.changed",
        "model.get.result",
        "model.get_default.result",
        "model.set_default.result",
      "model.set_thinking_default.result",
        "session.list.result",
        "session.list_changed",
        "session.loadHistory.result",
        "session.snapshot",
        "steer.drained",
        "steer.queued",
        "task.changed",
        "thinking.changed",
        "thinking.completed",
        "thinking.stream.delta",
        "tool.call.result",
        "tool.call.started",
        "trace.query.result",
        "usage.recorded",
        "web.start.result",
        "web.status.changed",
        "web.status.result",
        "web.stop.result",
        "workspace.get.result",
        "workspace.open.result",
        "workspace_changed",
      ],
    );
  });

  test("全部 27 个命令信封可构造且可分发（含 v0.3/v0.4/v0.6/v0.7/v0.9 扩展形态）", () => {
    const out = [...legacyCommands, ...v01Commands, ...v02Commands, ...v03Commands, ...v04Commands, ...v06Commands, ...v07Commands, ...v09Commands, ...v010Commands].map(dispatchCommand);
    expect(out).toEqual([
      "send:hi",
      "steer:改用方案 B:main",
      "abort",
      "subscribe:-:full", // v0 历史帧：不带信封 sessionId / tier 仍合法（可选缺省）
      "unsubscribe",
      "kill:agent-2",
      "agent-sub:agent-2",
      "agent-unsub:agent-2",
      // v0.2 样例
      "send:发给 sess-1",
      "session-list",
      "load-history:sess-1:e1:50", // limit 缺省 50（G-1）
      "load-history:sess-1:e1:100",
      "session-delete:sess-1",
      "subscribe:sess-1:full", // v0.2 信封 sessionId 路由 + v0.3 tier 缺省 full
      "model-set:sess-1:moonshot/kimi-k2",
      "model-get:sess-1",
      "model-catalog",
      "model-catalog-refresh",
      "model-set-default:moonshot/kimi-k2",
      "model-get-default",
      "auth-list",
      "auth-set-key:moonshot",
      "auth-delete-key:moonshot",
      "auth-verify:moonshot",
      // v0.3 样例（tier / instanceId 扩展形态）
      "subscribe:sess-1:monitor",
      "subscribe:sess-1:full",
      "steer:定向注入 agent-1:agent-1",
      // v0.4 样例（trace.query 全过滤维 / 全缺省）
      "trace-query:sess-1:2:100:428",
      "trace-query:sess-1:all:50:-",
      // v0.6 样例（agent.config 族：list 两形态 + set_enabled 四形态）
      "agent-config-list:all",
      "agent-config-list:subagent-worker",
      "agent-config-set:main-session:tool:grep:false",
      "agent-config-set:main-session:skill:hello-skill:true",
      "agent-config-set:main-session:model:anthropic/claude-sonnet-4-5:true",
      "agent-config-set:main-session:model:-:false",
      // v0.7 样例（web 族：status 查询 + stop 写面，均无参全局命令）
      "web-status",
      "web-stop",
      // v0.9 样例（web 族：start 显式启动写面，无参全局命令）
      "web-start",
      // v0.10 样例（T9 图片上行：chat.send 携带 images data URL 数组）
      "send:看看这张截图",
    ]);
  });

  test("全部 47 个事件信封可构造且窄化分发正确", () => {
    const out = [...legacyEvents, ...v01Events, ...v02Events, ...v02ResultEvents, ...v06Events, ...v07Events, ...v09Events, ...v010Events].map(summarizeEvent);
    expect(out).toEqual([
      "welcome:sess-1:kimi-k2:running",
      "error:auth.missing_token:握手缺少 token",
      "snapshot:sess-1:3:42",
      "delta:e5:流式半句",
      "turn-start:turn-7",
      "turn-end:turn-7:aborted",
      "msg:e5",
      "steer-q:e2",
      "steer-d:e2",
      "tool-start:e6",
      "tool-result:e6",
      "state:steering",
      "engine-error:429: 已达到 5 小时的使用上限",
      // v0.1 编排生命周期族
      "spawned:agent-1:修协议守护测试:subagent-worker:moonshot/kimi-k2",
      "queued:agent-1:2",
      "started:agent-1",
      "stalled:agent-1:330000",
      "completed:agent-1:done",
      "failed:agent-1:provider 5xx:failed",
      "killed:agent-1:failed",
      // v0.1 通道族
      "think-delta:agent-1:思考增量半句",
      "think-done:tk-1:4200",
      "compaction:cp-1:340000:20000:-:-", // v0.1 帧不带扩字段（additive 兼容）
      "usage:main:11640:turn",
      // v0.2 新增
      "list-changed:created:sess-1:streaming",
      "model-changed:sess-1:moonshot/kimi-k2:kimi-k2:next-turn",
      // 微批 9 结果帧（T2.3-result-frames）
      "model-get-result:moonshot/kimi-k2:false:anthropic/claude-sonnet-4-5",
      "model-catalog-result:1:builtin",
      "model-catalog-refresh-result:1:builtin:1",
      "model-set-default-result:anthropic/claude-sonnet-4-5",
      "model-get-default-result:anthropic/claude-sonnet-4-5",
      "auth-list-result:1:true",
      "auth-set-key-result:····7f3a",
      "auth-delete-key-result",
      "auth-verify-result:fail:provider \"moonshot\" 未录入 API key",
      // v0.6 样例（agent.config 族：结果帧两判别 + 广播 model clear null 形态）
      "agent-config-list-result:2:main-session:anthropic/claude-sonnet-4-5",
      "agent-config-changed:main-session:tool:grep:false",
      "agent-config-changed:subagent-worker:model:null:false",
      "agent-config-set-result:applied:-",
      "agent-config-set-result:skipped:unknown-name",
      "agent-config-set-result:skipped:unknown-model",
      // v0.7 样例（web 族：两结果帧 + changed 广播两形态）
      "web-status-result:connected:2:2",
      "web-status-result:idle:0:0",
      "web-stop-result:applied",
      "web-status-changed:error:0:-",
      "web-status-changed:connected:1:Chrome",
      // v0.9 样例（web 族：start.result 两判别 applied / skipped+reason）
      "web-start-result:applied:-",
      "web-start-result:skipped:未发现开启远程调试的浏览器（--remote-debugging-port）",
      // v0.10 样例（T9 图片下行：user 消息/工具结果携带 images）
      "msg:e5",
      "tool-result:e6",
    ]);
  });

  test("switch(channel) 分族窄化：各族 type 联合窄化正确（占位族不可达）", () => {
    expect(familyOf(v02Events[0]!)).toBe("session/session.list_changed");
    expect(familyOf(v02Events[1]!)).toBe("model/model.changed");
    expect(familyOf(legacyEvents[0]!)).toBe("legacy/connection.welcome"); // 兼容读缺省路径
    expect(familyOf(compactionCompletedV02)).toBe("compaction/compaction.completed");
    expect(familyOf(traceQueryResult)).toBe("trace/trace.query.result"); // v0.4 新族窄化
    expect(familyOf(v07Events[0]!)).toBe("web/web.status.result"); // v0.7 新族窄化
    expect(familyOf(v09Events[0]!)).toBe("web/web.start.result"); // v0.9 扩展帧窄化
  });

  test("EVENT_CHANNELS 登记目录与契约 A §2 映射表恰等", () => {
    expect(Object.keys(EVENT_CHANNELS).sort()).toEqual([...EVENT_TYPES].sort());
    const roster = (c: string): string[] =>
      [...EVENT_TYPES].filter((t) => EVENT_CHANNELS[t] === c).sort();
    expect(roster("chat")).toEqual(
      [
        "agent.state.changed",
        "chat.message.completed",
        "chat.stream.delta",
        "chat.turn.completed",
        "chat.turn.started",
        "engine.error",
        "engine.retrying",
        "steer.drained",
        "steer.queued",
        "tool.call.result",
        "tool.call.started",
      ],
    );
    expect(roster("agent")).toEqual([
      "agent.completed",
      "agent.config.changed",
      "agent.config.list.result",
      "agent.config.set_enabled.result",
      "agent.failed",
      "agent.instantiated",
      "agent.killed",
      "agent.model.changed",
      "agent.parked",
      "agent.queued",
      "agent.resumed",
      "agent.spawned",
      "agent.stalled",
      "agent.started",
    ]);
    expect(roster("thinking")).toEqual(["thinking.changed", "thinking.completed", "thinking.stream.delta"]); // v0.11：+thinking.changed（thinking 批①）
    expect(roster("usage")).toEqual(["usage.recorded"]);
    expect(roster("compaction")).toEqual(["compaction.completed"]);
    expect(roster("session")).toEqual([
      "session.list.result",
      "session.list_changed",
      "session.loadHistory.result",
      "session.snapshot",
    ]);
    expect(roster("model")).toEqual([
      "auth.delete_key.result",
      "auth.list.result",
      "auth.set_key.result",
      "auth.verify.result",
      "config.get_compaction.result",
      "config.set_compaction.result",
      "model.catalog.result",
      "model.catalog_refresh.result",
      "model.changed",
      "model.get.result",
      "model.get_default.result",
      "model.set_default.result",
      "model.set_thinking_default.result",
    ]);
    expect(roster("interaction")).toEqual([]); // 占位族：无事件挂靠
    expect(roster("trace")).toEqual(["trace.query.result"]); // v0.4 新族（点对点结果帧）
    expect(roster("notification")).toEqual(["connection.error", "connection.welcome", "task.changed"]); // task 批：+task.changed（挂既有 notification 通道，不新增 Channel 值）
    expect(roster("web")).toEqual(["web.start.result", "web.status.changed", "web.status.result", "web.stop.result"]); // v0.7 新族 + v0.9 扩展
    expect(roster("kg")).toEqual([
      // kg 批新族（iter-20260825-11fo T5.3）：六命令点对点回执，O-6 零推送事件
      "kg.bootstrap.create.result",
      "kg.bootstrap.impact.result",
      "kg.bootstrap.produce.result",
      "kg.candidates.list.result",
      "kg.change.report.result",
      "kg.graph.purge.result",
      "kg.health.result",
      "kg.index.delete.result",
      "kg.index.status.result",
      "kg.list.result",
      "kg.node.confirm.result",
      "kg.node.detail.result",
      "kg.node.supersede.result",
      "kg.node.update.result",
      "kg.projects.result",
      "kg.review.create.result",
    ]);
    expect(roster("workspace")).toEqual([
      // workspace 批新族（W1 绑定闭环）：两结果帧 + 一广播
      "workspace.get.result",
      "workspace.open.result",
      "workspace_changed",
    ]);
  });

  test("目录计数（kg.candidates.list 批后）：EVENT_TYPES 74 / EVENT_CHANNELS 74 键 / COMMAND_TYPES 58", () => {
    expect(EVENT_TYPES.length).toBe(74); // kg.candidates.list 批：+1（kg.candidates.list.result）
    expect(new Set(EVENT_TYPES).size).toBe(74); // 无重复
    expect(Object.keys(EVENT_CHANNELS).length).toBe(74); // 登记目录恰等
    expect(COMMAND_TYPES.length).toBe(58); // kg.candidates.list 批：+1（kg.candidates.list）
  });

});
