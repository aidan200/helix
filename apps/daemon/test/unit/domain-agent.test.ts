import { describe, expect, test } from "bun:test";
import { AgentLifecycle, type AgentLifecycleState } from "../../src/domain/agent/AgentLifecycle";
import { SteerQueue } from "../../src/domain/agent/SteerQueue";
import { ToolCallRecord } from "../../src/domain/tools/ToolCallRecord";

/**
 * TP-CL4-1 / TP-CL4-5（U 半）：agent 领域聚合行为——
 * ① SteerQueue enqueue/drain 顺序与 isEmpty；
 * ② AgentLifecycle 全状态矩阵（非法迁移抛领域错误）；
 * ③ ToolCallRecord pending→running→completed/failed 迁移 + 结果附加。
 */

describe("SteerQueue（TP-CL4-1 ①）", () => {
  test("enqueue 后非空，drain 按入队序返回并清空", () => {
    const q = new SteerQueue();
    expect(q.isEmpty()).toBe(true);

    q.enqueue({ entryId: "e1", text: "第一条" });
    q.enqueue({ entryId: "e2", text: "第二条" });
    expect(q.isEmpty()).toBe(false);
    expect(q.size()).toBe(2);

    const drained = q.drain();
    expect(drained.map((s) => s.text)).toEqual(["第一条", "第二条"]);
    expect(q.isEmpty()).toBe(true);
    expect(q.drain()).toEqual([]);
  });

  test("dequeue 取最旧一条且其余保留（one-at-a-time 观测点）", () => {
    const q = new SteerQueue();
    q.enqueue({ entryId: "e1", text: "A" });
    q.enqueue({ entryId: "e2", text: "B" });

    const first = q.dequeue();
    expect(first?.text).toBe("A");
    expect(q.size()).toBe(1);
    expect(q.dequeue()?.text).toBe("B");
    expect(q.dequeue()).toBeUndefined();
  });
});

describe("AgentLifecycle 全状态矩阵（TP-CL4-1 ②）", () => {
  /** 合法迁移矩阵（architecture.md §3.3 / brief：idle/running/steering/aborting/stopped）。 */
  const legal: Record<AgentLifecycleState, AgentLifecycleState[]> = {
    idle: ["running", "stopped"],
    running: ["idle", "steering", "aborting", "stopped"],
    steering: ["running", "idle", "aborting", "stopped"],
    aborting: ["idle", "stopped"],
    stopped: [],
  };
  const allStates = Object.keys(legal) as AgentLifecycleState[];

  test("初始状态为 idle", () => {
    expect(new AgentLifecycle().current).toBe("idle");
  });

  for (const from of allStates) {
    for (const to of allStates) {
      const isLegal = legal[from]!.includes(to);
      test(`${from} → ${to} ${isLegal ? "合法" : "抛领域错误"}`, () => {
        const lc = new AgentLifecycle();
        // 用 transition 强推到 from（矩阵自身保证可达：stopped 终态除外，用暴力迁移路径）
        forceState(lc, from);
        if (isLegal) {
          expect(() => lc.transition(to)).not.toThrow();
          expect(lc.current).toBe(to);
        } else {
          expect(() => lc.transition(to)).toThrow();
          expect(lc.current).toBe(from); // 非法迁移不改状态
        }
      });
    }
  }

  test("非法迁移的错误信息含 from/to（可观测诊断）", () => {
    const lc = new AgentLifecycle();
    try {
      lc.transition("steering");
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("idle");
      expect(msg).toContain("steering");
    }
  });
});

/** 把 lifecycle 推到目标状态的辅助（测试专用，走合法路径）。 */
function forceState(lc: AgentLifecycle, target: AgentLifecycleState): void {
  const path: Record<AgentLifecycleState, AgentLifecycleState[]> = {
    idle: ["running", "idle"],
    running: ["running"],
    steering: ["running", "steering"],
    aborting: ["running", "aborting"],
    stopped: ["stopped"],
  };
  for (const s of path[target]!) {
    if (lc.current !== s) lc.transition(s);
  }
}

describe("ToolCallRecord（TP-CL4-1 ③）", () => {
  test("pending→running→completed，结果附加", () => {
    const rec = ToolCallRecord.create("tc-1", "bash", { command: "echo hi" });
    expect(rec.status).toBe("pending");

    rec.markRunning();
    expect(rec.status).toBe("running");

    rec.complete("hi");
    expect(rec.status).toBe("completed");
    expect(rec.result).toBe("hi");
    expect(rec.endedAt).toBeDefined();
  });

  test("pending→running→failed，错误附加", () => {
    const rec = ToolCallRecord.create("tc-2", "bash", {});
    rec.markRunning();
    rec.fail("exit 1");
    expect(rec.status).toBe("failed");
    expect(rec.error).toBe("exit 1");
  });

  test("非法迁移：pending→completed / completed→running 抛错", () => {
    const rec = ToolCallRecord.create("tc-3", "read", {});
    expect(() => rec.complete("x")).toThrow(); // 未 running 不可完成
    expect(() => rec.fail("x")).toThrow();

    const rec2 = ToolCallRecord.create("tc-4", "read", {});
    rec2.markRunning();
    rec2.complete("done");
    expect(() => rec2.markRunning()).toThrow(); // 终态不可再迁移
    expect(() => rec2.complete("again")).toThrow();
  });
});
