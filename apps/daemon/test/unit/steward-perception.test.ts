/**
 * 管家感知批（M0.5 + M0.5-R LLM 参与修正）单测：StewardPerceptionService
 * （感知地基 + 激活判定 + 分诊编排 + notify 限流）与 BroadcastService 归一
 * 链路。
 *
 * M0.5-R（v2.9 D12-⑫，用户裁决）：LLM 门槛从「激活」放宽回「启用」（money
 * gate+模型配）——**启用态分诊恒做**（不看激活）；激活降为投递面判据
 * （激活=对话内主动汇报+notify；未激活=notify+语音异步零对话插话）。
 * M0.5 的「未激活零 LLM」钉子属被推翻行为，本套已翻转为新行为断言；
 * 「未启用零 LLM + 极简保底」（money gate）钉子保留。
 *
 * 红绿证据链（brief 测试要求逐条）：
 * 1. 启用+未激活态：任务完成 → 分诊 LLM 调用发生 + notify 携呈现轨摘要与
 *    接续提案 + 语音同源 + 零对话插话 + 摄入轨照产（回来能看到干了什么）；
 * 2. 未启用（money gate 关）：零 LLM + 极简保底不变（回归钉子保留）；
 * 3. 投递面分支：激活=对话内主动汇报路径+notify；未激活=notify+语音无对话
 *    插话；分诊静默裁决（notify=false）两态一致；
 * 4. 机械增强：title=任务标题（非 UUID）；suggestions 含机械 [看看报告]
 *    （点按才动）；
 * 5. 归一：一次事件只触发一次 LLM 调用，语音文本与 notify 载荷同源；
 * 6. progress 薄条目走既有 recordSessionProgress 覆盖更新路径；
 * 7. 限流：窗口内第 5 条 normal 通知被丢弃（未激活同样生效）；high 豁免；
 * 8. 激活判定：feed 订阅在场 ∧ 近期 ask（5 分钟衰减窗）——投递面判据；
 * 9. ring buffer：终态/周期事件入 ring、滚动上限；
 * 10. 聚合粗筛：task:* 会话的 agent.completed 不在 agent 级播报（聚任务级锚）。
 *
 * 设计锚点：docs/temp/steward-browser-awareness-design.md v2.9 D10/D11/D12
 * （⑨启用门/⑩摘要双轨/⑪两环二分+⑫ LLM 参与修正）；E-249 ③层 gate 回
 * 「启用」档。
 */
import { describe, expect, test } from "bun:test";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { TtsPort, TtsRequest, TtsResult } from "../../src/application/ports/outbound/TtsPort";
import type {
  StewardDiagnosisPort,
  StewardDiagnosisPrompt,
  StewardDiagnosisResult,
} from "../../src/application/ports/outbound/StewardDiagnosisPort";
import {
  StewardPerceptionService,
  STEWARD_ACTIVE_WINDOW_MS,
  type ProactiveDialogReport,
} from "../../src/application/steward/StewardPerceptionService";
import { BroadcastService, isBroadcastEligible, buildBroadcastText } from "../../src/application/voice/BroadcastService";
import type { StewardNotifyPayload, VoiceBroadcastPayload } from "@helix/protocol";

const closure = (summary: string) => ({ status: "done" as const, summary, reportPath: null, findings: null, taskId: null });

function agentEvent(type: string, payload: unknown, sessionId = "sess-1"): DomainEvent {
  return {
    type: type as DomainEvent["type"],
    sessionId,
    instanceId: "agent-2",
    payload,
    occurredAt: "2026-10-10T06:00:00.000Z",
  };
}

function fakeTts(): TtsPort & { calls: TtsRequest[] } {
  const calls: TtsRequest[] = [];
  return {
    providerId: "dashscope",
    calls,
    async synthesize(req: TtsRequest): Promise<TtsResult> {
      calls.push(req);
      return { audio: `data:audio/wav;base64,${btoa(String(calls.length))}` };
    },
  } as TtsPort & { calls: TtsRequest[] };
}

/** fake 分诊 port：记录调用；行为可构造后重编程（setBehavior）。 */
function fakeDiagnose(
  behavior?: { result?: Partial<StewardDiagnosisResult>; error?: Error; available?: boolean },
): StewardDiagnosisPort & {
  calls: StewardDiagnosisPrompt[];
  setBehavior(b: { result?: Partial<StewardDiagnosisResult>; error?: Error; available?: boolean }): void;
} {
  const calls: StewardDiagnosisPrompt[] = [];
  let current = behavior ?? {};
  return {
    calls,
    setBehavior: (b) => {
      current = b;
    },
    isAvailable: () => current.available !== false,
    async diagnose(prompt) {
      calls.push({ ...prompt });
      if (current.error !== undefined) throw current.error;
      return {
        notify: true,
        urgency: "normal",
        present: "M0.5 感知链路已交付，测试全部通过。",
        ingest:
          "做了什么：落地管家感知链路（感知服务+分诊+notify）。\n" +
          "改动面：daemon 侧 StewardPerceptionService/BroadcastService。\n" +
          "发现统计：测试全绿，呈现轨即 M0.5 感知链路已交付，测试全部通过。\n" +
          "下一步：M1 浏览器 adapter。",
        suggestions: [],
        ...(current.result ?? {}),
      };
    },
  };
}

