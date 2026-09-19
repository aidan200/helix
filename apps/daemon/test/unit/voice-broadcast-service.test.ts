/**
 * BroadcastService 单测（语音播报批 V2；TDD 红绿证据链——设计 §5.3 ①②层）。
 *
 * 断言面：
 * 1. 规则粗筛（①层）：V2 播报集合 = agent.completed/failed/killed 三终态；
 *    开始类（spawned/queued/started/stalled/parked/resumed）与无关事件
 *    （chat 族）零合成零发（噪声控制，设计 §7-1）；
 * 2. 模板直出（②层）：中文模板三形态（完成含 closure 摘要 / 失败含 error /
 *    被杀含摘要）；closure 摘要截断至 ~80 字符（超长加省略号）；
 * 3. 播放队列：串行合成串行发（顺序保证）；上限 5 条溢出丢最旧、下一条
 *    播报 text 合并「另有 N 条较早播报已跳过」提示；
 * 4. 闸门：无订阅连接（voice.subscribe 零登记）→ 事件直接丢弃（零花费——
 *    开关默认 off 的落地面）；合成失败 → 跳过该条不中断后续（warn 观测）。
 */
import { describe, expect, test } from "bun:test";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { TtsPort, TtsRequest, TtsResult } from "../../src/application/ports/outbound/TtsPort";
import {
  BroadcastService,
  buildBroadcastText,
  isBroadcastEligible,
  SUMMARY_MAX_CHARS,
} from "../../src/application/voice/BroadcastService";
import type { VoiceBroadcastPayload } from "@helix/protocol";

function agentEvent(type: string, payload: unknown): DomainEvent {
  return {
    type: type as DomainEvent["type"],
    sessionId: "sess-1",
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

function makeService(opts?: { subscribers?: number; voice?: string }) {
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
    logger: { warn: (m: string) => warns.push(m) },
  });
  return { svc, tts, frames, warns };
}

describe("规则粗筛（①层）：isBroadcastEligible + buildBroadcastText", () => {
  test("V2 播报集合恰为三终态；开始/挂起族全不播", () => {
    expect(isBroadcastEligible("agent.completed")).toBe(true);
    expect(isBroadcastEligible("agent.failed")).toBe(true);
    expect(isBroadcastEligible("agent.killed")).toBe(true);
    for (const t of ["agent.spawned", "agent.queued", "agent.started", "agent.stalled", "agent.parked", "agent.resumed", "chat.turn.completed", "tool.call.result"]) {
      expect(isBroadcastEligible(t as never)).toBe(false);
    }
  });

  test("模板三形态：完成（closure 摘要）/ 失败（error）/ 被杀（摘要）", () => {
    expect(buildBroadcastText(agentEvent("agent.completed", { agentId: "agent-2", closure: closure("修复登录超时") })))
      .toBe("agent-2 已完成：修复登录超时");
    expect(buildBroadcastText(agentEvent("agent.failed", { agentId: "agent-3", error: "网络超时", closure: closure("xx") })))
      .toBe("agent-3 失败：网络超时");
    expect(buildBroadcastText(agentEvent("agent.killed", { agentId: "agent-4", closure: closure("用户手动停止") })))
      .toBe("agent-4 已终止：用户手动停止");
  });

  test("closure 摘要截断至 ~80 字符（超长加省略号）", () => {
    const long = "长".repeat(200);
    const text = buildBroadcastText(agentEvent("agent.completed", { agentId: "agent-2", closure: closure(long) }))!;
    // 前缀 + 截断摘要 + "…" —— 摘要段 ≤ 81
    const summaryPart = text.slice("agent-2 已完成：".length);
    expect(summaryPart.length).toBe(SUMMARY_MAX_CHARS + 1);
    expect(summaryPart.endsWith("…")).toBe(true);
  });
});

describe("BroadcastService：闸门/模板/队列/串行（②层）", () => {
  test("闸门关闭（零订阅连接）→ 事件直接丢弃，零合成零发", async () => {
    const { svc, tts, frames } = makeService({ subscribers: 0 });
    svc.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-2", closure: closure("ok") }));
    await svc.drain();
    expect(tts.calls.length).toBe(0);
    expect(frames.length).toBe(0);
  });

  test("全链：完成事件 → 模板合成 → 广播帧（kind/agentId/text/audio/seq）", async () => {
    const { svc, tts, frames } = makeService({ voice: "Cherry" });
    svc.onDomainEvent(agentEvent("agent.completed", { agentId: "agent-2", closure: closure("修复登录超时") }));
    await svc.drain();
    expect(tts.calls.length).toBe(1);
    expect(tts.calls[0]!.text).toBe("agent-2 已完成：修复登录超时");
    expect(tts.calls[0]!.voice).toBe("Cherry");
    expect(frames.length).toBe(1);
    expect(frames[0]).toMatchObject({
      kind: "agent.completed",
      agentId: "agent-2",
      text: "agent-2 已完成：修复登录超时",
      provider: "dashscope",
      seq: 1,
    });
    expect(frames[0]!.audio.startsWith("data:audio/wav;base64,")).toBe(true);
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
      svc.onDomainEvent(agentEvent("agent.completed", { agentId: `agent-${i}`, closure: closure(`任务${i}`) }));
    }
    await svc.drain();
    // 8 条入队、上限 5 → 丢 3 条最旧（agent-1/2/3）
    expect(frames.length).toBe(5);
    expect(frames[0]!.agentId).toBe("agent-4");
    expect(frames[0]!.text).toContain("另有 3 条较早播报已跳过");
    expect(frames[0]!.droppedCount).toBe(3);
    expect(frames[0]!.text).toContain("agent-4 已完成：任务4");
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
