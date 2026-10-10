/**
 * 管家感知批（M0.5 + M0.5-R LLM 参与修正）单测：StewardPerceptionService
 * （感知地基 + 激活判定 + 分诊编排 + notify 限流）与 BroadcastService 归一
 * 链路。
 *
 * 2026-10-08 用户裁决（白话播报重构）：①任务终态锚机械化——任务状态是机械
 * 事实，零 LLM 零判官，notify/语音同句白话短讯；②任务内 agent 终态零播报
 * （用户只关心任务整体）；③会话回复锚：notify 机械短讯（生命周期短），
 * 详文归宿是管家语音，判官 noul 单判详略（verbose）；④凡是播报出来的都
 * 必须是大白话（机械短讯/保底句/生成文案全部白话，禁术语英文 UUID）。
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
  TRIAGE_JUDGE_VERBOSE_QUESTION,
  TRIAGE_GENERATION_SYSTEM_PROMPT,
  type ProactiveDialogReport,
} from "../../src/application/steward/StewardPerceptionService";
import type { TriageJudgeFace } from "../../src/application/steward/StewardTriageJudge";
import { BroadcastService } from "../../src/application/voice/BroadcastService";
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

/** fake 分诊 port：记录调用；行为可构造后重编程（setBehavior）。判官批新增
 *  generateText 纯文本面（text/textError 可编程——判定路径生成段）。 */
function fakeDiagnose(
  behavior?: { result?: Partial<StewardDiagnosisResult>; error?: Error; available?: boolean; text?: string; textError?: Error },
): StewardDiagnosisPort & {
  calls: StewardDiagnosisPrompt[];
  textCalls: StewardDiagnosisPrompt[];
  setBehavior(b: { result?: Partial<StewardDiagnosisResult>; error?: Error; available?: boolean; text?: string; textError?: Error }): void;
} {
  const calls: StewardDiagnosisPrompt[] = [];
  const textCalls: StewardDiagnosisPrompt[] = [];
  let current = behavior ?? {};
  return {
    calls,
    textCalls,
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
    async generateText(prompt) {
      textCalls.push({ ...prompt });
      if (current.textError !== undefined) throw current.textError;
      return current.text ?? "默认口语句。\n\n默认正文要点。";
    },
  };
}

/** fake 分诊判官判定面（管家分诊判官接入批）：noul 双判可编程
 *  （worth/risk/error）；enabled/ready 缺省双 true（开启且就绪）。窄面
 *  Pick<enabled/ready/noul>——与感知服务判定依赖同形。 */
