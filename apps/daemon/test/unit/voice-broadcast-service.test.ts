/**
 * BroadcastService 单测（语音播报批 V2；TDD 红绿证据链——设计 §5.3 ①②层；
 * 任务总结子功能批：②层模板直出 → 极简终态通知；管家感知批 M0.5：③层
 * 独立摘要调用退役 → 内容源回调（分诊呈现轨）+ 完成类聚合任务级）。
 *
 * 断言面：
 * 1. 规则粗筛（①层）：播报集合 = agent.completed/failed/killed 三终态 +
 *    完成类聚合（task:* 会话的 agent.completed 不在 agent 级播报）；
 *    开始类（spawned/queued/started/stalled/parked/resumed）与无关事件
 *    （chat 族）零合成零发（噪声控制，设计 §7-1）；
 * 2. 极简终态通知（②层）：三形态只报终态本身——不念 agentId（UUID 逐字
 *    播报无意义）/closure 摘要（技术黑话截断听不懂）/error 原文（英文报错
 *    是噪声）；内容生产归分诊器（感知服务），极简是回退兜底；
 * 3. 播放队列：串行合成串行发（顺序保证）；上限 5 条溢出丢最旧、下一条
 *    播报 text 合并「另有 N 条较早播报已跳过」提示；
 * 4. 闸门：无订阅连接（voice.subscribe 零登记）→ 事件直接丢弃（零花费——
 *    开关默认 off 的落地面，内容源零调用）；合成失败 → 跳过该条不中断
 *    后续（warn 观测）；
 * 5. 内容源（管家感知批归一面）：text = 呈现轨直供；unavailable = 回退
 *    极简；silent = 静默丢弃占位；超时 = 回退极简；产物超长截断防御；
 * 6. enqueueDiagnosed：任务级/分诊直供播报（入队即 ready；闸门单点）。
 */
import { describe, expect, test } from "bun:test";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { TtsPort, TtsRequest, TtsResult } from "../../src/application/ports/outbound/TtsPort";
import {
  BroadcastService,
  buildBroadcastText,
  isAggregatedToTaskLevel,
  isBroadcastEligible,
  SUMMARY_MAX_CHARS,
  CONTENT_TIMEOUT_MS,
  type BroadcastContentResult,
} from "../../src/application/voice/BroadcastService";
import type { VoiceBroadcastPayload } from "@helix/protocol";

function agentEvent(type: string, payload: unknown, sessionId = "sess-1"): DomainEvent {
  return {
    type: type as DomainEvent["type"],
    sessionId,
    instanceId: "agent-2",
    payload,
    occurredAt: "2026-09-19T06:00:00.000Z",
  };
}

const closure = (summary: string) => ({ status: "done" as const, summary, reportPath: null, findings: null, taskId: null });

function fakeTts(): TtsPort & { calls: TtsRequest[]; fail: boolean } {
  const calls: TtsRequest[] = [];
  return {
    providerId: "dashscope",
    calls,
    fail: false,
    async synthesize(req: TtsRequest): Promise<TtsResult> {
      calls.push(req);
      if ((this as { fail: boolean }).fail) throw new Error("合成失败模拟");
      // 固定 ASCII 载荷（btoa 对多字节中文抛 InvalidCharacterError——不依赖文本内容）
      return { audio: `data:audio/wav;base64,${btoa(String(calls.length))}` };
    },
  } as TtsPort & { calls: TtsRequest[]; fail: boolean };
}

/** fake 内容源（管家感知批归一面）：记录事件；可控行为（text/silent/
 *  unavailable/抛错/延迟）。 */
function fakeContent(
  behavior?: {
    outcome?: BroadcastContentResult;
    error?: Error;
    delayMs?: number;
  },
): ((event: DomainEvent) => Promise<BroadcastContentResult>) & { events: DomainEvent[] } {
  const events: DomainEvent[] = [];
  return Object.assign(
    async (event: DomainEvent): Promise<BroadcastContentResult> => {
      events.push(event);
      if ((behavior?.delayMs ?? 0) > 0) {
        await new Promise((r) => setTimeout(r, behavior!.delayMs));
      }
      if (behavior?.error !== undefined) throw behavior.error;
      return behavior?.outcome ?? { kind: "unavailable" };
    },
    { events },
  );
}