/** 记忆面 fake：记录 recordSessionProgress 调用（覆盖更新路径入口断言）。 */
function fakeMemory() {
  const progress: { sessionId: string; text: string }[] = [];
  return {
    progress,
    async recordSessionProgress(sessionId: string, text: string): Promise<boolean> {
      progress.push({ sessionId, text });
      return true;
    },
  };
}

/** 全链装配：BroadcastService（content 源 = perception）+ StewardPerceptionService。
 *  构造环（content → perception / voice → broadcast）经晚绑闭合——与生产
 *  container 同构形态。 */
function makeStack(opts?: {
  diagnose?: ReturnType<typeof fakeDiagnose>;
  subscribers?: number;          // voice 订阅（0 = 闸门关）
  stewardSubscribed?: boolean;   // feed 订阅在场（激活信号①）
  recentAsk?: boolean;           // 近期 ask（激活信号②，缺省 true）
  memory?: ReturnType<typeof fakeMemory>;
  now?: number;
  readReply?: (sessionId: string) => Promise<string | undefined>;
  kv?: ReturnType<typeof makeFakeKv>;
}) {
  const tts = fakeTts();
  const frames: VoiceBroadcastPayload[] = [];
  const notifies: StewardNotifyPayload[] = [];
  const dialogReports: ProactiveDialogReport[] = [];
  const warns: string[] = [];
  let clockNow = opts?.now ?? 1_000_000;
  const diagnose = opts?.diagnose ?? fakeDiagnose();
  const memory = opts?.memory ?? fakeMemory();
  let perceptionRef: StewardPerceptionService | undefined;
  const broadcast = new BroadcastService({
    tts,
    gate: {
      hasVoiceSubscribers: () => opts?.subscribers !== 0,
      voicePreference: () => undefined,
    },
    emit: (payload) => frames.push(payload),
    content: (event) => perceptionRef!.supplyBroadcastText(event),
    logger: { warn: (m) => warns.push(m) },
  });
  const perception = new StewardPerceptionService({
    diagnose,
    feedGate: { hasStewardSubscribers: () => opts?.stewardSubscribed !== false },
    memory,
    emitNotify: (payload) => notifies.push(payload),
    reportDialog: (report) => dialogReports.push(report),
    voice: broadcast, // 直供面（enqueueDiagnosed 窄接口）
    clock: () => clockNow,
    logger: { warn: (m) => warns.push(m) },
    ...(opts?.readReply !== undefined ? { readReply: opts.readReply } : {}),
    ...(opts?.kv !== undefined ? { kv: opts.kv } : {}),
  });
  perceptionRef = perception; // 晚绑闭合
  if (opts?.recentAsk !== false) perception.noteUserActivity();
  return {
    perception,
    broadcast,
    diagnose,
    memory,
    frames,
    notifies,
    dialogReports,
    warns,
    tts,
    advance: (ms: number) => {
      clockNow += ms;
    },
    kvFlush: async () => {
      await opts?.kv?.flush();
    },
  };
}

describe("激活判定（feed 订阅在场 ∧ 近期 ask 衰减窗）——v2.9：投递面判据（非 LLM 门槛）", () => {
  test("双信号齐备 → 激活", () => {
    const { perception } = makeStack({ stewardSubscribed: true, recentAsk: true });
    expect(perception.isActive()).toBe(true);
  });

  test("feed 零订阅 → 未激活（即使近期有 ask）", () => {
    const { perception } = makeStack({ stewardSubscribed: false, recentAsk: true });
    expect(perception.isActive()).toBe(false);
  });

  test("近期无 ask → 未激活（即使 feed 订阅在场）", () => {
    const { perception } = makeStack({ stewardSubscribed: true, recentAsk: false });
    expect(perception.isActive()).toBe(false);
  });

  test("ask 衰减窗：窗口内激活，超窗（>5min）衰减为未激活", () => {
    const { perception, advance } = makeStack({ stewardSubscribed: true, recentAsk: true });
    expect(perception.isActive()).toBe(true);
    advance(STEWARD_ACTIVE_WINDOW_MS + 1);
    expect(perception.isActive()).toBe(false);
    // 新 ask 重新点亮
    perception.noteUserActivity();
    expect(perception.isActive()).toBe(true);
  });
});

