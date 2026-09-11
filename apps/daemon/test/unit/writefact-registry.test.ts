import { describe, expect, test } from "bun:test";

import { WriteFactRegistry } from "../../src/application/services/WriteFactRegistry";

/**
 * U0a WriteFactRegistry 单测——跨轮跨会话写事实累积面的核心语义：
 * 幂等累积、置信高覆盖低、会话聚合、置信门槛过滤、项目足迹归约
 * （worktree 归主仓 / workspace 外剔除）、销毁清理。
 */

function makeRegistry(workspaceRoot?: string): WriteFactRegistry {
  return new WriteFactRegistry({
    ...(workspaceRoot !== undefined ? { workspaceRoot: () => workspaceRoot } : {}),
    now: () => 1_000,
  });
}

describe("WriteFactRegistry", () => {
  test("record 累积与幂等（同路径计数增长不增集合）", () => {
    const r = makeRegistry();
    r.record({ instanceId: "m1", sessionId: "s1", path: "/ws/proj/a.ts", at: 100, confidence: "precise" });
    r.record({ instanceId: "m1", sessionId: "s1", path: "/ws/proj/a.ts", at: 200, confidence: "precise" });
    const inst = r.ofInstance("m1");
    expect(inst).not.toBeUndefined();
    expect(inst?.paths.size).toBe(1);
    expect(inst?.writeCount).toBe(2);
    expect(inst?.lastWriteAt).toBe(200);
  });

  test("同路径高置信覆盖低置信（precise 覆盖 uncertain）", () => {
    const r = makeRegistry();
    r.record({ instanceId: "m1", sessionId: "s1", path: "/x", at: 100, confidence: "uncertain" });
    r.record({ instanceId: "m1", sessionId: "s1", path: "/x", at: 200, confidence: "precise" });
    expect(r.ofInstance("m1")?.paths.get("/x")).toBe("precise");
    // 反向：低置信不覆盖已有高置信
    r.record({ instanceId: "m1", sessionId: "s1", path: "/x", at: 300, confidence: "inferred" });
    expect(r.ofInstance("m1")?.paths.get("/x")).toBe("precise");
  });

  test("ofSession 多实例聚合（main + 两 subagent）", () => {
    const r = makeRegistry();
    r.record({ instanceId: "main", sessionId: "s1", path: "/a", at: 1, confidence: "precise" });
    r.record({ instanceId: "agent-1", sessionId: "s1", path: "/b", at: 2, confidence: "precise" });
    r.record({ instanceId: "agent-2", sessionId: "s1", path: "/c", at: 3, confidence: "inferred" });
    r.record({ instanceId: "other-main", sessionId: "s2", path: "/d", at: 4, confidence: "precise" });
    expect(r.ofSession("s1").map((i) => i.instanceId).sort()).toEqual(["agent-1", "agent-2", "main"]);
  });

  test("sessionPaths 置信门槛过滤（U4 ≥inferred 口径）", () => {
    const r = makeRegistry();
    r.record({ instanceId: "m", sessionId: "s", path: "/p", at: 1, confidence: "precise" });
    r.record({ instanceId: "m", sessionId: "s", path: "/i", at: 2, confidence: "inferred" });
    r.record({ instanceId: "m", sessionId: "s", path: "/u", at: 3, confidence: "uncertain" });
    expect(r.sessionPaths("s").has("/u")).toBe(true); // 缺省全取（U1 口径）
    expect(r.sessionPaths("s", "inferred").has("/i")).toBe(true);
    expect(r.sessionPaths("s", "inferred").has("/p")).toBe(true);
    expect(r.sessionPaths("s", "inferred").has("/u")).toBe(false);
  });

  test("preciseWritesSince 剔除查询（时间窗 + 排除实例）", () => {
    const r = makeRegistry();
    r.record({ instanceId: "m", sessionId: "s", path: "/a", at: 100, confidence: "precise" });
    r.record({ instanceId: "agent-1", sessionId: "s", path: "/b", at: 150, confidence: "inferred" });
    r.record({ instanceId: "agent-2", sessionId: "s", path: "/c", at: 200, confidence: "precise" });
    const got = r.preciseWritesSince(120, "m");
    expect(got.map((f) => f.path)).toEqual(["/c"]); // /a 在窗前、/b 非 precise
  });

  test("projectFootprint：一级目录归约 + worktree 归主仓 + 根外剔除", () => {
    const r = makeRegistry("/ws");
    r.record({ instanceId: "m", sessionId: "s", path: "/ws/helix/src/a.ts", at: 1, confidence: "precise" });
    r.record({ instanceId: "m", sessionId: "s", path: "/ws/.worktrees/helix-foo/src/b.ts", at: 2, confidence: "inferred" });
    r.record({ instanceId: "m", sessionId: "s", path: "/tmp/scratch.txt", at: 3, confidence: "precise" });
    r.record({ instanceId: "m", sessionId: "s", path: "/ws/docs/note.md", at: 4, confidence: "precise" }); // 排除段
    expect(r.projectFootprint("s")).toEqual(["/ws/helix"]);
  });

  test("dropSession / dropInstance 清理", () => {
    const r = makeRegistry();
    r.record({ instanceId: "m", sessionId: "s1", path: "/a", at: 1, confidence: "precise" });
    r.record({ instanceId: "agent-1", sessionId: "s1", path: "/b", at: 1, confidence: "precise" });
    r.dropInstance("agent-1");
    expect(r.ofInstance("agent-1")).toBeUndefined();
    expect(r.ofInstance("m")).not.toBeUndefined();
    r.dropSession("s1");
    expect(r.snapshot().size).toBe(0);
  });
});
