import { describe, expect, test } from "bun:test";
import type { DiffChangedPayload } from "@helix/protocol";
import {
  createTurnDiffState,
  TurnDiffService,
  type DiffPushProbe,
  type TurnDiffIoDeps,
  type TurnDiffState,
} from "../../src/application/services/TurnDiffService";

/**
 * T3 轮次 diff 推送回调注入单测（照 IO 注入同式的可选推送面）：
 * - beginTurn → cleared 帧（清零）；recordWrite/recordExternal → active 帧
 *   （即时统计——异步重算）；endTurn → frozen 帧（精确终值）；
 * - 无注入 → 零回调零异常（缺省兼容）；
 * - getTurnView 读面：live = 进行中轮即时视图 / 冻结轮（缺省最近 + 指定
 *   turnId）/ 无 diff = null。
 *
 * 回调签名带 state（服务零 driving import——组合根按 state 反查归属会话）。
 */

/** 记录型探针：收集 (state 标记, change)。 */
function probe(): DiffPushProbe {
  const calls: { state: TurnDiffState; change: DiffChangedPayload }[] = [];
  return {
    calls,
    onDiffChanged: (state, change) => {
      calls.push({ state, change });
    },
  };
}

import { generateUnifiedPatch } from "../../src/adapters/driven/tools/edit/kernel/edit-diff";

/** 即时统计 IO fake：内存文件系统（写后终读即读内存现值；patch 用真 kernel——统计口径与生产一致）。 */
function memIo(files: Map<string, string>): TurnDiffIoDeps {
  return {
    readTextFile: async (p) => files.get(p) ?? null,
    computePatch: (path, oldContent, newContent) => generateUnifiedPatch(path, oldContent, newContent),
  };
}