describe("启用 + 未激活态：分诊恒做（v2.9——LLM 门槛=启用，激活降为投递面判据）", () => {
  test("任务完成锚（启用+未激活）→ 分诊调用 + notify 携呈现轨与接续提案 + 语音同源 + 零对话插话", async () => {
    const { perception, diagnose, tts, notifies, dialogReports, memory } = makeStack({
      stewardSubscribed: false, // 未激活（零 feed 订阅）
      subscribers: 1,
    });
    perception.onJobTerminal("job-1", "done", "管家感知修正（helix）");
    await broadcast_drain(perception);
    expect(diagnose.calls.length).toBe(1); // LLM 门槛=启用（money gate+模型配），不再看激活
    expect(notifies.length).toBe(1);
    const n = notifies[0]!;
    expect(n.body).toBe("M0.5 感知链路已交付，测试全部通过。"); // 呈现轨摘要（非「后台任务已完成」纯模板）
    expect(n.title).toBe("管家感知修正（helix）"); // title=任务标题（机械字段，非 UUID）
    expect(n.title).not.toContain("job-1");
    expect(n.suggestions?.some((s) => s.verb === "open_tasks" && s.label === "看看报告")).toBe(true); // 机械接续提案（点按才动）
    expect(tts.calls.length).toBe(1);
    expect(tts.calls[0]!.text).toBe(n.body); // 语音同源（呈现轨）
    expect(dialogReports.length).toBe(0); // 未激活零对话插话（投递面分支）
    const ring = perception.ringSnapshot();
    expect(ring.some((r) => r.kind === "task.diagnosed")).toBe(true); // 摄入轨照产（回来能看到干了什么）
    expect(memory.progress).toEqual([{ sessionId: "task:job-1", text: n.body }]); // progress 薄条目照写
  });

  test("agent.failed（启用+未激活，双入口）→ 分诊恰一次 + notify/语音同源 + 零对话插话", async () => {
    const { broadcast, perception, diagnose, tts, notifies, dialogReports } = makeStack({
      stewardSubscribed: false,
      subscribers: 1,
    });
    const event = agentEvent("agent.failed", { agentId: "agent-2", error: "boom", closure: closure("xx") });
    broadcast.onDomainEvent(event);
    perception.onDomainEvent(event);
    await broadcast.drain();
    await perception.drain();
    expect(diagnose.calls.length).toBe(1); // in-flight 归一（一次事件一次调用）
    expect(notifies.length).toBe(1);
    expect(tts.calls.length).toBe(1); // 呈现轨经 content 源单条供给（不经双路重播）
    expect(tts.calls[0]!.text).toBe(notifies[0]!.body);
    expect(dialogReports.length).toBe(0); // 未激活零对话插话
  });

  test("未启用（money gate 关）→ 零 LLM + 极简保底不变（回归钉子保留）", async () => {
    const { perception, diagnose, tts, notifies, dialogReports } = makeStack({
      diagnose: fakeDiagnose({ available: false }),
      stewardSubscribed: false,
      subscribers: 1,
    });
    perception.onJobTerminal("job-1", "done", "管家感知修正（helix）");
    await broadcast_drain(perception);
    expect(diagnose.calls.length).toBe(0); // 零 LLM port 调用（money gate 机械保底）
    expect(tts.calls.length).toBe(1);
    expect(tts.calls[0]!.text).toBe("后台任务已完成"); // 极简路径仍在
    expect(notifies.length).toBe(0);
    expect(dialogReports.length).toBe(0);
  });

  test("未启用 + agent.failed → 零分诊调用 + 极简终态语音（②层）", async () => {
    const { broadcast, perception, diagnose, tts, frames, notifies } = makeStack({
      diagnose: fakeDiagnose({ available: false }),
      stewardSubscribed: false, // 未激活（此测真正门槛 = money gate）
      subscribers: 1,
    });
    const event = agentEvent("agent.failed", { agentId: "agent-2", error: "boom", closure: closure("xx") });
    broadcast.onDomainEvent(event);
    perception.onDomainEvent(event);
    await broadcast.drain();
    await perception.drain();
    expect(diagnose.calls.length).toBe(0); // 零 LLM port 调用
    expect(tts.calls.length).toBe(1);
    expect(tts.calls[0]!.text).toBe("后台任务失败"); // 极简路径仍在
    expect(frames[0]!.text).toBe("后台任务失败");
    expect(notifies.length).toBe(0); // 未启用零 notify
  });

  test("启用但 gate 断点（模型面不可用）→ 零分诊调用 + 极简播报", async () => {
    const { broadcast, perception, diagnose, tts } = makeStack({
      diagnose: fakeDiagnose({ available: false }),
    });
    const event = agentEvent("agent.killed", { agentId: "agent-2", closure: closure("用户手动停止") });
    broadcast.onDomainEvent(event);
    perception.onDomainEvent(event);
    await broadcast.drain();
    await perception.drain();
    expect(diagnose.calls.length).toBe(0);
    expect(tts.calls[0]!.text).toBe("后台任务已终止");
  });
});