function makeService(
  opts?: {
    subscribers?: number;
    voice?: string;
    content?: (event: DomainEvent) => Promise<BroadcastContentResult>;
    contentTimeoutMs?: number;
  },
) {
  const tts = fakeTts();
  const frames: VoiceBroadcastPayload[] = [];
  const warns: string[] = [];
  const gate = {
    hasVoiceSubscribers: () => opts?.subscribers !== 0,
    voicePreference: () => (opts?.subscribers ?? 1) > 0 ? opts?.voice : undefined,
  };
  const svc = new BroadcastService({
    tts,
    gate,
    emit: (payload) => frames.push(payload),
    logger: { warn: (m) => warns.push(m) },
    ...(opts?.content !== undefined ? { content: opts.content } : {}),
    ...(opts?.contentTimeoutMs !== undefined ? { contentTimeoutMs: opts.contentTimeoutMs } : {}),
  });
  return { svc, tts, frames, warns };
}

describe("规则粗筛（①层）：isBroadcastEligible + isAggregatedToTaskLevel + buildBroadcastText", () => {
  test("V2 播报集合恰为三终态；开始/挂起族全不播", () => {
    expect(isBroadcastEligible("agent.completed")).toBe(true);
    expect(isBroadcastEligible("agent.failed")).toBe(true);
    expect(isBroadcastEligible("agent.killed")).toBe(true);
    for (const t of ["agent.spawned", "agent.queued", "agent.started", "agent.stalled", "agent.parked", "agent.resumed", "chat.turn.completed", "tool.call.result"]) {
      expect(isBroadcastEligible(t as never)).toBe(false);
    }
  });

  test("完成类聚合：task:* 会话的 agent.completed 判聚合（非 task 会话不聚）", () => {
    expect(isAggregatedToTaskLevel(agentEvent("agent.completed", { agentId: "a" }, "task:job-1"))).toBe(true);
    expect(isAggregatedToTaskLevel(agentEvent("agent.completed", { agentId: "a" }, "sess-1"))).toBe(false);
    expect(isAggregatedToTaskLevel(agentEvent("agent.failed", { agentId: "a", error: "x" }, "task:job-1"))).toBe(false);
    expect(isAggregatedToTaskLevel(agentEvent("agent.killed", { agentId: "a" }, "task:job-1"))).toBe(false);
  });

  test("极简三形态：只报终态本身（完成/失败/终止）", () => {
    expect(buildBroadcastText(agentEvent("agent.completed", { agentId: "agent-15f694134f114bb49d15abe00a93c1c8", closure: closure("修复登录超时") })))
      .toBe("后台任务已完成");
    expect(buildBroadcastText(agentEvent("agent.failed", { agentId: "agent-3", error: "The socket connection was closed unexpectedly", closure: closure("xx") })))
      .toBe("后台任务失败");
    expect(buildBroadcastText(agentEvent("agent.killed", { agentId: "agent-4", closure: closure("用户手动停止") })))
      .toBe("后台任务已终止");
  });

  test("极简通知不携带 payload 内容：agentId/closure/error 均不出现在文本（UUID 与黑话截断判负价值退役）", () => {
    for (const [type, payload] of [
      ["agent.completed", { agentId: "agent-abc123", closure: closure("B2 光球层交付 StewardVoiceLayer 相位机/字幕条") }],
      ["agent.failed", { agentId: "agent-abc123", error: "ECONNRESET: socket hang up", closure: closure("") }],
    ] as const) {
      const text = buildBroadcastText(agentEvent(type, payload))!;
      expect(text).not.toContain("agent-abc123");
      expect(text).not.toContain("光球");
      expect(text).not.toContain("ECONNRESET");
    }
  });
});