function fakeTriageJudge(behavior?: {
  enabled?: boolean;
  ready?: boolean;
  verbose?: number;
  error?: Error;
}): Pick<TriageJudgeFace, "enabled" | "ready" | "noul"> & {
  calls: { state: string; question: string }[];
  setBehavior(b: { enabled?: boolean; ready?: boolean; verbose?: number; error?: Error }): void;
} {
  const calls: { state: string; question: string }[] = [];
  let current = behavior ?? {};
  return {
    calls,
    setBehavior: (b) => {
      current = b;
    },
    enabled: () => current.enabled !== false,
    ready: () => current.ready !== false,
    noul: async (state, question) => {
      calls.push({ state, question });
      if (current.error !== undefined) throw current.error;
      return current.verbose ?? 0.9;
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
  triageJudge?: ReturnType<typeof fakeTriageJudge>;
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
    ...(opts?.triageJudge !== undefined ? { triageJudge: opts.triageJudge } : {}),
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

describe("任务终态锚机械化（用户裁决 2026-10-08：任务状态是机械事实——零 LLM 零判官零分诊；notify/语音同句机械短讯）", () => {
  test("job done → 零分诊调用 + 机械 notify「xx 任务完成了」（未激活零语音——C 裁决，激活对照见下节）", async () => {
    const { perception, diagnose, tts, notifies, dialogReports, memory } = makeStack({
      stewardSubscribed: false,
      subscribers: 1,
    });
    perception.onJobTerminal("job-1", "done", "管家感知修正（helix）");
    await broadcast_drain(perception);
    expect(diagnose.calls.length).toBe(0); // 机械事实不进 LLM
    expect(notifies.length).toBe(1);
    expect(notifies[0]!.title).toBe("管家感知修正（helix）");
    expect(notifies[0]!.body).toBe("任务完成了"); // 机械短句（非 600 字详文）
    expect(tts.calls.length).toBe(0); // C 裁决：光球不在场，normal 只 toast 静默
    expect(dialogReports.length).toBe(0); // 主动对话汇报随分诊退役
    expect(memory.progress.length).toBe(0); // progress 薄条目随分诊退役（ring task.terminal 照记）
    expect(perception.ringSnapshot().some((r) => r.kind === "task.terminal")).toBe(true); // ring 照记
  });

  test("title 缺省 → 回退「后台任务」标题（非 UUID）", async () => {
    const { perception, notifies } = makeStack({ stewardSubscribed: false, subscribers: 1 });
    perception.onJobTerminal("job-1", "done");
    await broadcast_drain(perception);
    expect(notifies.length).toBe(1);
    expect(notifies[0]!.title).toBe("后台任务");
    expect(notifies[0]!.title).not.toContain("job-1");
  });

  test("job failed/cancelled → 机械通知照发（失败早知道——仍零 LLM）", async () => {
    const { perception, diagnose, notifies } = makeStack({ stewardSubscribed: false, subscribers: 1 });
    perception.onJobTerminal("job-2", "failed", "判官接入批");
    await broadcast_drain(perception);
    expect(diagnose.calls.length).toBe(0);
    expect(notifies.length).toBe(1);
    expect(notifies[0]!.body).toContain("失败");
  });

  test("机械通知受 normal 预算限流（第 5 条丢弃——防轰炸）", async () => {
    const { perception, notifies } = makeStack({ stewardSubscribed: false, subscribers: 1 });
    for (let i = 1; i <= 5; i++) {
      perception.onJobTerminal(`job-${i}`, "done", `任务${i}`);
      await broadcast_drain(perception);
    }
    expect(notifies.length).toBe(4);
  });
});

describe("语音播报激活绑定（用户裁决 2026-10-08 C：光球不在场 = normal 只 toast 静默，仅 failed/high 才开口；光球在场 = 完整详报——说面与 TR-250 听面原则同源）", () => {
  function turnEvent(sessionId: string): DomainEvent {
    return agentEvent("turn.completed", { reason: "done", replyEntryId: "entry-1" }, sessionId);
  }

  test("任务 done + 激活 → 语音同句恢复（toast + 语音双通道）", async () => {
    const { perception, tts, notifies } = makeStack({ stewardSubscribed: true, recentAsk: true, subscribers: 1 });
    perception.onJobTerminal("job-1", "done", "判官接入批");
    await broadcast_drain(perception);
    expect(notifies).toHaveLength(1);
    expect(tts.calls).toHaveLength(1);
    expect(tts.calls[0]!.text).toBe("任务完成了");
  });

  test("任务 done + 未激活 → 零语音（C 裁决核心：normal 档只 toast）", async () => {
    const { perception, tts, notifies } = makeStack({ stewardSubscribed: false, recentAsk: false, subscribers: 1 });
    perception.onJobTerminal("job-1", "done", "判官接入批");
    await broadcast_drain(perception);
    expect(notifies).toHaveLength(1); // toast 照发
    expect(tts.calls).toHaveLength(0); // 零语音
  });

  test("任务 failed + 未激活 → 语音照播（失败豁免——真出事才破沉默）", async () => {
    const { perception, tts, notifies } = makeStack({ stewardSubscribed: false, recentAsk: false, subscribers: 1 });
    perception.onJobTerminal("job-2", "failed", "判官接入批");
    await broadcast_drain(perception);
    expect(notifies).toHaveLength(1);
    expect(tts.calls).toHaveLength(1);
    expect(tts.calls[0]!.text).toBe("任务失败了");
  });

  test("会话回复详报 + 未激活 → notify 短讯照发 + 零语音（详报只在光球在场时上嘴）", async () => {
    const { perception, notifies, frames } = makeStack({
      stewardSubscribed: false,
      recentAsk: false,
      diagnose: fakeDiagnose({
        result: { present: "对话回复了", detail: "这是详细的逐项汇报正文，未激活不该被念出来。" },
      }),
    });
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target"));
    await broadcast_drain(perception);
    expect(notifies).toHaveLength(1); // 机械短讯照发
    expect(frames).toHaveLength(0); // 零语音帧
  });

  test("分诊失败 fallback + 未激活 → notify 保底照发 + 零语音", async () => {
    const { perception, notifies, frames } = makeStack({
      stewardSubscribed: false,
      recentAsk: false,
      diagnose: fakeDiagnose({ available: false }),
    });
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target"));
    await broadcast_drain(perception);
    expect(notifies).toHaveLength(1);
    expect(notifies[0]!.body).toBe("那个对话回你了");
    expect(frames).toHaveLength(0);
  });
});

describe("任务内 agent 终态零播报（用户裁决：用户只关心任务整体——内部 agent 状态不进任何播报/通知面）", () => {
  test("agent.failed/killed（任何会话）→ 零分诊零 notify 零语音（仅 ring 记录）", async () => {
    const { perception, diagnose, tts, notifies } = makeStack({ subscribers: 1, stewardSubscribed: false });
    for (const type of ["agent.failed", "agent.killed", "agent.completed"] as const) {
      perception.onDomainEvent(agentEvent(type, { agentId: "agent-x", error: "boom", closure: closure("xx") }));
    }
    await broadcast_drain(perception);
    expect(diagnose.calls.length).toBe(0); // agent 级不再触发分诊
    expect(notifies.length).toBe(0); // 零 notify
    expect(tts.calls.length).toBe(0); // 零语音
    expect(perception.ringSnapshot().some((r) => r.kind === "agent.failed")).toBe(true); // ring 照记
  });
});

describe("会话回复锚：notify 机械简化 + 正文全给管家（用户裁决 2026-10-08：通知生命周期短——机械短讯；详文归宿是管家语音，jev 判定详略）", () => {
  function turnEvent(sessionId: string): DomainEvent {
    return agentEvent("turn.completed", { reason: "done", replyEntryId: "entry-1" }, sessionId);
  }

  test("回复命中 → notify 机械短讯「对话回复了」+ 语音为详文主体（detail 优先，600 字料归嘴）", async () => {
    const { perception, notifies, frames } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose: fakeDiagnose({
        result: {
          present: "对话回复了",
          detail: "出声面协调器批已交付：双声重叠根治，说停全轨静默，对话优先于通知播报。这是详细的逐项汇报正文。",
        },
      }),
    });
    perception.noteDelivered("sess-target", "语音问题修了吗");
    perception.onDomainEvent(turnEvent("sess-target"));
    await broadcast_drain(perception);
    expect(notifies).toHaveLength(1);
    expect(notifies[0]!.title).toBe("对话回复了");
    expect(notifies[0]!.body).toBe("回完了，具体我语音里说"); // 机械短讯（非 600 字详文）
    expect(frames[frames.length - 1]!.text).toBe(
      "出声面协调器批已交付：双声重叠根治，说停全轨静默，对话优先于通知播报。这是详细的逐项汇报正文。", // 详文归宿 = 管家语音
    );
  });

  test("判官详略判定：jev 裁「简短」→ 语音也一句（present 单轨）；裁「详细」→ 语音用 detail", async () => {
    const judge = fakeTriageJudge({ verbose: 0.1 }); // 简短裁决
    const diagnose = fakeDiagnose({ text: "口语句简短。\n\n详细逐项正文。" });
    const { perception: p1, frames } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: judge,
      readReply: async () => "回复正文",
    });
    p1.noteDelivered("sess-a", "问题 A");
    p1.onDomainEvent(turnEvent("sess-a"));
    await broadcast_drain(p1);
    expect(frames[frames.length - 1]!.text).toBe("口语句简短。"); // 简短裁决 → present 单轨

    const judge2 = fakeTriageJudge({ verbose: 0.9 }); // 详细裁决
    const { perception: p2, frames: frames2 } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: judge2,
      readReply: async () => "回复正文",
    });
    p2.noteDelivered("sess-b", "问题 B");
    p2.onDomainEvent(turnEvent("sess-b"));
    await broadcast_drain(p2);
    expect(frames2[frames2.length - 1]!.text).toBe("详细逐项正文。"); // 详细裁决 → detail 上嘴
  });

  test("无判官（回退路径）→ 详略由 detail 在场决定：有 detail 用 detail，缺席用 present", async () => {
    const { perception: p1, frames } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose: fakeDiagnose({ result: { present: "短句", detail: "详文内容" } }),
      readReply: async () => "回复正文",
    });
    p1.noteDelivered("sess-a", "问题 A");
    p1.onDomainEvent(turnEvent("sess-a"));
    await broadcast_drain(p1);
    expect(frames[frames.length - 1]!.text).toBe("详文内容");

    const { perception: p2, frames: frames2 } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose: fakeDiagnose({ result: { present: "短句", detail: undefined } }),
      readReply: async () => "回复正文",
    });
    p2.noteDelivered("sess-b", "问题 B");
    p2.onDomainEvent(turnEvent("sess-b"));
    await broadcast_drain(p2);
    expect(frames2[frames2.length - 1]!.text).toBe("短句");
  });
});

