/**
 * SqliteVecMemoryStore 真库单测（管家记忆 B1 批——better-sqlite3 +
 * sqlite-vec 真实加载，":memory:" 库零磁盘）。
 *
 * 断言面：
 * 1. append + list + count：条目全字段往返（kind/text/source/createdAt）；
 * 2. search：cosine topK 排序（定向向量——query 与甲同向 → 甲居首）+
 *    score = 1 - distance；
 * 3. forget：条目 + 向量同事务删除（search 不再命中；不存在 id → false）；
 * 4. 维度生命周期：storedDim 初始 null → append 按向量维度建表 →
 *    resetVectors 换维（entries 保留、向量面清空）→ putVector 回填召回恢复；
 * 5. 未建表 search → 空数组（零配置降级语义）。
 */
import { describe, expect, test } from "bun:test";
import { getLoadablePath } from "sqlite-vec";
import { SqliteVecMemoryStore } from "../../src/adapters/driven/steward-memory/SqliteVecMemoryStore";

function makeStore(): SqliteVecMemoryStore {
  return new SqliteVecMemoryStore(":memory:", getLoadablePath());
}

/** 定维定向向量（3 维单热——cosine 距离可预期）。 */
const V_A = Float32Array.from([1, 0, 0]);
const V_B = Float32Array.from([0, 1, 0]);
const V_C = Float32Array.from([0.9, 0.1, 0]);

