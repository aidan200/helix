import { describe, expect, test } from "bun:test";
import {
  createTurnDiffState,
  statsFromPatch,
  TurnDiffService,
  TURN_DIFF_BASELINE_MAX_BYTES,
  TURN_DIFF_FROZEN_RING,
  TURN_DIFF_TURN_BUDGET_BYTES,
  type TurnDiffIoDeps,
  type WorkspaceStatIndexLite,
} from "../../src/application/services/TurnDiffService";
import { generateUnifiedPatch } from "../../src/adapters/driven/tools/edit/kernel/edit-diff";

/**
 * T2 轮次级内存态 diff——TurnDiffService 单测（数据链核心语义）：
 * - diff 以「轮」为单位累积：轮内首次写某文件前快照原文为基线（首基线
 *   永不覆盖），轮结束冻结结果，下一轮清零重来；
 * - 全内存：基线 ≤512KB/文件、单轮累计 ≤8MB、冻结环形保留最近 3 轮；
 * - 统计口径：+N=新增行、-N=删除行；文件级 status: added/deleted/modified/
 *   external 保留在数据结构里；
 * - external 兜底：轮首/轮末 stat 索引对比，变化且无基线的记 external。
 */

/** 生成 n 行文本（每行等长，便于 size 估算断言）。 */
function lines(n: number, prefix = "line"): string {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i}`).join("\n");
}

function makeService(io: TurnDiffIoDeps = {}): TurnDiffService {
  return new TurnDiffService(io);
}

describe("① 开轮重置清零", () => {
  test("beginTurn 后 active 为新轮（旧轮文件清空），turnId 换新", () => {
    const svc = makeService();
    const state = createTurnDiffState();
    svc.beginTurn(state, "turn-1", "2026-01-01T00:00:00Z");
    svc.recordWrite(state, "/w/a.txt", "old-a", "agent-main");
    expect(state.active?.files.size).toBe(1);

    svc.beginTurn(state, "turn-2", "2026-01-01T00:01:00Z");
    expect(state.active?.turnId).toBe("turn-2");
    expect(state.active?.files.size).toBe(0);
  });

  test("轮外写不归属（active=null 时 recordWrite 静默丢弃）", () => {
    const svc = makeService();
    const state = createTurnDiffState();
    svc.recordWrite(state, "/w/a.txt", "old", "agent-main");
    expect(state.active).toBeNull();
  });
});

describe("② 轮内首写快照基线幂等", () => {
  test("二次写不覆盖首基线；writeCount 递增", () => {
    const svc = makeService();
    const state = createTurnDiffState();
    svc.beginTurn(state, "turn-1", "t0");
    svc.recordWrite(state, "/w/a.txt", "original", "agent-main");
    svc.recordWrite(state, "/w/a.txt", "content-after-first-write", "agent-main");

    const entry = state.active?.files.get("/w/a.txt");
    expect(entry?.baseline).toBe("original"); // 首基线永不覆盖
    expect(entry?.writeCount).toBe(2);
    expect(entry?.status).toBe("modified");
  });

  test("新文件首写 → status=added、baseline=null", () => {
    const svc = makeService();
    const state = createTurnDiffState();
    svc.beginTurn(state, "turn-1", "t0");
    svc.recordWrite(state, "/w/new.txt", null, "agent-main");
    const entry = state.active?.files.get("/w/new.txt");
    expect(entry?.status).toBe("added");
    expect(entry?.baseline).toBeNull();
    expect(entry?.baselineSize).toBe(0);
  });
});

describe("③ agents 集合累积（同文件多 agent）", () => {
  test("主实例 + SubAgent 实例写入同文件 → agents 双成员；external 上报也累积", () => {
    const svc = makeService();
    const state = createTurnDiffState();
    svc.beginTurn(state, "turn-1", "t0");
    svc.recordWrite(state, "/w/a.txt", "old", "agent-main");
    svc.recordExternal(state, {
      path: "/w/a.txt",
      prevHash: "h1",
      prevSize: 3,
      nextSize: 10,
      agentId: "agent-sub-1",
    });
    svc.recordExternal(state, {
      path: "/w/a.txt",
      prevHash: "h2",
      prevSize: 10,
      nextSize: 20,
      agentId: "agent-sub-2",
    });

    const entry = state.active?.files.get("/w/a.txt");
    expect([...entry?.agents ?? []].sort()).toEqual(["agent-main", "agent-sub-1", "agent-sub-2"]);
    expect(entry?.baseline).toBe("old"); // external 上报不覆盖内容基线
  });

  test("无归属 external 上报（walk 兜底形态）→ status=external、agents 空", () => {
    const svc = makeService();
    const state = createTurnDiffState();
    svc.beginTurn(state, "turn-1", "t0");
    svc.recordExternal(state, { path: "/w/b.txt", prevHash: "h", prevSize: 100, nextSize: 160 });
    const entry = state.active?.files.get("/w/b.txt");
    expect(entry?.status).toBe("external");
    expect(entry?.baseline).toBeNull();
    expect(entry?.agents.size).toBe(0);
    expect(entry?.lastSize).toBe(160);
  });
});

describe("④ 超 512KB 降级 hash-only", () => {
  test("基线超限 → baseline=null、degraded=true、baselineSize 记原值", () => {
    const svc = makeService();
    const state = createTurnDiffState();
    svc.beginTurn(state, "turn-1", "t0");
    const big = "x".repeat(TURN_DIFF_BASELINE_MAX_BYTES + 1);
    svc.recordWrite(state, "/w/big.txt", big, "agent-main");
    const entry = state.active?.files.get("/w/big.txt");
    expect(entry?.baseline).toBeNull();
    expect(entry?.degraded).toBe(true);
    expect(entry?.baselineSize).toBe(big.length);
    expect(typeof entry?.baselineHash).toBe("string");
    expect(entry!.baselineHash.length).toBeGreaterThan(0);
  });

  test("恰好在上限内 → 正常存基线", () => {
    const svc = makeService();
    const state = createTurnDiffState();
    svc.beginTurn(state, "turn-1", "t0");
    const ok = "x".repeat(TURN_DIFF_BASELINE_MAX_BYTES);
    svc.recordWrite(state, "/w/ok.txt", ok, "agent-main");
    expect(state.active?.files.get("/w/ok.txt")?.baseline).toBe(ok);
  });

  test("单轮累计超 8MB → 后续新基线降级（hash-only），既有基线不受影响", () => {
    const svc = makeService();
    const state = createTurnDiffState();
    svc.beginTurn(state, "turn-1", "t0");
    // 预算测试用多文件堆积（单文件 ≤512KB 不触发单文件降级）：
    // 17 × 500KB = 8.5MB > 8MB——第 17 个文件预算耗尽降级
    const chunk = "y".repeat(500_000);
    for (let i = 0; i < 17; i++) {
      svc.recordWrite(state, `/w/f${i}.txt`, chunk, "agent-main");
    }
    expect(state.active?.files.get("/w/f0.txt")?.baseline).toBe(chunk); // 预算内正常存
    expect(state.active?.files.get("/w/f15.txt")?.baseline).toBe(chunk); // 累计 7.5MB 仍在预算内
    expect(state.active?.files.get("/w/f16.txt")?.baseline).toBeNull(); // 累计超 8MB → 降级
    expect(state.active?.files.get("/w/f16.txt")?.degraded).toBe(true);
  });
});

describe("⑤ 冻结环形 3 轮", () => {
  test("连续 4 轮 → frozen 恰 3 条（最旧淘汰），各轮 turnId/outcome 正确", async () => {
    const svc = makeService();
    const state = createTurnDiffState();
    for (let i = 1; i <= 4; i++) {
      svc.beginTurn(state, `turn-${i}`, `t${i}`);
      svc.recordWrite(state, "/w/a.txt", `old-${i}`, "agent-main");
      await svc.endTurn(state, i === 2 ? "interrupted" : "completed", `te${i}`);
    }
    expect(state.frozen.length).toBe(TURN_DIFF_FROZEN_RING);
    expect(state.frozen.map((f) => f.turnId)).toEqual(["turn-2", "turn-3", "turn-4"]);
    expect(state.frozen[0]!.outcome).toBe("interrupted");
    expect(state.frozen.map((f) => f.outcome)).toEqual(["interrupted", "completed", "completed"]);
  });

  test("endTurn 后 active 置空（同步摘下——下一轮 beginTurn 不与冻结竞态）", () => {
    const svc = makeService();
    const state = createTurnDiffState();
    svc.beginTurn(state, "turn-1", "t0");
    void svc.endTurn(state, "completed", "t1");
    expect(state.active).toBeNull();
  });
});

describe("⑥ external 条目（stat 变化无基线）", () => {
  test("轮首索引 vs 轮末 walk：变化且无基线 → external；未变化不记；有基线不覆盖", async () => {
    let index: WorkspaceStatIndexLite = new Map([
      ["/w/a.txt", { mtimeMs: 1, size: 10 }],
      ["/w/same.txt", { mtimeMs: 1, size: 5 }],
      ["/w/gone.txt", { mtimeMs: 1, size: 7 }],
    ]);
    const svc = new TurnDiffService({
      walkStats: async () => index,
      workspaceRoot: () => "/w",
    });
    const state = createTurnDiffState();
    svc.beginTurn(state, "turn-1", "t0");
    await state.active!.startWalk; // 等轮首 walk 完成
    svc.recordWrite(state, "/w/typed.txt", "old", "agent-main");

    index = new Map([
      ["/w/a.txt", { mtimeMs: 2, size: 20 }], // 变化 → external
      ["/w/same.txt", { mtimeMs: 1, size: 5 }], // 未变 → 不记
      ["/w/typed.txt", { mtimeMs: 9, size: 99 }], // 变化但有基线 → 不覆盖
    ]);
    await svc.endTurn(state, "completed", "t1");

    const frozen = state.frozen[0]!;
    const paths = frozen.files.map((f) => f.path);
    expect(paths).toContain("/w/a.txt");
    expect(paths).not.toContain("/w/same.txt");
    const externalEntry = frozen.files.find((f) => f.path === "/w/a.txt")!;
    expect(externalEntry.status).toBe("external");
    expect(externalEntry.patch).toBeNull();
    expect(externalEntry.removed).toBe(0);
    expect(externalEntry.added).toBeGreaterThan(0); // size 增 → +行粗估
    // 有基线条目不被 external 覆盖（仍是 modified 语义——status 保留内容面）
    const typed = frozen.files.find((f) => f.path === "/w/typed.txt")!;
    expect([...typed.agents]).toEqual(["agent-main"]);
  });

  test("轮首有、轮末无且无基线 → deleted 条目（size 差负向）", async () => {
    let index: WorkspaceStatIndexLite = new Map([["/w/gone.txt", { mtimeMs: 1, size: 400 }]]);
    const svc = new TurnDiffService({ walkStats: async () => index, workspaceRoot: () => "/w" });
    const state = createTurnDiffState();
    svc.beginTurn(state, "turn-1", "t0");
    await state.active!.startWalk;
    index = new Map();
    await svc.endTurn(state, "completed", "t1");
    const gone = state.frozen[0]!.files.find((f) => f.path === "/w/gone.txt");
    expect(gone?.status).toBe("deleted");
    expect(gone?.removed).toBeGreaterThan(0);
    expect(gone?.added).toBe(0);
  });
});

describe("⑦ computeStats 口径（+行/-行）", () => {
  test("statsFromPatch：+ 前缀（非 +++）计新增、- 前缀（非 ---）计删除", () => {
    const patch = [
      "--- a.txt",
      "+++ b.txt",
      "@@ -1,2 +1,3 @@",
      " context",
      "-removed-line",
      "+added-line",
      "+another-added",
    ].join("\n");
    expect(statsFromPatch(patch)).toEqual({ added: 2, removed: 1 });
  });

  test("冻结统计：modified（基线 2 行 → 终态 3 行）= +2/-1（真实 generateUnifiedPatch 注入）", async () => {
    const disk = new Map<string, string>([["/w/a.txt", "line-0\nline-1"]]);
    const svc = new TurnDiffService({
      readTextFile: async (p) => disk.get(p) ?? null,
      computePatch: (p, o, n) => generateUnifiedPatch(p, o, n),
    });
    const state = createTurnDiffState();
    svc.beginTurn(state, "turn-1", "t0");
    svc.recordWrite(state, "/w/a.txt", disk.get("/w/a.txt")!, "agent-main");
    disk.set("/w/a.txt", "line-0\nCHANGED\nEXTRA"); // 终态：1 删 2 增
    await svc.endTurn(state, "completed", "t1");

    const frozen = state.frozen[0]!;
    const entry = frozen.files[0]!;
    expect(entry.added).toBe(2);
    expect(entry.removed).toBe(1);
    expect(entry.patch).toContain("-line-1");
    expect(entry.patch).toContain("+CHANGED");
    expect(frozen.stats).toEqual({ added: 2, removed: 1 });
    expect(entry.status).toBe("modified");
  });

  test("added（无基线）→ 全文件 +N；写后被删（同轮 rm）→ deleted、-基线行数", async () => {
    const disk = new Map<string, string>();
    const svc = new TurnDiffService({
      readTextFile: async (p) => disk.get(p) ?? null,
      computePatch: (p, o, n) => generateUnifiedPatch(p, o, n),
    });
    const state = createTurnDiffState();
    svc.beginTurn(state, "turn-1", "t0");
    svc.recordWrite(state, "/w/new.txt", null, "agent-main");
    disk.set("/w/new.txt", "a\nb\nc");
    await svc.endTurn(state, "completed", "t1");
    expect(state.frozen[0]!.files[0]).toMatchObject({ status: "added", added: 3, removed: 0 });

    // 第二轮：写过又删
    svc.beginTurn(state, "turn-2", "t2");
    disk.set("/w/x.txt", "p\nq");
    svc.recordWrite(state, "/w/x.txt", disk.get("/w/x.txt")!, "agent-main");
    disk.delete("/w/x.txt");
    await svc.endTurn(state, "completed", "t3");
    const x = state.frozen[1]!.files[0]!;
    expect(x.status).toBe("deleted");
    expect(x.removed).toBe(2);
    expect(x.added).toBe(0);
  });

  test("降级条目（无基线原文）→ 无 patch、±行按 size 差粗估", async () => {
    const disk = new Map<string, string>([["/w/big.txt", "z".repeat(600 * 1024)]]);
    const svc = new TurnDiffService({
      readTextFile: async (p) => disk.get(p) ?? null,
      computePatch: (p, o, n) => generateUnifiedPatch(p, o, n),
    });
    const state = createTurnDiffState();
    svc.beginTurn(state, "turn-1", "t0");
    svc.recordWrite(state, "/w/big.txt", "z".repeat(TURN_DIFF_BASELINE_MAX_BYTES + 1), "agent-main");
    disk.set("/w/big.txt", "z".repeat(TURN_DIFF_BASELINE_MAX_BYTES + 512));
    await svc.endTurn(state, "completed", "t1");
    const f = state.frozen[0]!.files[0]!;
    expect(f.patch).toBeNull();
    expect(f.added).toBeGreaterThan(0);
    expect(f.removed).toBe(0);
  });
});

describe("⑧ captureWrite（env 写钩子入口：读旧内容 + record）", () => {
  test("captureWrite 经注入 readTextFile 读旧内容落基线；absoluteOf 归一相对路径", async () => {
    const disk = new Map<string, string>([["/w/a.txt", "old-content"]]);
    const svc = new TurnDiffService({
      readTextFile: async (p) => disk.get(p) ?? null,
      absoluteOf: (p) => `/w/${p}`,
    });
    const state = createTurnDiffState();
    svc.beginTurn(state, "turn-1", "t0");
    await svc.captureWrite(state, "a.txt", "agent-main");
    const entry = state.active?.files.get("/w/a.txt");
    expect(entry?.baseline).toBe("old-content");
    expect(entry?.status).toBe("modified");
  });

  test("读失败（IO 注入抛错）→ captureWrite 不抛（写链不受影响），条目仍记 added 语义兜底", async () => {
    const svc = new TurnDiffService({
      readTextFile: async () => {
        throw new Error("io down");
      },
    });
    const state = createTurnDiffState();
    svc.beginTurn(state, "turn-1", "t0");
    await expect(svc.captureWrite(state, "/w/a.txt", "agent-main")).resolves.toBeUndefined();
    expect(state.active?.files.get("/w/a.txt")?.status).toBe("added");
  });
});

describe("⑨ getTurnView live 回落（rehydrate auto 语义）", () => {
  test("live=true 无进行中轮 → 回落最近冻结轮（不再 null）", async () => {
    const disk = new Map<string, string>();
    const svc = makeService({
      readTextFile: async (p) => disk.get(p) ?? null,
      computePatch: (path, prev, next) => generateUnifiedPatch(path, prev, next),
    });
    const state = createTurnDiffState();
    svc.beginTurn(state, "turn-1", "t0");
    disk.set("/w/a.txt", ""); // 写前旧内容（空文件）
    await svc.captureWrite(state, "/w/a.txt", "agent-main", lines(10));
    disk.set("/w/a.txt", lines(10)); // 写钩子后落盘（模拟 env.writeFile）
    await svc.endTurn(state, "completed", "t1");

    // 轮已结束（active=null）：live=true 回落最近冻结轮
    const view = await svc.getTurnView(state, { live: true });
    expect(view?.turnId).toBe("turn-1");
    expect(view?.phase).toBe("frozen");
    expect(view?.stats).toEqual({ added: 10, removed: 0 });
  });

  test("live=true 有进行中轮 → active 即时视图（不回落）", async () => {
    const svc = makeService({ computePatch: (path, prev, next) => generateUnifiedPatch(path, prev, next) });
    const state = createTurnDiffState();
    svc.beginTurn(state, "turn-1", "t-earlier");
    await svc.endTurn(state, "completed", "t-early"); // 先冻结一轮（回落候选）
    svc.beginTurn(state, "turn-2", "t0");
    await svc.captureWrite(state, "/w/a.txt", "agent-main", lines(5));
    const view = await svc.getTurnView(state, { live: true });
    expect(view?.turnId).toBe("turn-2");
    expect(view?.phase).toBe("active");
  });

  test("live=true 无 active 且无冻结轮（冷会话）→ 仍 null（如实无记录）", async () => {
    const svc = makeService();
    const state = createTurnDiffState();
    const view = await svc.getTurnView(state, { live: true });
    expect(view).toBeNull();
  });
});