describe("agent 级播报退役（用户裁决：agent 事件零播报——用户只关心任务整体）", () => {
  test("agent.completed/failed/killed（task 与非 task 会话）→ 零分诊零 notify 零语音（仅 ring 记录）", async () => {
    const { perception, diagnose, tts, notifies } = makeStack({ subscribers: 1, stewardSubscribed: false });
    perception.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-b1", closure: closure("批次完成") }, "task:job-1"));
    perception.onDomainEvent(agentEvent("agent.failed", { agentId: "agent-9", error: "x", closure: closure("") }, "sess-x"));
    perception.onDomainEvent(agentEvent("agent.killed", { agentId: "agent-c", closure: closure("手动停") }));
    await broadcast_drain(perception);
    expect(diagnose.calls.length).toBe(0);
    expect(notifies.length).toBe(0);
    expect(tts.calls.length).toBe(0);
    expect(perception.ringSnapshot().length).toBeGreaterThanOrEqual(3); // ring 照记
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

describe("通知预算：normal ≤4 条/小时，high 豁免（机械通知同样生效）", () => {
  test("窗口内第 5 条 normal 机械通知被丢弃（语音照播——语音有自己的队列限流）", async () => {
    const { perception, notifies, tts } = makeStack({ subscribers: 1 });
    for (let i = 1; i <= 5; i++) {
      perception.onJobTerminal(`job-${i}`, "done");
      await broadcast_drain(perception);
    }
    expect(notifies.length).toBe(4); // 第 5 条被丢弃
    expect(tts.calls.length).toBe(5); // 语音照播（播报队列独立限流）
  });

  test("窗口滑出后恢复配额", async () => {
    const { perception, notifies, advance } = makeStack({ subscribers: 1 });
    for (let i = 1; i <= 4; i++) {
      perception.onJobTerminal(`job-${i}`, "done");
      await broadcast_drain(perception);
    }
    expect(notifies.length).toBe(4);
    advance(60 * 60_000 + 1); // 1h 窗口滑出
    perception.onJobTerminal("job-5", "done");
    await broadcast_drain(perception);
    expect(notifies.length).toBe(5);
  });

  test("failed 任务 → high 档豁免限流（失败早知道——零 LLM 纯机械档位）", async () => {
    const { perception, notifies } = makeStack({ subscribers: 1 });
    for (let i = 1; i <= 6; i++) {
      perception.onJobTerminal(`job-${i}`, "failed", `任务${i}`);
      await broadcast_drain(perception);
    }
    expect(notifies.length).toBe(6); // high 全达
    expect(notifies.every((n) => n.urgency === "high")).toBe(true);
    expect(notifies.every((n) => n.body === "任务失败了")).toBe(true); // 白话机械短讯
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
    expect(notifies[0]!.title).toBe("对话回复了");
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

  test("未启用（money gate 关）：零 LLM，机械保底 notify + 语音同句「那个对话回你了」（对齐任务终态机械语义）", async () => {
    const { perception, diagnose, notifies, frames } = makeStack({
      diagnose: fakeDiagnose({ available: false }),
    });
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target", "done"));
    await broadcast_drain(perception);
    expect(diagnose.calls).toHaveLength(0);
    expect(notifies).toHaveLength(1); // 机械事实不依赖 LLM 配置
    expect(notifies[0]!.title).toBe("对话回复了");
    expect(notifies[0]!.body).toBe("那个对话回你了");
    expect(frames[frames.length - 1]!.text).toBe("那个对话回你了");
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

  test("分诊抛错（解析失败同形）：机械保底 notify + 语音同句（不再整体静默）", async () => {
    const { perception, diagnose, notifies, frames } = makeStack({
      diagnose: fakeDiagnose({ error: new Error("分诊产物 JSON 解析失败") }),
    });
    perception.noteDelivered("sess-target", "问题 B");
    perception.onDomainEvent(turnEvent("sess-target"));
    await broadcast_drain(perception);
    expect(diagnose.calls).toHaveLength(1); // LLM 调了（启用态）
    expect(notifies).toHaveLength(1); // 失败不再静默——机械保底通知
    expect(notifies[0]!.title).toBe("对话回复了");
    expect(notifies[0]!.body).toBe("那个对话回你了");
    expect(frames[frames.length - 1]!.text).toBe("那个对话回你了"); // 语音保底同句（白话）
  });

  test("agent 级锚已退役：分诊失败也零 notify（agent 事件零播报面）", async () => {
    const { perception, notifies } = makeStack({
      diagnose: fakeDiagnose({ error: new Error("boom") }),
    });
    perception.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-x" }, "sess-agent"));
    await broadcast_drain(perception);
    expect(notifies).toHaveLength(0);
  });
});

describe("语音详文轨预算：detail 语音轨独立预算（2000，长报告不截断）+ notify 视觉面保 600", () => {
  function turnEvent(sessionId: string): DomainEvent {
    return agentEvent("turn.completed", { reason: "done", replyEntryId: "entry-1" }, sessionId);
  }

  test("语音轨 650 字不截断（600 是 notify 视觉预算，不再误伤语音）", async () => {
    const long = "长".repeat(650);
    const { perception, frames } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose: fakeDiagnose({ result: { detail: long } }),
    });
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target"));
    await broadcast_drain(perception);
    expect([...frames[frames.length - 1]!.text].length).toBe(650); // 语音轨全文上嘴（无截断）
  });

  test("语音轨超长防御：>2000 字截断加省略号（prompt 约束外兑底）", async () => {
    const long = "长".repeat(2100);
    const { perception, frames } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose: fakeDiagnose({ result: { detail: long } }),
    });
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target"));
    await broadcast_drain(perception);
    expect([...frames[frames.length - 1]!.text].length).toBe(2001); // 2000 字 + 省略号（语音轨兑底）
  });

  test("白话硬约束：生成提示词明禁术语/英文/变量名/UUID（两段均白话）", async () => {
    const diagnose = fakeDiagnose();
    const { perception } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: fakeTriageJudge({ verbose: 0.9 }),
    });
    perception.noteDelivered("sess-target", "问题 A");
    perception.onDomainEvent(turnEvent("sess-target"));
    await broadcast_drain(perception);
    expect(diagnose.textCalls[0]!.systemPrompt).toContain("大白话");
    expect(diagnose.textCalls[0]!.systemPrompt).toContain("禁止技术术语");
  });
});

describe("判官详略判定面（用户裁决：管家用 jev 判断回复要不要详细播报——noul 单判 + 生成纯文本两段制白话）", () => {
  function turnEvent(sessionId: string): DomainEvent {
    return agentEvent("turn.completed", { reason: "done", replyEntryId: "entry-1" }, sessionId);
  }

  test("判官开启：noul 详略单判 + generateText 纯文本两段（零 JSON 调用），详略裁决取 detail/present", async () => {
    const diagnose = fakeDiagnose({ text: "一句话总结。\n\n逐项详述正文。" });
    const judge = fakeTriageJudge({ verbose: 0.9 });
    const { perception, frames, notifies } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: judge,
      readReply: async () => "回复正文",
    });
    perception.noteDelivered("sess-a", "问题 A");
    perception.onDomainEvent(turnEvent("sess-a"));
    await broadcast_drain(perception);
    expect(judge.calls.length).toBe(1); // 单判：详略
    expect(judge.calls[0]!.question).toBe(TRIAGE_JUDGE_VERBOSE_QUESTION);
    expect(judge.calls[0]!.state).toContain("问题 A"); // 现场摘要 = 分诊 userPrompt 同源
    expect(diagnose.textCalls.length).toBe(1); // 纯文本两段制
    expect(diagnose.calls.length).toBe(0); // 零 JSON
    expect(diagnose.textCalls[0]!.systemPrompt).toBe(TRIAGE_GENERATION_SYSTEM_PROMPT);
    expect(frames[frames.length - 1]!.text).toBe("逐项详述正文。"); // 详略=详细 → detail 上嘴
    expect(notifies[0]!.body).toBe("回完了，具体我语音里说"); // notify 机械短讯不变
  });

  test("判官详略=简短（verbose < 0.5）→ 语音用 present 单轨（notify 照机械短讯）", async () => {
    const diagnose = fakeDiagnose({ text: "一句话总结。\n\n逐项详述正文。" });
    const judge = fakeTriageJudge({ verbose: 0.1 });
    const { perception, frames, notifies } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: judge,
      readReply: async () => "回复正文",
    });
    perception.noteDelivered("sess-b", "问题 B");
    perception.onDomainEvent(turnEvent("sess-b"));
    await broadcast_drain(perception);
    expect(frames[frames.length - 1]!.text).toBe("一句话总结。"); // 简短裁决
    expect(notifies[0]!.body).toBe("回完了，具体我语音里说");
  });

  test("判官抛错 → WARN + 回退：detail 在场决定详略（不重试判官）", async () => {
    const diagnose = fakeDiagnose({ result: { present: "短句", detail: "详文内容" } });
    const judge = fakeTriageJudge({ error: new Error("判官端点不可达") });
    const { perception, frames, warns } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: judge,
      readReply: async () => "回复正文",
    });
    perception.noteDelivered("sess-c", "问题 C");
    perception.onDomainEvent(turnEvent("sess-c"));
    await broadcast_drain(perception);
    expect(judge.calls.length).toBe(1); // 抛错即降级：不重试
    expect(warns.some((w) => w.includes("判官"))).toBe(true);
    expect(diagnose.calls.length).toBe(1); // 回退 JSON 路径
    expect(diagnose.textCalls.length).toBe(0);
    expect(frames[frames.length - 1]!.text).toBe("详文内容"); // 回退详略：detail 在场 → 详
  });

  test("开关开但端点未配/失效（ready false）→ WARN + 回退 detail 在场决定", async () => {
    const diagnose = fakeDiagnose({ result: { present: "短句", detail: undefined } });
    const { perception, frames, warns } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: fakeTriageJudge({ ready: false }),
      readReply: async () => "回复正文",
    });
    perception.noteDelivered("sess-d", "问题 D");
    perception.onDomainEvent(turnEvent("sess-d"));
    await broadcast_drain(perception);
    expect(warns.some((w) => w.includes("未配") || w.includes("失效"))).toBe(true);
    expect(frames[frames.length - 1]!.text).toBe("短句"); // detail 缺席 → present
  });

  test("判官关闭（enabled false）→ 零判官调用零 warn，回退 detail 在场决定", async () => {
    const diagnose = fakeDiagnose({ result: { present: "短句", detail: "详文" } });
    const judge = fakeTriageJudge({ enabled: false });
    const { perception, frames, warns } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: judge,
      readReply: async () => "回复正文",
    });
    perception.noteDelivered("sess-e", "问题 E");
    perception.onDomainEvent(turnEvent("sess-e"));
    await broadcast_drain(perception);
    expect(judge.calls.length).toBe(0);
    expect(warns.length).toBe(0);
    expect(frames[frames.length - 1]!.text).toBe("详文");
  });

  test("烂文本兑底：空文本 → notify 机械短讯照发 + 语音保底白话句（无解析失败类别）", async () => {
    const diagnose = fakeDiagnose({ text: "   " });
    const { perception, tts, notifies, frames } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: fakeTriageJudge({ verbose: 0.9 }),
      readReply: async () => "回复正文",
    });
    perception.noteDelivered("sess-f", "问题 F");
    perception.onDomainEvent(turnEvent("sess-f"));
    await broadcast_drain(perception);
    expect(notifies).toHaveLength(1); // 事件不静默：机械短讯照发
    expect(notifies[0]!.body).toBe("那个对话回你了"); // 保底白话
    expect(frames[frames.length - 1]!.text).toBe("那个对话回你了"); // 语音保底同句
    expect(tts.calls[0]!.text).toBe("那个对话回你了"); // 广播合成面同句
  });

  test("单段文本（无空行）→ detail 缺席回退 present；单换行多行 → 首行 present 其余 detail", async () => {
    const diagnose = fakeDiagnose({ text: "只有一段的口语句。" });
    const { perception, frames } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose,
      triageJudge: fakeTriageJudge({ verbose: 0.9 }),
      readReply: async () => "回复正文",
    });
    perception.noteDelivered("sess-g", "问题 G");
    perception.onDomainEvent(turnEvent("sess-g"));
    await broadcast_drain(perception);
    expect(frames[frames.length - 1]!.text).toBe("只有一段的口语句。"); // 单段 = present

    const diagnose2 = fakeDiagnose({ text: "首行口语句。\n第二行要点。\n第三行要点。" });
    const { perception: p2, frames: f2 } = makeStack({
      stewardSubscribed: true,
      recentAsk: true,
      diagnose: diagnose2,
      triageJudge: fakeTriageJudge({ verbose: 0.9 }),
      readReply: async () => "回复正文",
    });
    p2.noteDelivered("sess-h", "问题 H");
    p2.onDomainEvent(turnEvent("sess-h"));
    await broadcast_drain(p2);
    expect(f2[f2.length - 1]!.text).toBe("第二行要点。\n第三行要点。"); // 首行=present，余行=detail
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