describe("SqliteVecMemoryStore（真库）", () => {
  test("① append + list + count 全字段往返", () => {
    const store = makeStore();
    store.append([
      { kind: "preference", text: "回复要简洁", source: "steward-turn", createdAt: 1000, vector: V_A },
      { kind: "fact", text: "项目在 helix 仓", source: "steward-turn", createdAt: 2000, vector: V_B },
    ]);
    expect(store.count()).toBe(2);
    const entries = store.list();
    expect(entries.map((e) => e.text)).toEqual(["回复要简洁", "项目在 helix 仓"]);
    expect(entries[0]!.kind).toBe("preference");
    expect(entries[0]!.source).toBe("steward-turn");
    expect(entries[0]!.createdAt).toBe(1000);
    store.close();
  });

  test("② search：cosine topK 排序 + score 语义（同向居首）", () => {
    const store = makeStore();
    store.append([
      { kind: "fact", text: "乙", source: "t", createdAt: 1, vector: V_B },
      { kind: "fact", text: "甲", source: "t", createdAt: 2, vector: V_A },
      { kind: "fact", text: "丙", source: "t", createdAt: 3, vector: V_C },
    ]);
    const hits = store.search(V_A, 2);
    expect(hits.length).toBe(2);
    expect(hits[0]!.text).toBe("甲"); // 完全同向 distance≈0 → score≈1
    expect(hits[1]!.text).toBe("丙"); // 近同向次之
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    expect(hits[0]!.score).toBeGreaterThan(0.99);
    store.close();
  });

  test("③ forget：条目 + 向量同删（不存在 id → false）", () => {
    const store = makeStore();
    store.append([{ kind: "fact", text: "甲", source: "t", createdAt: 1, vector: V_A }]);
    const id = store.list()[0]!.id;
    expect(store.forget(id)).toBe(true);
    expect(store.count()).toBe(0);
    expect(store.search(V_A, 5)).toEqual([]);
    expect(store.forget(id)).toBe(false);
    store.close();
  });

  test("④ 维度生命周期：null → 建表 → resetVectors 换维（条目保留/向量清）→ putVector 回填", () => {
    const store = makeStore();
    expect(store.storedDim()).toBeNull();
    store.append([{ kind: "fact", text: "甲", source: "t", createdAt: 1, vector: V_A }]);
    expect(store.storedDim()).toBe(3);
    expect(store.search(V_A, 1).length).toBe(1);
    // 换 embedding 模型（3 → 2 维）：向量面重建，条目零损失
    store.resetVectors(2);
    expect(store.storedDim()).toBe(2);
    expect(store.count()).toBe(1);
    expect(store.search(Float32Array.from([1, 0]), 5)).toEqual([]);
    store.putVector(store.list()[0]!.id, Float32Array.from([0.8, 0.2]));
    const hits = store.search(Float32Array.from([1, 0]), 1);
    expect(hits.length).toBe(1);
    expect(hits[0]!.text).toBe("甲");
    store.close();
  });

  test("⑤ 未建表（空库零 append）search → 空数组", () => {
    const store = makeStore();
    expect(store.search(V_A, 5)).toEqual([]);
    store.close();
  });

  // ── 遗忘机制批：生命周期四列 + 生命周期写面 ─────────────────

  test("⑥ 遗忘机制批：新条目生命周期缺省（满强度起步）+ search/list 携带新列", () => {
    const store = makeStore();
    store.append([{ kind: "preference", text: "甲", source: "steward-turn", createdAt: 1000, vector: V_A }]);
    const e = store.list()[0]!;
    expect(e.lastRecalledAt).toBe(1000); // = createdAt（锄点即创建时刻）
    expect(e.recallCount).toBe(0);
    expect(e.fadedAt).toBe(0);
    expect(e.pinned).toBe(false);
    const hit = store.search(V_A, 1)[0]!;
    expect(hit.lastRecalledAt).toBe(1000); // search hit 同源携带（融合排序素材）
    expect(hit.fadedAt).toBe(0);
    store.close();
  });

  test("⑦ markRecalled：批量回写（at + recallCount 累加）", () => {
    const store = makeStore();
    store.append([
      { kind: "fact", text: "甲", source: "t", createdAt: 1, vector: V_A },
      { kind: "fact", text: "乙", source: "t", createdAt: 2, vector: V_B },
    ]);
    const [a, b] = store.list();
    store.markRecalled([a!.id], 5000);
    const after = store.list();
    expect(after[0]!.lastRecalledAt).toBe(5000);
    expect(after[0]!.recallCount).toBe(1);
    expect(after[1]!.lastRecalledAt).toBe(2); // 未命中不动
    expect(after[1]!.recallCount).toBe(0);
    void b;
    store.close();
  });

  test("⑧ fadeMany/restore：fade 幂等只动 active；restore 仅 faded 生效且刷 updatedAt", () => {
    const store = makeStore();
    store.append([
      { kind: "fact", text: "甲", source: "t", createdAt: 1, vector: V_A },
      { kind: "fact", text: "乙", source: "t", createdAt: 2, vector: V_B },
    ]);
    const [a, b] = store.list();
    store.fadeMany([a!.id, b!.id], 100);
    expect(store.list().map((e) => e.fadedAt)).toEqual([100, 100]);
    store.fadeMany([a!.id], 200); // 已 faded 不重复刷（观察窗锄点稳定）
    expect(store.list()[0]!.fadedAt).toBe(100);
    // restore：faded → 满血；active → no-op
    expect(store.restore(a!.id, 300)).toBe(true);
    const restored = store.list()[0]!;
    expect(restored.fadedAt).toBe(0);
    expect(restored.updatedAt).toBe(300);
    expect(store.restore(a!.id, 400)).toBe(false); // active 幂等 no-op
    expect(store.list()[0]!.updatedAt).toBe(300);
    expect(store.restore(999, 500)).toBe(false); // 不存在
    store.close();
  });

  test("⑨ setPinned：置顶隐含解除淡忘 + 刷 updatedAt；取消只清置位", () => {
    const store = makeStore();
    store.append([{ kind: "fact", text: "甲", source: "t", createdAt: 1, vector: V_A }]);
    const id = store.list()[0]!.id;
    store.fadeMany([id], 100);
    expect(store.setPinned(id, true, 500)).toBe(true);
    const pinned = store.list()[0]!;
    expect(pinned.pinned).toBe(true);
    expect(pinned.fadedAt).toBe(0);
    expect(pinned.updatedAt).toBe(500);
    expect(store.setPinned(id, false, 600)).toBe(true);
    const unpinned = store.list()[0]!;
    expect(unpinned.pinned).toBe(false);
    expect(unpinned.updatedAt).toBe(500); // 取消置顶不刷时间
    expect(store.setPinned(999, true, 700)).toBe(false); // 不存在
    store.close();
  });

  test("⑩ updateEntry 编辑即救活：faded_at 同事务归零", () => {
    const store = makeStore();
    store.append([{ kind: "fact", text: "甲", source: "t", createdAt: 1, vector: V_A }]);
    const id = store.list()[0]!.id;
    store.fadeMany([id], 100);
    expect(store.updateEntry(id, "甲（改）", V_C, 900)).toBe(true);
    const edited = store.list()[0]!;
    expect(edited.text).toBe("甲（改）");
    expect(edited.fadedAt).toBe(0);
    expect(edited.updatedAt).toBe(900);
    store.close();
  });
});
