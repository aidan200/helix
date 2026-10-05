/**
 * 管家感知批（M0.5）单测：StewardPerceptionService（感知地基 + 激活判定 +
 * 分诊编排 + notify 限流）与 BroadcastService 归一链路。
 *
 * 红绿证据链（brief 测试要求逐条）：
 * 1. 未激活态：终态事件 → 零 LLM port 调用 + 极简播报路径仍在（回归保护）；
 * 2. 激活态：任务完成锚 → notify 帧到达（假 LLM 即时回执）+ 呈现 ≤60 字
 *    且字面可在摄入轨产物中找到（派生关系断言）；
 * 3. 归一：一次事件只触发一次 LLM 调用（perception 入口与 BroadcastService
 *    content 源双触发去重），语音文本与 notify 载荷同源；
 * 4. progress 薄条目走既有 recordSessionProgress 覆盖更新路径（零新记忆机制）；
 * 5. 限流：窗口内第 5 条 normal 通知被丢弃；high 档豁免；
 * 6. 激活判定：feed 订阅在场 ∧ 近期 ask（5 分钟衰减窗）；
 * 7. ring buffer：终态/周期事件入 ring、滚动上限；
 * 8. 聚合粗筛：task:* 会话的 agent.completed 不在 agent 级播报（聚任务级锚）。
 *
 * 设计锚点：docs/temp/steward-browser-awareness-design.md v2.8 D10/D11/D12
 * （⑨激活门/⑩摘要双轨/⑪两环二分）；E-232 ③层归一（gate 收紧为「激活」）。
 */
import { describe, expect, test } from "bun:test";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { TtsPort, TtsRequest, TtsResult } from "../../src/application/ports/outbound/TtsPort";
import type {
  StewardDiagnosisPort,
  StewardDiagnosisPrompt,
  StewardDiagnosisResult,
} from "../../src/application/ports/outbound/StewardDiagnosisPort";
import { StewardPerceptionService, STEWARD_ACTIVE_WINDOW_MS } from "../../src/application/steward/StewardPerceptionService";
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
}) {
  const tts = fakeTts();
  const frames: VoiceBroadcastPayload[] = [];
  const notifies: StewardNotifyPayload[] = [];
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
    voice: broadcast, // 直供面（enqueueDiagnosed 窄接口）
    clock: () => clockNow,
    logger: { warn: (m) => warns.push(m) },
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
    warns,
    tts,
    advance: (ms: number) => {
      clockNow += ms;
    },
  };
}

describe("激活判定（feed 订阅在场 ∧ 近期 ask 衰减窗）", () => {
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

describe("未激活态：零 LLM + 极简播报路径仍在（回归保护）", () => {
  test("agent.failed → 零分诊调用 + 极简终态语音（②层）", async () => {
    const { broadcast, perception, diagnose, tts, frames, notifies } = makeStack({
      stewardSubscribed: false, // 未激活
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
    expect(notifies.length).toBe(0); // 未激活零 notify
  });

  test("激活但 gate 断点（模型面不可用）→ 零分诊调用 + 极简播报", async () => {
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

  test("任务完成锚（未激活）→ 零分诊 + 任务级极简语音直供", async () => {
    const { perception, diagnose, tts, notifies } = makeStack({
      stewardSubscribed: false,
      subscribers: 1,
    });
    perception.onJobTerminal("job-1", "done");
    await broadcast_drain(perception);
    expect(diagnose.calls.length).toBe(0);
    expect(tts.calls.length).toBe(1);
    expect(tts.calls[0]!.text).toBe("后台任务已完成"); // 恒报终态事实（⑨ 机械降级）
    expect(notifies.length).toBe(0);
  });
});

describe("激活态：任务完成 → 分诊双轨产物 + notify 帧", () => {
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
    expect(tts.calls[0]!.text).toBe(notifies[0]!.body); // 语音文本与 notify 载荷同源
  });

  test("BroadcastService 单入口（voice 订阅在、零 steward 订阅——未激活）→ 零 LLM + 极简", async () => {
    const { broadcast, perception, diagnose, tts } = makeStack({ subscribers: 1, stewardSubscribed: false });
    broadcast.onDomainEvent(agentEvent("agent.failed", { agentId: "agent-3", error: "x", closure: closure("") }));
    await broadcast.drain();
    await perception.drain();
    expect(diagnose.calls.length).toBe(0);
    expect(tts.calls[0]!.text).toBe("后台任务失败");
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
    const { broadcast, tts } = makeStack({ subscribers: 1, stewardSubscribed: false });
    broadcast.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-9", closure: closure("散实例完成") }));
    await broadcast.drain();
    expect(tts.calls.length).toBe(1);
    expect(tts.calls[0]!.text).toBe("后台任务已完成");
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

describe("通知预算：normal ≤4 条/小时，high 豁免", () => {
  test("窗口内第 5 条 normal 通知被丢弃（语音照播——语音有自己的队列限流）", async () => {
    const { perception, notifies, tts } = makeStack({ subscribers: 1 });
    for (let i = 1; i <= 5; i++) {
      perception.onJobTerminal(`job-${i}`, "done");
      await broadcast_drain(perception);
    }
    expect(notifies.length).toBe(4); // 第 5 条被丢弃
    expect(tts.calls.length).toBe(5); // 语音照播（播报队列独立限流）
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

// ── 测试辅助 ──────────────────────────────────────────────



/** BroadcastService 队列清空等待（生产 fire-and-forget；测试收口面）。 */
async function broadcast_drain(perception: StewardPerceptionService): Promise<void> {
  await perception.drain();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}