describe("投递面分支（激活=对话内主动汇报+notify；未激活=notify+语音无对话插话）", () => {
  test("激活态任务完成 → 对话内主动汇报（title/呈现轨/接续提案）+ notify + 语音同达", async () => {
    const { perception, diagnose, notifies, tts, dialogReports } = makeStack({ subscribers: 1 }); // 默认激活
    diagnose.setBehavior({ result: { suggestions: [{ label: "跳报告" }, { label: "开修复" }] } });
    perception.onJobTerminal("job-1", "done", "管家感知修正（helix）");
    await broadcast_drain(perception);
    expect(dialogReports.length).toBe(1);
    const r = dialogReports[0]!;
    expect(r.title).toBe("管家感知修正（helix）");
    expect(r.text).toBe(notifies[0]!.body); // 对话内汇报与 notify 同源（呈现轨）
    expect(r.suggestions.map((s) => s.label)).toEqual(["跳报告", "开修复", "看看报告"]); // LLM 接续提案 + 机械 [看看报告]
    expect(notifies.length).toBe(1);
    expect(tts.calls.length).toBe(1);
    expect(tts.calls[0]!.text).toBe(notifies[0]!.body);
  });

  test("未激活态任务完成 → 零对话插话（notify+语音照达）", async () => {
    const { perception, notifies, tts, dialogReports } = makeStack({
      stewardSubscribed: false,
      subscribers: 1,
    });
    perception.onJobTerminal("job-1", "done", "管家感知修正（helix）");
    await broadcast_drain(perception);
    expect(dialogReports.length).toBe(0); // 无对话插话
    expect(notifies.length).toBe(1); // toast 照达
    expect(tts.calls.length).toBe(1); // 语音照达
  });

  test("分诊静默裁决（notify=false）在两态一致：零 notify 零语音零对话插话（分诊照调）", async () => {
    const active = makeStack({ subscribers: 1 });
    active.diagnose.setBehavior({ result: { notify: false } });
    active.perception.onJobTerminal("job-1", "done");
    await broadcast_drain(active.perception);
    expect(active.diagnose.calls.length).toBe(1); // 静默是裁决不是门槛
    expect(active.notifies.length).toBe(0);
    expect(active.tts.calls.length).toBe(0);
    expect(active.dialogReports.length).toBe(0);

    const idle = makeStack({ subscribers: 1, stewardSubscribed: false });
    idle.diagnose.setBehavior({ result: { notify: false } });
    idle.perception.onJobTerminal("job-2", "done");
    await broadcast_drain(idle.perception);
    expect(idle.diagnose.calls.length).toBe(1); // 两态一致
    expect(idle.notifies.length).toBe(0);
    expect(idle.tts.calls.length).toBe(0);
    expect(idle.dialogReports.length).toBe(0);
  });

  test("title 缺省（无任务标题传入）→ 回退终态词（非 UUID）", async () => {
    const { perception, notifies } = makeStack({ subscribers: 1, stewardSubscribed: false });
    perception.onJobTerminal("job-1", "done");
    await broadcast_drain(perception);
    expect(notifies.length).toBe(1);
    expect(notifies[0]!.title).toBe("任务完成");
    expect(notifies[0]!.title).not.toContain("job-1");
  });
});

describe("启用态：任务完成 → 分诊双轨产物 + notify 帧", () => {
  test("job done → 一次 LLM 双轨：notify 帧到达 + 摄入轨入 ring + progress 薄条目 + 语音直供", async () => {
    const { perception, diagnose, notifies, memory, tts } = makeStack({ subscribers: 1 });
    // 任务会话批次实例先完成（聚合——不触发分诊）
    perception.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-b1", closure: closure("批次一：感知服务落地") }, "task:job-1"));
    expect(diagnose.calls.length).toBe(0); // 完成类聚合任务级：agent 级零分诊
    perception.onJobTerminal("job-1", "done");
    await broadcast_drain(perception);
    expect(diagnose.calls.length).toBe(1); // 任务级锚触发恰一次
    // 呈现轨派生关系：notify body ≤60 字且字面可在摄入轨中找到
    expect(notifies.length).toBe(1);
    const n = notifies[0]!;
    expect([...n.body].length).toBeLessThanOrEqual(60);
    const ring = perception.ringSnapshot();
    const ingestEntry = ring.find((r) => r.kind === "task.diagnosed");
    expect(ingestEntry?.ingest).toBeDefined();
    expect(ingestEntry!.ingest!).toContain(n.body); // 派生关系断言（呈现 ⊂ 摄入）
    // progress 薄条目：既有覆盖更新路径入口（sessionId = 任务会话）
    expect(memory.progress).toEqual([{ sessionId: "task:job-1", text: n.body }]);
    // 语音与 notify 同源（present）
    expect(tts.calls.length).toBe(1);
    expect(tts.calls[0]!.text).toBe(n.body);
    // 任务锚 notify 建议携带动词指针（去任务页——点按才动）
    expect(n.suggestions?.some((s) => s.verb === "open_tasks")).toBe(true);
  });

  test("分诊输入含 ring 现场素材（批次 closure 摘要进 userPrompt）", async () => {
    const { perception, diagnose } = makeStack();
    perception.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-b1", closure: closure("批次一：感知服务落地") }, "task:job-1"));
    perception.onJobTerminal("job-1", "done");
    await broadcast_drain(perception);
    expect(diagnose.calls.length).toBe(1);
    expect(diagnose.calls[0]!.userPrompt).toContain("感知服务落地"); // ring 投影素材
    expect(diagnose.calls[0]!.userPrompt).toContain("job-1");
  });

  test("分诊裁决静默（notify=false）→ 零 notify 帧 + 语音静默丢弃（可判「不打扰」）", async () => {
    const { perception, diagnose, notifies, tts } = makeStack({ subscribers: 1 });
    diagnose.setBehavior({ result: { notify: false } });
    perception.onJobTerminal("job-1", "done");
    await broadcast_drain(perception);
    expect(notifies.length).toBe(0);
    expect(tts.calls.length).toBe(0);
  });

  test("分诊抛错/烂输出 → 静默降级（零 notify 零语音，warn 观测——不播半产物）", async () => {
    const { perception, diagnose, notifies, tts, warns } = makeStack({ subscribers: 1 });
    diagnose.setBehavior({ error: new Error("模型超时模拟") });
    perception.onJobTerminal("job-1", "done");
    await broadcast_drain(perception);
    expect(notifies.length).toBe(0);
    expect(tts.calls.length).toBe(0);
    expect(warns.length).toBeGreaterThan(0);
  });

  test("呈现轨超长防御：>60 字截断加省略号", async () => {
    const long = "长".repeat(120);
    const { perception, diagnose, notifies } = makeStack();
    diagnose.setBehavior({ result: { present: long, ingest: `${long}全文` } });
    perception.onJobTerminal("job-1", "done");
    await broadcast_drain(perception);
    expect(notifies.length).toBe(1);
    expect([...notifies[0]!.body].length).toBeLessThanOrEqual(61); // 60 + 省略号
    expect(notifies[0]!.body.endsWith("…")).toBe(true);
  });
});