describe("BroadcastService：闸门/极简通知/队列/串行（②层）", () => {
  test("闸门关闭（零订阅连接）→ 事件直接丢弃，零合成零发零内容调用", async () => {
    const content = fakeContent();
    const { svc, tts, frames } = makeService({ subscribers: 0, content });
    svc.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-2", closure: closure("ok") }));
    await svc.drain();
    expect(tts.calls.length).toBe(0);
    expect(frames.length).toBe(0);
    expect(content.events.length).toBe(0); // 内容源零调用（money gate 覆盖 LLM 层）
  });

  test("全链：完成事件（非 task 会话）→ 极简通知合成 → 广播帧（kind/agentId/text/audio/seq）", async () => {
    const { svc, tts, frames } = makeService({ voice: "Cherry" });
    svc.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-2", closure: closure("修复登录超时") }));
    await svc.drain();
    expect(tts.calls.length).toBe(1);
    expect(tts.calls[0]!.text).toBe("后台任务已完成");
    expect(tts.calls[0]!.voice).toBe("Cherry");
    expect(frames.length).toBe(1);
    expect(frames[0]).toMatchObject({
      kind: "agent.completed",
      agentId: "agent-2",
      text: "后台任务已完成",
      provider: "dashscope",
      seq: 1,
    });
    expect(frames[0]!.audio.startsWith("data:audio/wav;base64,")).toBe(true);
  });

  test("完成类聚合：task 会话的 agent.completed 零播报（任务级锚直供路径归 StewardPerceptionService）", async () => {
    const content = fakeContent();
    const { svc, tts, frames } = makeService({ content });
    svc.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-b1", closure: closure("批次完成") }, "task:job-1"));
    await svc.drain();
    expect(tts.calls.length).toBe(0);
    expect(frames.length).toBe(0);
    expect(content.events.length).toBe(0); // 聚合事件不进内容源
  });

  test("不播事件（spawned/stalled 等）零合成", async () => {
    const { svc, tts, frames } = makeService();
    svc.onDomainEvent(agentEvent("agent.spawned", { agentId: "agent-2", task: "t", profileKind: "subagent-worker" }));
    svc.onDomainEvent(agentEvent("agent.stalled", { agentId: "agent-2", idleMs: 60000 }));
    await svc.drain();
    expect(tts.calls.length).toBe(0);
    expect(frames.length).toBe(0);
  });

  test("串行顺序：三条事件按到达序合成与广播（seq 单调）", async () => {
    const { svc, frames } = makeService();
    svc.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-a", closure: closure("一") }));
    svc.onDomainEvent(agentEvent("agent.failed", { agentId: "agent-b", error: "二", closure: closure("") }));
    svc.onDomainEvent(agentEvent("agent.killed", { agentId: "agent-c", closure: closure("三") }));
    await svc.drain();
    expect(frames.map((f) => f.agentId)).toEqual(["agent-a", "agent-b", "agent-c"]);
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  test("队列上限 5：溢出丢最旧，下一条播报合并「另有 N 条已跳过」提示", async () => {
    const { svc, frames } = makeService();
    for (let i = 1; i <= 8; i++) {
      svc.onDomainEvent(agentEvent("agent.failed", { agentId: `agent-${i}`, error: "x", closure: closure(`任务${i}`) }));
    }
    await svc.drain();
    // 8 条入队、上限 5 → 丢 3 条最旧（agent-1/2/3）
    expect(frames.length).toBe(5);
    expect(frames[0]!.agentId).toBe("agent-4");
    expect(frames[0]!.text).toContain("另有 3 条较早播报已跳过");
    expect(frames[0]!.droppedCount).toBe(3);
    expect(frames[0]!.text).toContain("后台任务失败");
  });

  test("合成失败：跳过该条不中断后续（warn 观测），seq 连续", async () => {
    const { svc, tts, frames, warns } = makeService();
    (tts as { fail: boolean }).fail = true;
    svc.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-x", closure: closure("失败条") }));
    await svc.drain();
    (tts as { fail: boolean }).fail = false;
    svc.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-y", closure: closure("成功条") }));
    await svc.drain();
    expect(frames.length).toBe(1);
    expect(frames[0]!.agentId).toBe("agent-y");
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("agent-x");
  });
});

describe("内容源（管家感知批 M0.5 归一面）：呈现轨直供/回退/静默", () => {
  test("text 判别：分诊呈现轨替代极简通知进队列合成广播", async () => {
    const content = fakeContent({ outcome: { kind: "text", text: "任务搞定了，登录超时的问题已经修好。" } });
    const { svc, tts, frames } = makeService({ content });
    svc.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-2", closure: closure("修复登录超时") }));
    await svc.drain();
    expect(content.events.length).toBe(1);
    expect(tts.calls[0]!.text).toBe("任务搞定了，登录超时的问题已经修好。");
    expect(frames[0]!.text).toBe("任务搞定了，登录超时的问题已经修好。");
    expect(frames[0]!.kind).toBe("agent.completed");
  });

  test("unavailable 判别（未启用/gate 断点）→ 回退②层极简通知", async () => {
    const content = fakeContent({ outcome: { kind: "unavailable" } });
    const { svc, tts, frames } = makeService({ content });
    svc.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-2", closure: closure("修复登录超时") }));
    await svc.drain();
    expect(content.events.length).toBe(1);
    expect(tts.calls[0]!.text).toBe("后台任务已完成");
    expect(frames[0]!.text).toBe("后台任务已完成");
  });

  test("silent 判别（分诊裁决静默）→ 丢弃占位不播（不播极简）", async () => {
    const content = fakeContent({ outcome: { kind: "silent" } });
    const { svc, tts, frames } = makeService({ content });
    svc.onDomainEvent(agentEvent("agent.failed", { agentId: "agent-3", error: "x", closure: closure("") }));
    await svc.drain();
    expect(tts.calls.length).toBe(0);
    expect(frames.length).toBe(0);
  });

  test("内容源超时（timeoutMs 注入面）→ 回退②层极简通知 + warn 含超时", async () => {
    const content = fakeContent({ outcome: { kind: "text", text: "迟到的呈现轨" }, delayMs: 200 });
    const { svc, tts, frames, warns } = makeService({ content, contentTimeoutMs: 20 });
    svc.onDomainEvent(agentEvent("agent.killed", { agentId: "agent-4", closure: closure("用户手动停止") }));
    await svc.drain();
    expect(tts.calls[0]!.text).toBe("后台任务已终止");
    expect(frames[0]!.text).toBe("后台任务已终止");
    expect(warns.some((w) => w.includes("超时"))).toBe(true);
  });

  test("内容源抛错 → 回退②层极简通知 + warn 观测", async () => {
    const content = fakeContent({ error: new Error("模型调用失败模拟") });
    const { svc, tts, frames, warns } = makeService({ content });
    svc.onDomainEvent(agentEvent("agent.failed", { agentId: "agent-3", error: "网络超时", closure: closure("") }));
    await svc.drain();
    expect(tts.calls[0]!.text).toBe("后台任务失败");
    expect(frames[0]!.text).toBe("后台任务失败");
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("回退");
  });

  test("呈现轨产物超长截断（分诊 60 字防御外的第二道兜底）：> 80 字符加省略号", async () => {
    const content = fakeContent({ outcome: { kind: "text", text: "啰".repeat(200) } });
    const { svc, tts } = makeService({ content });
    svc.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-2", closure: closure("ok") }));
    await svc.drain();
    expect(tts.calls[0]!.text.length).toBe(SUMMARY_MAX_CHARS + 1);
    expect(tts.calls[0]!.text.endsWith("…")).toBe(true);
  });

  test("内容耗时不均不乱序：后到快内容不得先播（串行链按事件到达序）", async () => {
    let calls = 0;
    const content = Object.assign(
      async (): Promise<BroadcastContentResult> => {
        calls += 1;
        await new Promise((r) => setTimeout(r, calls === 1 ? 40 : 1)); // 第一条慢、第二条快
        return { kind: "text", text: `第${calls}条呈现轨` };
      },
      { events: [] as DomainEvent[] },
    );
    const { svc, frames } = makeService({ content });
    svc.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-a", closure: closure("一") }));
    svc.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-b", closure: closure("二") }));
    await svc.drain();
    expect(frames.map((f) => f.agentId)).toEqual(["agent-a", "agent-b"]);
    expect(frames.map((f) => f.text)).toEqual(["第1条呈现轨", "第2条呈现轨"]);
    expect(frames.map((f) => f.seq)).toEqual([1, 2]);
  });

  test("缺省超时 8s（deps 注入面缺省值）", () => {
    expect(CONTENT_TIMEOUT_MS).toBe(8000);
  });
});

describe("enqueueDiagnosed：任务级/分诊直供播报（管家感知批）", () => {
  test("直供文本入队即播（kind=task.done + 闸门单点）", async () => {
    const { svc, tts, frames } = makeService({ voice: "Cherry" });
    svc.enqueueDiagnosed({ kind: "task.done", agentId: "task:job-1", text: "任务全部批次收口完成，可以看报告了。" });
    await svc.drain();
    expect(tts.calls.length).toBe(1);
    expect(tts.calls[0]!.text).toBe("任务全部批次收口完成，可以看报告了。");
    expect(frames[0]).toMatchObject({ kind: "task.done", agentId: "task:job-1", seq: 1 });
  });

  test("闸门关闭（零订阅）→ 直供零入队零合成", async () => {
    const { svc, tts, frames } = makeService({ subscribers: 0 });
    svc.enqueueDiagnosed({ kind: "task.done", agentId: "task:job-1", text: "后台任务已完成" });
    await svc.drain();
    expect(tts.calls.length).toBe(0);
    expect(frames.length).toBe(0);
  });
});