/** 让出一拍（微任务冲刷）——异步操作兑底等待。 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}
void settle;

describe("① 推送回调注入（可选——缺省零回调零异常）", () => {
  test("无注入时全部操作正常（兼容 T2 形态）", () => {
    const svc = new TurnDiffService({});
    const state = createTurnDiffState();
    svc.beginTurn(state, "t1", "ts");
    svc.recordWrite(state, "/w/a.txt", null, "main");
    expect(() => svc.recordExternal(state, { path: "/w/e.txt", prevHash: "h", prevSize: 10, nextSize: 20 })).not.toThrow();
  });
});

describe("② 三态推送：cleared → active → frozen", () => {
  test("beginTurn 推 cleared（清零）", () => {
    const p = probe();
    const svc = new TurnDiffService({}, p);
    const state = createTurnDiffState();
    svc.beginTurn(state, "t1", "ts");
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.change).toEqual({ turnId: "t1", phase: "cleared", adds: 0, dels: 0, fileCount: 0 });
    expect(p.calls[0]!.state).toBe(state);
  });

  test("captureWrite 携带写后内容 → 同步推 active（逐写精确增量：baseline → content patch）", async () => {
    const files = new Map<string, string>([["/w/a.txt", "x\ny\n"]]);
    const p = probe();
    const svc = new TurnDiffService(memIo(files), p);
    const state = createTurnDiffState();
    svc.beginTurn(state, "t1", "ts");
    p.calls.length = 0;
    await svc.captureWrite(state, "/w/a.txt", "main", "x\ny\nz\nw\n");
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.change).toEqual({ turnId: "t1", phase: "active", adds: 2, dels: 0, fileCount: 1 });
  });

  test("captureWrite 多次写同文件 → 逐写增量累计（非快照重算；基线 = 写前盘面）", async () => {
    const files = new Map<string, string>([["/w/b.txt", "one\n"]]);
    const p = probe();
    const svc = new TurnDiffService(memIo(files), p);
    const state = createTurnDiffState();
    svc.beginTurn(state, "t1", "ts");
    // 第一次写：盘面仍 "one\n"（写前）→ 增量 +two；写盘后才更新模拟盘面
    await svc.captureWrite(state, "/w/b.txt", "main", "one\ntwo\n");
    files.set("/w/b.txt", "one\ntwo\n");
    // 第二次写：盘面 "one\ntwo\n"（写前）→ 增量 +three +four
    await svc.captureWrite(state, "/w/b.txt", "main", "one\ntwo\nthree\nfour\n");
    files.set("/w/b.txt", "one\ntwo\nthree\nfour\n");
    const actives = p.calls.filter((c) => c.change.phase === "active");
    expect(actives).toHaveLength(2);
    expect(actives[0]!.change).toEqual({ turnId: "t1", phase: "active", adds: 1, dels: 0, fileCount: 1 });
    expect(actives[1]!.change).toEqual({ turnId: "t1", phase: "active", adds: 3, dels: 0, fileCount: 1 });
  });

  test("captureWrite 无写后内容（T2 形态）→ 不推 active（兼容）", async () => {
    const files = new Map<string, string>([["/w/a.txt", "old\n"]]);
    const p = probe();
    const svc = new TurnDiffService(memIo(files), p);
    const state = createTurnDiffState();
    svc.beginTurn(state, "t1", "ts");
    p.calls.length = 0;
    await svc.captureWrite(state, "/w/a.txt", "main");
    expect(p.calls).toHaveLength(0);
  });

  test("recordExternal 后推 active（size 差粗估口径）", () => {
    const p = probe();
    const svc = new TurnDiffService({}, p);
    const state = createTurnDiffState();
    svc.beginTurn(state, "t1", "ts");
    p.calls.length = 0;
    svc.recordExternal(state, { path: "/w/e.bin", prevHash: "h", prevSize: 100, nextSize: 4200 });
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.change).toMatchObject({ turnId: "t1", phase: "active", fileCount: 1 });
    expect(p.calls[0]!.change["adds"]).toBeGreaterThan(0);
  });

  test("endTurn 冻结后推 frozen（精确终值）", async () => {
    const files = new Map<string, string>([["/w/a.txt", "old1\nold2"]]);
    const p = probe();
    const svc = new TurnDiffService(memIo(files), p);
    const state = createTurnDiffState();
    svc.beginTurn(state, "t1", "ts");
    svc.recordWrite(state, "/w/a.txt", "old1\nold2", "main");
    files.set("/w/a.txt", "new1\nnew2\nnew3");
    p.calls.length = 0;
    await svc.endTurn(state, "completed", "ts2");
    const frozen = p.calls.find((c) => c.change.phase === "frozen");
    expect(frozen).toBeDefined();
    expect(frozen!.change).toEqual({ turnId: "t1", phase: "frozen", adds: 3, dels: 2, fileCount: 1 });
  });
});

describe("③ getTurnView 读面（diff.get 数据源）", () => {
  test("live=true：进行中轮即时视图（终读现值 + 精确统计，不动冻结环形）", async () => {
    const files = new Map<string, string>([["/w/a.txt", "old"]]);
    const svc = new TurnDiffService(memIo(files), probe());
    const state = createTurnDiffState();
    svc.beginTurn(state, "t1", "ts");
    svc.recordWrite(state, "/w/a.txt", "old", "main");
    files.set("/w/a.txt", "n1\nn2");
    const view = await svc.getTurnView(state, { live: true });
    expect(view).not.toBeNull();
    expect(view!.turnId).toBe("t1");
    expect(view!.phase).toBe("active");
    expect(view!.stats).toEqual({ added: 2, removed: 1 });
    expect(view!.files).toHaveLength(1);
    expect(view!.files[0]!.status).toBe("modified");
    expect(state.frozen).toHaveLength(0); // 不入环形
  });

  test("live=true 无进行中轮 → null", async () => {
    const svc = new TurnDiffService(memIo(new Map()));
    const state = createTurnDiffState();
    expect(await svc.getTurnView(state, { live: true })).toBeNull();
  });

  test("缺省 = 最近冻结轮；指定 turnId 命中环形历史", async () => {
    const files = new Map<string, string>();
    const svc = new TurnDiffService(memIo(files), probe());
    const state = createTurnDiffState();
    svc.beginTurn(state, "t1", "ts");
    svc.recordWrite(state, "/w/one.txt", null, "main");
    files.set("/w/one.txt", "a\nb\nc");
    await svc.endTurn(state, "completed", "ts2");
    svc.beginTurn(state, "t2", "ts3");
    svc.recordWrite(state, "/w/two.txt", null, "main");
    files.set("/w/two.txt", "x");
    await svc.endTurn(state, "interrupted", "ts4");

    const latest = await svc.getTurnView(state, {});
    expect(latest!.turnId).toBe("t2");
    expect(latest!.phase).toBe("frozen");
    const t1 = await svc.getTurnView(state, { turnId: "t1" });
    expect(t1!.turnId).toBe("t1");
    expect(await svc.getTurnView(state, { turnId: "t-nope" })).toBeNull();
  });

  test("冷态（无 active 无 frozen）→ null", async () => {
    const svc = new TurnDiffService(memIo(new Map()));
    expect(await svc.getTurnView(createTurnDiffState(), {})).toBeNull();
  });
});