describe("归一：一次事件只触发一次 LLM 调用，语音与 notify 同源", () => {
  test("agent.failed 双入口（fanout perception 桥 + BroadcastService content 源）→ diagnose 恰一次", async () => {
    const { broadcast, perception, diagnose, tts, notifies } = makeStack({ subscribers: 1 });
    const event = agentEvent("agent.failed", { agentId: "agent-3", error: "ECONNRESET", closure: closure("连接断开") });
    // 同一事件两消费面（生产装配中 fanout 会把事件同时送两桥）
    broadcast.onDomainEvent(event);
    perception.onDomainEvent(event);
    await broadcast.drain();
    await perception.drain();
    expect(diagnose.calls.length).toBe(1); // 归一：in-flight 去重
    expect(notifies.length).toBe(1);
    expect(tts.calls.length).toBe(1); // 呈现轨单条供给（语音同源不重播）
    expect(tts.calls[0]!.text).toBe(notifies[0]!.body); // 语音文本与 notify 载荷同源
  });

  test("BroadcastService 单入口（voice 订阅在、零 steward 订阅——未激活）→ 分诊照做（v2.9），语音用呈现轨", async () => {
    const { broadcast, perception, diagnose, tts, notifies } = makeStack({ subscribers: 1, stewardSubscribed: false });
    broadcast.onDomainEvent(agentEvent("agent.failed", { agentId: "agent-3", error: "x", closure: closure("") }));
    await broadcast.drain();
    await perception.drain();
    expect(diagnose.calls.length).toBe(1); // 启用即分诊（激活非门槛）
    expect(tts.calls.length).toBe(1);
    expect(tts.calls[0]!.text).toBe(notifies[0]!.body); // 呈现轨经 content 源供给（非②层极简）
    expect(tts.calls[0]!.text).not.toBe("后台任务失败");
  });
});

describe("聚合粗筛：完成类聚任务级（E-232 归一面）", () => {
  test("task:* 会话的 agent.completed 不在 agent 级播报（等任务级锚）", async () => {
    const { broadcast, tts, frames } = makeStack({ subscribers: 1 });
    broadcast.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-b1", closure: closure("批次完成") }, "task:job-1"));
    await broadcast.drain();
    expect(tts.calls.length).toBe(0); // agent 级零播报（聚合）
    expect(frames.length).toBe(0);
  });

  test("非 task 会话的 agent.completed 照旧 agent 级（散实例无任务锚可聚）", async () => {
    const { broadcast, perception, diagnose, tts, notifies } = makeStack({ subscribers: 1, stewardSubscribed: false });
    broadcast.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-9", closure: closure("散实例完成") }));
    await broadcast.drain();
    await perception.drain();
    expect(diagnose.calls.length).toBe(1); // 级分诊照做（v2.9 门槛=启用）
    expect(tts.calls.length).toBe(1);
    expect(tts.calls[0]!.text).toBe(notifies[0]!.body); // 呈现轨（非极简模板）
  });

  test("粗筛纯函数：task 会话完成类判非播报集合（isBroadcastEligible 事件级 + 会话级聚合判定分离）", () => {
    expect(isBroadcastEligible("agent.completed")).toBe(true); // 事件类型级仍在集合（散实例路径）
    expect(buildBroadcastText(agentEvent("agent.completed", { agentId: "a", closure: closure("x") }))).toBe("后台任务已完成");
  });
});

