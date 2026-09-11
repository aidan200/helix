import { describe, expect, test } from "bun:test";

import {
  displayStateOf,
  traceDisplayOf,
  type DisplayState,
} from "../../src/domain/agent/ObservabilityState";
import type { InstanceKind, InstanceState } from "../../src/domain/agent/AgentInstance";

/**
 * U2 观测态编译单测：displayStateOf（实时面）+ traceDisplayOf（事件回放面）
 * 全分支表驱动——main 编译会话运行态（「恒 running」修正的核心断言：
 * main 空闲 → idle，不再显示运行中），subagent 编译窗口/事件态。
 */

describe("displayStateOf（实时面：agent_status）", () => {
  test("main：会话运行态编译（恒 running 修正核心）", () => {
    // 表驱动：sessionRun → 期望 displayState
    const table: readonly [SessionRunLike, DisplayState][] = [
      ["idle", "idle"],
      ["streaming", "active"],
      ["subagent_running", "active"],
    ];
    for (const [run, want] of table) {
      expect(displayStateOf({ kind: "main", window: "running", sessionRun: run })).toBe(want);
    }
  });

  test("main：sessionRun 缺省（无读口/冷会话）→ idle", () => {
    expect(displayStateOf({ kind: "main", window: "running" })).toBe("idle");
  });

  test("subagent：窗口态直译全分支", () => {
    const table: readonly [InstanceState, DisplayState][] = [
      ["queued", "queued"],
      ["running", "active"],
      ["parked", "parked"],
      ["done", "done"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
    ];
    for (const [window, want] of table) {
      expect(displayStateOf({ kind: "subagent", window })).toBe(want);
    }
  });

  test("kind × window 笛卡尔不抛（window 对 main 不参与编译）", () => {
    const kinds: readonly InstanceKind[] = ["main", "subagent"];
    const windows: readonly InstanceState[] = ["queued", "running", "parked", "done", "failed", "cancelled"];
    for (const kind of kinds) {
      for (const window of windows) {
        expect(typeof displayStateOf({ kind, window })).toBe("string");
      }
    }
  });
});

describe("traceDisplayOf（事件回放面：trace 面板）", () => {
  test("main：sessionRun 编译同实时面（事件行无五态——注入补偿）", () => {
    expect(traceDisplayOf({ kind: "main", status: "running", sessionRun: "idle" })).toBe("idle");
    expect(traceDisplayOf({ kind: "main", status: "running", sessionRun: "streaming" })).toBe("active");
    expect(traceDisplayOf({ kind: "main", status: "running", sessionRun: "subagent_running" })).toBe("active");
  });

  test("main：sessionRun 缺省 → idle（冷会话/历史面板兜底）", () => {
    expect(traceDisplayOf({ kind: "main", status: "running" })).toBe("idle");
  });

  test("subagent：事件态直译全分支", () => {
    const table: readonly [TraceStatusLike, DisplayState][] = [
      ["running", "active"],
      ["completed", "done"],
      ["failed", "failed"],
      ["killed", "cancelled"],
    ];
    for (const [status, want] of table) {
      expect(traceDisplayOf({ kind: "subagent", status })).toBe(want);
    }
  });
});

/** 局部词汇别名（测试可读性）。 */
type SessionRunLike = "idle" | "streaming" | "subagent_running";
type TraceStatusLike = "running" | "completed" | "failed" | "killed";
