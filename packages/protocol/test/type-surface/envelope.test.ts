/**
 * 信封横切面：FrameVersion 取值域与升位联动、v0/v0.1 兼容红线、workspace 预留位、sessionId 路由位、channel 章印、常量导出。
 */
import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../../src/index";
import type {
  Channel,
  CommandFrame,
  EventEnvelope,
  EventFrame,
  FrameVersion,
  HelloCommand,
  HelloPayload,
  WorkspaceRoute,
} from "../../src/index";
import type { Equal, Expect, TypeOfChannel } from "./samples/helpers";
import { chatSendPlain, chatSendRouted, chatSendWithRoute, helloFrame, legacyCommands, legacyEvents } from "./samples/v0";
import { subAgentDelta, v01Commands, v01Events } from "./samples/v01";
import { listChangedV02, modelChangedV02, v02Commands, v02Events, v02ResultEvents } from "./samples/v02";
import { v03Commands, v03Events } from "./samples/v03";

// ── 类型级断言（编译期；任一不满足 → tsc --noEmit 失败） ──
// 帧版本位取值域（v0.7：0 = v0/v0.1 历史帧兼容读，"0.7" = 当前批帧）
type _VIsVersion = Expect<Equal<HelloCommand["v"], FrameVersion>>;

type _FrameVersionDomain = Expect<Equal<FrameVersion, 0 | "0.7">>;

// hello 协商位严格 "0.7" 单值（不取 FrameVersion 联合；fail-fast）
type _HelloVersion = Expect<Equal<HelloPayload["protocolVersion"], "0.7">>;

type _EnvelopeInstanceIdOptional = Expect<
  Equal<EventEnvelope["instanceId"], string | undefined>
>;

// 信封新字段可选（信封兼容红线：历史帧不带仍合法）
type _CommandFrameSessionIdOptional = Expect<Equal<CommandFrame["sessionId"], string | undefined>>;

type _EventFrameSessionIdOptional = Expect<Equal<EventFrame["sessionId"], string | undefined>>;

type _EventFrameChannelOptional = Expect<Equal<EventFrame["channel"], Channel | undefined>>;
type _NotificationFamily = Expect<
  Equal<TypeOfChannel<"notification">, "connection.welcome" | "connection.error">
>;

// ④ 版本位批次标记："0.7"（typeof PROTOCOL_VERSION 单值；FrameVersion / hello 联动见上）
type _ProtocolVersionV03 = Expect<Equal<typeof PROTOCOL_VERSION, "0.7">>;

describe("envelope：信封分型/版本位/兼容红线/预留与路由位（源 TP-CL2-①② / TP-v0.1-①③ / TP-v0.2-① / TP-v0.3-②）", () => {
  test("hello/welcome/snapshot/delta/工具卡/steer 徽标样例帧结构正确", () => {
    expect(helloFrame.v).toBe("0.7");
    expect(helloFrame.type).toBe("hello");
    expect(helloFrame.payload.token).toBe("dev-token-xyz");
    expect(helloFrame.payload.protocolVersion).toBe("0.7");

    const byType = new Map(legacyEvents.map((e) => [e.type, e] as const));
    const welcome = byType.get("connection.welcome");
    expect(welcome?.type === "connection.welcome" && welcome.payload.model).toBe("kimi-k2");
    const snap = byType.get("session.snapshot");
    expect(
      snap?.type === "session.snapshot" && snap.payload.snapshot.entries.length,
    ).toBe(3);
    const delta = byType.get("chat.stream.delta");
    expect(delta?.type === "chat.stream.delta" && delta.payload.delta).toBe("流式半句");
    const toolStart = byType.get("tool.call.started");
    expect(
      toolStart?.type === "tool.call.started" && toolStart.payload.entry.kind,
    ).toBe("tool-call");
    expect(byType.get("steer.queued")?.type === "steer.queued").toBe(true);
    expect(byType.get("steer.drained")?.type === "steer.drained").toBe(true);
  });

  test("信封 workspace 预留字段位：可携带（含 WorkspaceRoute）可省略", () => {
    expect(chatSendWithRoute.workspace?.workspaceId).toBe("ws-main");
    expect(chatSendPlain.workspace).toBeUndefined();
    const route: WorkspaceRoute = { workspaceId: "ws-1" };
    expect(route.workspaceId).toBe("ws-1");
    const bareRoute: WorkspaceRoute = {}; // workspaceId 本身可选
    expect(bareRoute.workspaceId).toBeUndefined();
  });

  test("v0.2 会话路由位：会话作用域命令携带信封 sessionId（AD-4）", () => {
    expect(chatSendRouted.sessionId).toBe("sess-1");
    expect(chatSendPlain.sessionId).toBeUndefined(); // 全局/未路由仍合法（可选）
  });

  test("PROTOCOL_VERSION = \"0.7\"；当前批帧 v 位全为 \"0.7\"，历史帧 v=0 合法（兼容读）", () => {
    expect(PROTOCOL_VERSION).toBe("0.7");
    for (const frame of [...v02Events, ...v02ResultEvents, ...v02Commands, ...v03Commands, ...v03Events, helloFrame]) {
      expect(frame.v).toBe("0.7");
    }
    for (const frame of [...legacyEvents, ...legacyCommands, ...v01Commands, ...v01Events]) {
      expect(frame.v).toBe(0); // v0/v0.1 历史帧：FrameVersion 取值域内合法
      expect(typeof frame.type).toBe("string");
    }
  });

  test("信封 instanceId：事件侧可携带；缺省 = 主实例（AD-3）", () => {
    expect(subAgentDelta.instanceId).toBe("agent-1");
    expect(legacyEvents[0]?.instanceId).toBeUndefined();
  });

  test("PROTOCOL_VERSION / MAIN_INSTANCE_ID / SYSTEM_SESSION_ID 导出就位", () => {
    expect(PROTOCOL_VERSION).toBe("0.7");
    // 常量断言经模块命名空间在 exports.test.ts 全量守护，此处锚定语义值
    expect(typeof PROTOCOL_VERSION).toBe("string");
  });

  test("v0.2 事件信封：sessionId + channel 章印；命令信封：sessionId 路由位", () => {
    expect(listChangedV02.channel).toBe("session");
    expect(listChangedV02.sessionId).toBe("__system__"); // 系统级事件占位
    expect(modelChangedV02.channel).toBe("model");
    expect(modelChangedV02.payload.effective).toBe("next-turn");
    expect(chatSendRouted.sessionId).toBe("sess-1");
  });

  test("PROTOCOL_VERSION = \"0.7\"；hello 协商位单值联动；当前批帧 v 位全 \"0.7\"", () => {
    expect(PROTOCOL_VERSION).toBe("0.7");
    expect(helloFrame.payload.protocolVersion).toBe("0.7");
    for (const frame of [...v03Commands, ...v03Events]) {
      expect(frame.v).toBe("0.7");
    }
    for (const frame of v03Events) {
      expect(frame.channel).toBe("agent"); // 增量帧仍走 agent 族（零新增事件类型）
    }
  });

});