describe("ring buffer：汇报分级沉淀", () => {
  test("终态事件入 ring + 周期进展 ping 入 ring（零 LLM 零唤醒）", () => {
    const { perception, diagnose } = makeStack({ stewardSubscribed: false });
    perception.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-b1", closure: closure("批次一") }, "task:job-1"));
    perception.onDomainEvent({
      type: "steer.queued",
      sessionId: "task:job-1",
      payload: { entryId: "e1", text: "[agent-2 进展报告 #3] 状态=running", source: "progress" },
      occurredAt: "2026-10-10T06:00:00.000Z",
    });
    const ring = perception.ringSnapshot();
    expect(ring.some((r) => r.kind === "agent.completed" && r.agentId === "agent-b1")).toBe(true);
    expect(ring.some((r) => r.kind === "progress.ping")).toBe(true);
    expect(diagnose.calls.length).toBe(0); // 入 ring 零 LLM
  });

  test("滚动上限：超限丢最旧（内存有界，不落盘）", () => {
    const { perception } = makeStack({ stewardSubscribed: false });
    for (let i = 0; i < 250; i++) {
      perception.onDomainEvent(agentEvent("agent.completed", { agentId: `agent-${i}`, closure: closure(`批次${i}`) }, "task:job-1"));
    }
    const ring = perception.ringSnapshot();
    expect(ring.length).toBeLessThanOrEqual(200);
    expect(ring[0]!.agentId).toBe("agent-50"); // 最旧 50 条被滚动淘汰
  });

  test("job 终态（failed）入 ring 但不触发分诊（失败类保留 agent 级即报）", async () => {
    const { perception, diagnose } = makeStack();
    perception.onJobTerminal("job-2", "failed");
    await broadcast_drain(perception);
    expect(diagnose.calls.length).toBe(0);
    expect(perception.ringSnapshot().some((r) => r.kind === "task.terminal")).toBe(true);
  });
});

describe("通知预算：normal ≤4 条/小时，high 豁免（未激活同样生效）", () => {
  test("窗口内第 5 条 normal 通知被丢弃（语音照播——语音有自己的队列限流）", async () => {
    const { perception, notifies, tts, dialogReports } = makeStack({ subscribers: 1 });
    for (let i = 1; i <= 5; i++) {
      perception.onJobTerminal(`job-${i}`, "done");
      await broadcast_drain(perception);
    }
    expect(notifies.length).toBe(4); // 第 5 条被丢弃
    expect(tts.calls.length).toBe(5); // 语音照播（播报队列独立限流）
    expect(dialogReports.length).toBe(4); // 对话内汇报同受通知预算（防轰炸）
  });

  test("限流对未激活 notify 同样生效（激活非门槛——第 5 条丢弃，语音照播）", async () => {
    const { perception, notifies, tts, dialogReports } = makeStack({ subscribers: 1, stewardSubscribed: false });
    for (let i = 1; i <= 5; i++) {
      perception.onJobTerminal(`job-${i}`, "done", `任务${i}`);
      await broadcast_drain(perception);
    }
    expect(notifies.length).toBe(4); // 未激活态同样限流
    expect(tts.calls.length).toBe(5);
    expect(dialogReports.length).toBe(0); // 未激活零对话插话
  });

  test("窗口滑出后恢复配额", async () => {
    const { perception, notifies, advance } = makeStack();
    for (let i = 1; i <= 4; i++) {
      perception.onJobTerminal(`job-${i}`, "done");
      await broadcast_drain(perception);
    }
    expect(notifies.length).toBe(4);
    advance(60 * 60_000 + 1); // 1h 窗口滑出（顺带衰减激活窗——重新点亮）
    perception.noteUserActivity();
    perception.onJobTerminal("job-5", "done");
    await broadcast_drain(perception);
    expect(notifies.length).toBe(5);
  });

  test("high 档豁免限流（门控高危）", async () => {
    const { perception, diagnose, notifies } = makeStack();
    diagnose.setBehavior({ result: { urgency: "high" } });
    for (let i = 1; i <= 6; i++) {
      perception.onJobTerminal(`job-${i}`, "done");
      await broadcast_drain(perception);
    }
    expect(notifies.length).toBe(6);
    expect(notifies.every((n) => n.urgency === "high")).toBe(true);
  });
});

// ── 表面族第三源（M1 browser adapter 接线点：SurfaceEvent → ring） ───

describe("onSurfaceEvent（感知源扩「表面族」第三源——不改分诊/激活门语义）", () => {
  test("SurfaceEvent 入 ring：kind=surface.event、sessionId 位承载 surfaceId、text 携 kind 摘要", () => {
    const { perception } = makeStack();
    perception.onSurfaceEvent({
      kind: "user_click",
      origin: "user",
      surfaceId: "browser:tab-1",
      at: 2_000_000,
      detail: { tag: "button" },
    });
    const ring = perception.ringSnapshot();
    expect(ring).toHaveLength(1);
    expect(ring[0]).toMatchObject({
      kind: "surface.event",
      sessionId: "browser:tab-1",
      at: 2_000_000,
    });
    expect(ring[0]!.text).toContain("user_click");
  });

  test("表面事件零分诊（激活态 + 分诊可用也零 LLM——分诊锚判定语义不变）", async () => {
    const { perception, diagnose } = makeStack({ stewardSubscribed: true, recentAsk: true });
    expect(perception.isActive()).toBe(true);
    perception.onSurfaceEvent({ kind: "navigated", origin: "system", surfaceId: "browser:tab-1", at: 2_000_000 });
    await broadcast_drain(perception);
    expect(diagnose.calls).toHaveLength(0);
    expect(perception.ringSnapshot()).toHaveLength(1);
  });

  test("ring 滚动上限（PERCEPTION_RING_LIMIT）对表面事件同效", () => {
    const { perception } = makeStack();
    for (let i = 0; i < 205; i++) {
      perception.onSurfaceEvent({ kind: "user_input", origin: "user", surfaceId: `browser:t${i}`, at: 2_000_000 + i });
    }
    const ring = perception.ringSnapshot();
    expect(ring).toHaveLength(200);
    expect(ring[ring.length - 1]!.sessionId).toBe("browser:t204"); // 最新在尾
    expect(ring[0]!.sessionId).toBe("browser:t5"); // 最旧滚出
  });
});

