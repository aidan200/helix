/**
 * BroadcastService 单测（2026-10-08「白话播报重构」后形态）：纯队列面——
 * agent 级事件播报/内容源回调链/极简终态通知整体退役（用户裁决：任务终态
 * 机械短讯归感知服务；agent 状态零播报），唯一入口 enqueueDiagnosed。
 *
 * 断言面：
 * 1. 直供播报：enqueueDiagnosed 入队即播（闸门单点——零订阅零入队零合成）；
 * 2. 队列：串行合成串行发（顺序 + seq 单调）；上限 5 溢出丢最旧、下一条
 *    合并「另有 N 条已跳过」提示；
 * 3. 合成失败跳过该条不中断后续（warn 观测）；
 * 4. 长文本（详略轨 detail ≤600）原样播——本层不二次截断（截断单源归
 *    感知服务 clampPresent/clampBody）。
 */
import { describe, expect, test } from "bun:test";
import type { TtsPort, TtsRequest, TtsResult } from "../../src/application/ports/outbound/TtsPort";
import { BroadcastService, QUEUE_LIMIT } from "../../src/application/voice/BroadcastService";
import type { VoiceBroadcastPayload } from "@helix/protocol";

function fakeTts(delayMs = 0): TtsPort & { calls: TtsRequest[]; fail: boolean } {
  const calls: TtsRequest[] = [];
  return {
    providerId: "dashscope",
    calls,
    fail: false,
    async synthesize(req: TtsRequest): Promise<TtsResult> {
      calls.push(req);
      if ((this as { fail: boolean }).fail) throw new Error("合成失败模拟");
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      // 固定 ASCII 载荷（btoa 对多字节中文抛 InvalidCharacterError——不依赖文本内容）
      return { audio: `data:audio/wav;base64,${btoa(String(calls.length))}` };
    },
  } as TtsPort & { calls: TtsRequest[]; fail: boolean };
}

function makeService(opts?: { subscribers?: number; voice?: string; ttsDelayMs?: number }) {
  const tts = fakeTts(opts?.ttsDelayMs ?? 0);
  const frames: VoiceBroadcastPayload[] = [];
  const warns: string[] = [];
  const svc = new BroadcastService({
    tts,
    gate: {
      hasVoiceSubscribers: () => opts?.subscribers !== 0,
      voicePreference: () => (opts?.subscribers ?? 1) > 0 ? opts?.voice : undefined,
    },
    emit: (payload) => frames.push(payload),
    logger: { warn: (m) => warns.push(m) },
  });
  return { svc, tts, frames, warns };
}

describe("enqueueDiagnosed：直供播报（唯一入口）", () => {
  test("直供文本入队即播（kind/agentId/text/audio/seq + 音色偏好透传）", async () => {
    const { svc, tts, frames } = makeService({ voice: "Cherry" });
    svc.enqueueDiagnosed({ kind: "task.done", agentId: "task:job-1", text: "任务完成了。" });
    await svc.drain();
    expect(tts.calls.length).toBe(1);
    expect(tts.calls[0]!.text).toBe("任务完成了。");
    expect(tts.calls[0]!.voice).toBe("Cherry");
    expect(frames.length).toBe(1);
    expect(frames[0]).toMatchObject({
      kind: "task.done",
      agentId: "task:job-1",
      text: "任务完成了。",
      provider: "dashscope",
      seq: 1,
    });
    expect(frames[0]!.audio.startsWith("data:audio/wav;base64,")).toBe(true);
  });

  test("闸门关闭（零订阅连接）→ 零入队零合成零发", async () => {
    const { svc, tts, frames } = makeService({ subscribers: 0 });
    svc.enqueueDiagnosed({ kind: "task.done", agentId: "task:job-1", text: "任务完成了。" });
    await svc.drain();
    expect(tts.calls.length).toBe(0);
    expect(frames.length).toBe(0);
  });

  test("串行顺序：多条直供按到达序合成与广播（seq 单调）", async () => {
    const { svc, frames } = makeService();
    svc.enqueueDiagnosed({ kind: "task.done", agentId: "task:a", text: "一。" });
    svc.enqueueDiagnosed({ kind: "agent.completed", agentId: "sess-b", text: "二。" });
    svc.enqueueDiagnosed({ kind: "task.done", agentId: "task:c", text: "三。" });
    await svc.drain();
    expect(frames.map((f) => f.agentId)).toEqual(["task:a", "sess-b", "task:c"]);
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  test(`队列上限 ${QUEUE_LIMIT}：溢出丢最旧，下一条合并「另有 N 条已跳过」提示`, async () => {
    const { svc, frames } = makeService({ ttsDelayMs: 5 }); // 延迟合成使队列确定积压
    for (let i = 1; i <= 8; i++) {
      svc.enqueueDiagnosed({ kind: "task.done", agentId: `task:job-${i}`, text: `第${i}条。` });
    }
    await svc.drain();
    // 首条被泵同步取走在途（帧 1 = job-1），余 7 条积压 → 上限 5 丢最旧 2 条（job-2/3）
    expect(frames.length).toBe(6);
    expect(frames[0]!.agentId).toBe("task:job-1");
    expect(frames[1]!.agentId).toBe("task:job-4");
    expect(frames[1]!.text).toContain("另有 2 条较早播报已跳过");
    expect(frames[1]!.droppedCount).toBe(2);
    expect(frames[1]!.text).toContain("第4条。");
  });

  test("合成失败：跳过该条不中断后续（warn 观测），seq 连续", async () => {
    const { svc, tts, frames, warns } = makeService();
    (tts as { fail: boolean }).fail = true;
    svc.enqueueDiagnosed({ kind: "task.done", agentId: "task:x", text: "失败条。" });
    await svc.drain();
    (tts as { fail: boolean }).fail = false;
    svc.enqueueDiagnosed({ kind: "task.done", agentId: "task:y", text: "成功条。" });
    await svc.drain();
    expect(frames.length).toBe(1);
    expect(frames[0]!.agentId).toBe("task:y");
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("task:x");
  });

  test("详略轨长文本（600 字级 detail）原样播——本层不二次截断（截断单源归感知服务）", async () => {
    const long = "详".repeat(600);
    const { svc, tts } = makeService();
    svc.enqueueDiagnosed({ kind: "agent.completed", agentId: "sess-r", text: long });
    await svc.drain();
    expect(tts.calls[0]!.text).toBe(long); // 600 字全量上嘴
  });
});
