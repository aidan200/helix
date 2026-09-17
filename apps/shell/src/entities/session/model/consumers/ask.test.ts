import { describe, expect, test } from "vitest";
import { applyAskEvent } from "./ask";
import { createInitialSessionState } from "../state";
import type { EventEnvelope } from "@helix/protocol";

function frameOf(type: string, payload: Record<string, unknown>): EventEnvelope {
  return { v: 1, sessionId: "s1", type, payload } as unknown as EventEnvelope;
}

describe("ask 消费者（越权申请问答卡）", () => {
  test("ask.started → pendingAsk 置位（五字段整体落切片）", () => {
    const s = createInitialSessionState();
    const next = applyAskEvent(
      s,
      frameOf("ask.started", {
        askId: "ask-1",
        command: "npm i -g x",
        reason: "需要全局安装",
        instanceId: "agent-1",
        expiresAt: 1_700_000_060_000,
      }),
    );
    expect(next.pendingAsk).toEqual({
      askId: "ask-1",
      command: "npm i -g x",
      reason: "需要全局安装",
      instanceId: "agent-1",
      expiresAt: 1_700_000_060_000,
    });
  });

  test("ask.started 单 pending 不变式：新申请整体替换旧申请", () => {
    const s = {
      ...createInitialSessionState(),
      pendingAsk: { askId: "ask-old", command: "a", reason: "r", instanceId: "i", expiresAt: 1 },
    };
    const next = applyAskEvent(
      s,
      frameOf("ask.started", { askId: "ask-new", command: "b", reason: "r2", instanceId: "i2", expiresAt: 2 }),
    );
    expect(next.pendingAsk?.askId).toBe("ask-new");
  });

  test("ask.resolved → pendingAsk 清除（三终态同清）", () => {
    const s = {
      ...createInitialSessionState(),
      pendingAsk: { askId: "ask-1", command: "a", reason: "r", instanceId: "i", expiresAt: 1 },
    };
    for (const outcome of ["approved", "denied", "timeout"]) {
      const next = applyAskEvent(s, frameOf("ask.resolved", { askId: "ask-1", outcome }));
      expect(next.pendingAsk).toBeNull();
    }
  });

  test("无 pending 时 resolved 幂等（null → null 不炸）", () => {
    const s = createInitialSessionState();
    const next = applyAskEvent(s, frameOf("ask.resolved", { askId: "ghost", outcome: "denied" }));
    expect(next.pendingAsk).toBeNull();
  });

  test("无关 type 原样透传", () => {
    const s = createInitialSessionState();
    expect(applyAskEvent(s, frameOf("chat.turn.started", {}))).toBe(s);
  });
});