// ── 回合终态感知（用户反馈批：主会话 turn.completed——设计 D10 系统族最后
// 一块订阅面；成本闸 = 投递关注命中才分诊，无关注只入 ring 零 LLM） ──────

describe("回合终态感知：turn.completed 入 ring + 投递关注命中分诊", () => {
  function turnEvent(sessionId: string, reason: "done" | "aborted" | "steerDrained" | "daemon_restarted"): DomainEvent {
    return agentEvent("turn.completed", { reason, replyEntryId: "entry-1" }, sessionId);
  }

  test("无关注会话的 turn.completed：入 ring 零 LLM（回合终态不全量分诊——成本闸）", () => {
    const { perception, diagnose } = makeStack();
    perception.onDomainEvent(turnEvent("sess-a", "done"));
    expect(diagnose.calls).toHaveLength(0);
    const ring = perception.ringSnapshot();
    expect(ring[ring.length - 1]!.kind).toBe("turn.completed");
    expect(ring[ring.length - 1]!.sessionId).toBe("sess-a");
  });

  test("投递关注命中：noteDelivered → 该会话 turn.completed → 分诊一次 + notify（userPrompt 含投递文本与回复读面）", async () => {
    const { perception, diagnose, notifies } = makeStack();
    perception.noteDelivered("sess-target", "帮我看看语音批的测试覆盖情况");
    perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(perception);
    expect(diagnose.calls).toHaveLength(1);
    expect(diagnose.calls[0]!.userPrompt).toContain("帮我看看语音批的测试覆盖情况");
    expect(notifies).toHaveLength(1);
    expect(notifies[0]!.title).toBe("会话回复了");
  });

  test("关注一次性消费：同会话第二次 turn.completed 不再分诊（一次投递等一次回复）", async () => {
    const { perception, diagnose } = makeStack();
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(perception);
    perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(perception);
    expect(diagnose.calls).toHaveLength(1);
  });

  test("reason=daemon_restarted 不触发分诊（重启恢复不是回复）", async () => {
    const { perception, diagnose } = makeStack();
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target", "daemon_restarted"));
    await broadcast_drain(perception);
    expect(diagnose.calls).toHaveLength(0);
  });

  test("未启用（money gate 关）：关注命中零 LLM 零 notify，但极简语音保底「投递的会话已回复」（对齐 task.done 保底语义）", async () => {
    const { perception, diagnose, notifies, frames } = makeStack({
      diagnose: fakeDiagnose({ available: false }),
    });
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(perception);
    expect(diagnose.calls).toHaveLength(0);
    expect(notifies).toHaveLength(0);
    expect(frames[frames.length - 1]!.text).toBe("投递的会话已回复");
  });

  test("修复①：分诊 userPrompt 含回复正文（readReply 读面命中——LLM 能看到那边回了什么）", async () => {
    const { perception, diagnose } = makeStack({
      readReply: async () => "测试覆盖 87%，两处缺口在语音链重试面",
    });
    perception.noteDelivered("sess-target", "帮我看看语音批的测试覆盖情况");
    perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(perception);
    expect(diagnose.calls).toHaveLength(1);
    expect(diagnose.calls[0]!.userPrompt).toContain("测试覆盖 87%");
  });

  test("修复①降级：读面缺席/报错 → prompt 标注无正文可读，分诊照常（读面失败不阻塞诊断）", async () => {
    const { perception, diagnose } = makeStack({
      readReply: async () => {
        throw new Error("db busy");
      },
    });
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(perception);
    expect(diagnose.calls).toHaveLength(1);
    expect(diagnose.calls[0]!.userPrompt).toContain("无回复正文可读");
  });

  test("修复②：投递关注跨重启存活（kv 单键快照——新实例构造即恢复关注，回合终态照命中分诊）", async () => {
    const kv = makeFakeKv();
    const first = makeStack({ kv });
    first.perception.noteDelivered("sess-target", "问题 A");
    await first.kvFlush(); // 落盘（fire-and-forget 收口）
    const second = makeStack({ kv }); // 「重启」——新服务实例同一 kv
    second.perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(second.perception);
    expect(second.diagnose.calls).toHaveLength(1);
  });

  test("修复②：消费后快照更新——重启后不重复通知（一次性消费跨重启成立）", async () => {
    const kv = makeFakeKv();
    const first = makeStack({ kv });
    first.perception.noteDelivered("sess-target", "问题 A");
    await first.kvFlush();
    first.perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(first.perception);
    await first.kvFlush(); // 消费后的快照重写落盘
    const second = makeStack({ kv });
    second.perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(second.perception);
    expect(second.diagnose.calls).toHaveLength(0); // 关注已消费，不再命中
  });

  test("修复② TTL：陈旧关注（>24h）重启后不恢复（防僵尸关注永久滞留）", async () => {
    const kv = makeFakeKv();
    const first = makeStack({ kv, now: 1_000_000 });
    first.perception.noteDelivered("sess-target", "问题 A");
    await first.kvFlush();
    const second = makeStack({ kv, now: 1_000_000 + 25 * 60 * 60_000 }); // 25h 后「重启」
    second.perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(second.perception);
    expect(second.diagnose.calls).toHaveLength(0);
  });
});

