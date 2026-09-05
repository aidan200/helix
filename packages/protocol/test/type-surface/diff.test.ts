/**
 * diff 批（T3+T4 轮次 diff 协议与 UI 闭环）类型面测试：
 * diff.changed 瞬态推送帧（publishDelta 通道语义）+ diff.get 会话作用域
 * 命令与点对点回执（task 族先例：结果帧不入 EVENT_TYPES 目录）。
 *
 * 守护面：
 * - DiffChangedEvent 信封形状（channel=session、type、payload 四字段）；
 * - EVENT_TYPES / EVENT_CHANNELS 登记（通道归属 = session，sot 断言⑤联动）；
 * - DiffGetCommand 载荷（turnId?/live? 可选——additive 纪律）；
 * - DiffGetResultEvent 点对点回执窄化接口（不入目录——task 族先例口径）；
 * - DiffFileDto / DiffGetResultPayload 形状（status 四值 / agents 多值）。
 */
import { describe, expect, test } from "bun:test";
import {
  COMMAND_TYPES,
  EVENT_CHANNELS,
  EVENT_TYPES,
  type DiffChangedEvent,
  type DiffChangedPayload,
  type DiffFileDto,
  type DiffGetCommand,
  type DiffGetPayload,
  type DiffGetResultEvent,
  type DiffGetResultPayload,
  PROTOCOL_VERSION,
} from "../../src/index";

describe("diff 批：diff.changed 瞬态推送帧", () => {
  test("EVENT_TYPES 登记 diff.changed；EVENT_CHANNELS 通道归属 = session", () => {
    expect(EVENT_TYPES).toContain("diff.changed");
    expect(EVENT_CHANNELS["diff.changed"]).toBe("session");
  });

  test("DiffChangedEvent 信封形状：channel=session + payload {turnId, phase, adds, dels, fileCount}", () => {
    const payload: DiffChangedPayload = { turnId: "t-1", phase: "active", adds: 3, dels: 1, fileCount: 2 };
    const frame: DiffChangedEvent = {
      v: PROTOCOL_VERSION,
      sessionId: "sess-1",
      channel: "session",
      type: "diff.changed",
      payload,
    };
    expect(frame.type).toBe("diff.changed");
    expect(frame.channel).toBe("session");
    expect(frame.sessionId).toBe("sess-1");
    expect(frame.payload.phase).toBe("active");
    expect(frame.payload.adds).toBe(3);
    expect(frame.payload.dels).toBe(1);
    expect(frame.payload.fileCount).toBe(2);
  });

  test("phase 三值联合：active / frozen / cleared", () => {
    const phases = ["active", "frozen", "cleared"] as const;
    for (const phase of phases) {
      const p: DiffChangedPayload["phase"] = phase;
      expect(p).toBe(phase);
    }
  });
});

describe("diff 批：diff.get 命令（session 作用域——信封 sessionId 必填纪律）", () => {
  test("COMMAND_TYPES 登记 diff.get", () => {
    expect(COMMAND_TYPES).toContain("diff.get");
  });

  test("DiffGetCommand 载荷：turnId?/live? 全可选（缺省 = 最近冻结轮 / 冻结视图）", () => {
    const cmd: DiffGetCommand = {
      v: PROTOCOL_VERSION,
      type: "diff.get",
      sessionId: "sess-1",
      payload: {},
    };
    expect(cmd.type).toBe("diff.get");
    expect(cmd.sessionId).toBe("sess-1");
    const live: DiffGetPayload = { turnId: "t-9", live: true };
    expect(live.turnId).toBe("t-9");
    expect(live.live).toBe(true);
  });
});

describe("diff 批：diff.get.result 点对点回执（窄化接口，不入 EVENT_TYPES 目录）", () => {
  test("DiffGetResultEvent 不在 EVENT_TYPES（task 族结果帧先例口径）", () => {
    expect(EVENT_TYPES).not.toContain("diff.get.result");
  });

  test("DiffGetResultEvent 形状：files + summary", () => {
    const files: readonly DiffFileDto[] = [
      { path: "a.ts", status: "added", adds: 5, dels: 0, agents: ["main"] },
      { path: "b.ts", status: "external", adds: 2, dels: 0, note: "外部变更（粗估）", agents: [] },
    ];
    const payload: DiffGetResultPayload = { files, summary: { adds: 7, dels: 0 } };
    const frame: DiffGetResultEvent = {
      v: PROTOCOL_VERSION,
      sessionId: "sess-1",
      channel: "session",
      type: "diff.get.result",
      payload,
    };
    expect(frame.type).toBe("diff.get.result");
    expect(frame.payload.files).toHaveLength(2);
    expect(frame.payload.summary.adds).toBe(7);
  });

  test("DiffFileDto.status 四值联合：added/deleted/modified/external；diff 可选", () => {
    const f1: DiffFileDto = {
      path: "x.ts",
      status: "modified",
      adds: 1,
      dels: 2,
      diff: "--- x.ts\n+++ x.ts\n@@\n-a\n+b",
      agents: ["main", "agent-abc123"],
    };
    expect(f1.status).toBe("modified");
    expect(f1.agents).toHaveLength(2);
    // diff/note 可选缺省（external 条目无 patch、内容条目无 note）
    const f2: DiffFileDto = { path: "y.ts", status: "deleted", adds: 0, dels: 9, agents: [] };
    expect(f2.diff).toBeUndefined();
    expect(f2.note).toBeUndefined();
  });
});