// ── 通知双轨预算与分诊降级（用户反馈批：第二条通知静默丢失 + 摘要不细致）──
// 实锤样本 daemon-2026-10-07.log 15:03:08Z：「分诊产物 JSON 解析失败（烂输出
// 整体丢弃——不播半产物）」→ 零通知零语音——事件真实发生（用户在等回复），
// 分诊失败不该静默吞掉事件本身。 ──────────────────────

describe("分诊降级保底：LLM/解析失败 → 机械通知（事件不静默丢失）", () => {
  function turnEvent(sessionId: string): DomainEvent {
    return agentEvent("turn.completed", { reason: "done", replyEntryId: "entry-1" }, sessionId);
  }

  test("分诊抛错（解析失败同形）：fallbackText 锚发机械保底 notify + 语音（不再整体静默）", async () => {
    const { perception, diagnose, notifies, frames } = makeStack({
      diagnose: fakeDiagnose({ error: new Error("分诊产物 JSON 解析失败") }),
    });
    perception.noteDelivered("sess-target", "问题 B");
    perception.onDomainEvent(turnEvent("sess-target"));
    await broadcast_drain(perception);
    expect(diagnose.calls).toHaveLength(1); // LLM 调了（启用态）
    expect(notifies).toHaveLength(1); // 失败不再静默——机械保底通知
    expect(notifies[0]!.title).toBe("会话回复了");
    expect(notifies[0]!.body).toBe("投递的会话已回复");
    expect(frames[frames.length - 1]!.text).toBe("投递的会话已回复"); // 语音保底同句
  });

  test("无 fallbackText 锚（agent 级）：分诊失败仍静默（无机械文案可降——语义只属 turn-reply）", async () => {
    const { perception, notifies } = makeStack({
      diagnose: fakeDiagnose({ error: new Error("boom") }),
    });
    perception.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-x" }, "sess-agent"));
    await broadcast_drain(perception);
    expect(notifies).toHaveLength(0);
  });
});

describe("通知正文双轨预算：present（语音 ≤60）与 detail（notify 可到 200）分轨", () => {
  function turnEvent(sessionId: string): DomainEvent {
    return agentEvent("turn.completed", { reason: "done", replyEntryId: "entry-1" }, sessionId);
  }

  test("detail 在场：notify body/dialog 用 detail，语音用 present（一句话短 / 正文详）", async () => {
    const { perception, notifies, dialogReports, frames } = makeStack({
      stewardSubscribed: true,
      recentAsk: true, // 激活 → 对话内主动汇报也发
      diagnose: fakeDiagnose({
        result: {
          present: "语音批修复完成",
          detail: "出声面协调器批已交付：双声重叠根治（新轮清在途+回执轮次校验），说停全轨静默，对话优先于通知播报。",
        },
      }),
    });
    perception.noteDelivered("sess-target", "语音问题修了吗");
    perception.onDomainEvent(turnEvent("sess-target"));
    await broadcast_drain(perception);
    expect(notifies).toHaveLength(1);
    expect(notifies[0]!.body).toBe(
      "出声面协调器批已交付：双声重叠根治（新轮清在途+回执轮次校验），说停全轨静默，对话优先于通知播报。",
    );
    expect(dialogReports[dialogReports.length - 1]!.text).toBe(
      "出声面协调器批已交付：双声重叠根治（新轮清在途+回执轮次校验），说停全轨静默，对话优先于通知播报。",
    );
    expect(frames[frames.length - 1]!.text).toBe("语音批修复完成"); // 语音轨仍短句
  });

  test("detail 缺席：notify body 回退 present（旧产物兼容——单轨不降级）", async () => {
    const { perception, notifies } = makeStack({
      diagnose: fakeDiagnose({ result: { detail: undefined } }),
    });
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target"));
    await broadcast_drain(perception);
    expect(notifies).toHaveLength(1);
    expect(notifies[0]!.body).toBe("M0.5 感知链路已交付，测试全部通过。");
  });

  test("detail 防御截断：超 200 字截断加省略号（prompt 约束外兑底）", async () => {
    const long = "长".repeat(250);
    const { perception, notifies } = makeStack({
      diagnose: fakeDiagnose({ result: { detail: long } }),
    });
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target"));
    await broadcast_drain(perception);
    expect([...notifies[0]!.body].length).toBe(201); // 200 字 + 省略号
  });
});

// ── 测试辅助 ──────────────────────────────────────────────



/** BroadcastService 队列清空等待（生产 fire-and-forget；测试收口面）。 */
async function broadcast_drain(perception: StewardPerceptionService): Promise<void> {
  await perception.drain();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

/** kv 假实现（RuntimeConfigPort 窄面：同步 get + 异步 set）+ 写收口面。 */
function makeFakeKv() {
  const store = new Map<string, string>();
  const pending: Promise<void>[] = [];
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: string) => {
      const p = Promise.resolve().then(() => {
        store.set(key, value);
      });
      pending.push(p);
      return p;
    },
    flush: async () => {
      await Promise.all(pending);
    },
  };
}
