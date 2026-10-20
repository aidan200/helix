/**
 * StewardMemoryService 单测——遗忘机制批（强度/召回融合/GC 三段/pin·restore/
 * 软上限）+ 防双写水位闸。纯位置迁移自 steward-memory-service.test.ts
 * （P1 体量门拆分批，测试逻辑与断言零改动）；共享夹具在
 * ./helpers/steward-memory-service-fixtures。
 */
import { describe, expect, test } from "bun:test";
import {
  StewardMemoryService,
  STEWARD_MEMORY_SOFT_CAP,
  memoryStrength,
  pickFadeCandidates,
  pickPurgeCandidates,
} from "../../src/application/steward/StewardMemoryService";
import {
  ENABLED_KV,
  fakeConfig,
  fakeEmbedding,
  fakeLookup,
  fakeStore,
  life,
} from "./helpers/steward-memory-service-fixtures";


// ── 遗忘机制批：强度/召回融合/GC 三段/pin·restore/软上限 ─────────

describe("StewardMemoryService 遗忘机制批", () => {
  const DAY = 24 * 3_600_000;

  test("① memoryStrength：半衰计算/强化倍率/封顶/manual·pinned 恒满", () => {
    const far = 400 * DAY;
    const base = { kind: "preference" as const, source: "steward-turn", createdAt: 0, updatedAt: 0, lastRecalledAt: 0, pinned: false };
    // anchor = 0，直接传流逝时刻：一个半衰期（preference 30d）→ 0.5
    expect(memoryStrength({ ...base, recallCount: 0 }, 30 * DAY)).toBeCloseTo(0.5, 5);
    // fact 半衰 60d → 0.5
    expect(memoryStrength({ ...base, kind: "fact", recallCount: 0 }, 60 * DAY)).toBeCloseTo(0.5, 5);
    // 强化：被想起 2 次（半衰 ×4 = 120d）→ 120d 后仍 0.5
    expect(memoryStrength({ ...base, recallCount: 2 }, 120 * DAY)).toBeCloseTo(0.5, 5);
    // 封顶：强化 8 次（×256）→ 半衰钉在 365d
    expect(memoryStrength({ ...base, recallCount: 8 }, 365 * DAY)).toBeCloseTo(0.5, 3);
    // manual/pinned 恒满（千年不衰）
    expect(memoryStrength({ ...base, source: "manual", recallCount: 0 }, far + 1000 * 365 * DAY)).toBe(1);
    expect(memoryStrength({ ...base, pinned: true, recallCount: 0 }, far + 1000 * 365 * DAY)).toBe(1);
  });

  test("② pickFadeCandidates：公平期豁免/manual·pinned 豁免/已 fade 不重复/强度线", () => {
    const now = 400 * DAY;
    const fresh = life({ id: 1, kind: "preference", text: "新", source: "s", createdAt: now - 10 * DAY, updatedAt: now - 10 * DAY });
    const stale = life({ id: 2, kind: "preference", text: "旧", source: "s", createdAt: 0, updatedAt: 0 });
    const manualOld = life({ id: 3, kind: "preference", text: "手写", source: "manual", createdAt: 0, updatedAt: 0 });
    const pinnedOld = { ...life({ id: 4, kind: "preference", text: "置顶", source: "s", createdAt: 0, updatedAt: 0 }), pinned: true };
    const alreadyFaded = { ...life({ id: 5, kind: "preference", text: "已淡", source: "s", createdAt: 0, updatedAt: 0 }), fadedAt: now - 5 * DAY };
    const recentlyRecalled = { ...life({ id: 6, kind: "preference", text: "常用", source: "s", createdAt: 0, updatedAt: 0 }), lastRecalledAt: now - 5 * DAY, recallCount: 3 };
    const picked = pickFadeCandidates([fresh, stale, manualOld, pinnedOld, alreadyFaded, recentlyRecalled], now);
    expect(picked.map((e) => e.id)).toEqual([2]);
  });

  test("③ pickPurgeCandidates：观察窗外删除；窗内保留", () => {
    const now = 100 * DAY;
    const inWindow = { ...life({ id: 1, kind: "fact", text: "a", source: "s", createdAt: 0, updatedAt: 0 }), fadedAt: now - 10 * DAY };
    const outWindow = { ...life({ id: 2, kind: "fact", text: "b", source: "s", createdAt: 0, updatedAt: 0 }), fadedAt: now - 31 * DAY };
    expect(pickPurgeCandidates([inWindow, outWindow], now).map((e) => e.id)).toEqual([2]);
  });

  test("④ 召回融合：faded 不出线；时间权重只影响竞争位；幸存者回写（陪跑不记）", async () => {
    const store = fakeStore();
    const now = 100 * DAY;
    store.entries.push(
      life({ id: 1, kind: "preference", text: "老偏好", source: "s", createdAt: 0, updatedAt: 0 }),
      life({ id: 2, kind: "preference", text: "新偏好", source: "s", createdAt: now - DAY, updatedAt: now - DAY }),
      { ...life({ id: 3, kind: "preference", text: "淡忘条目", source: "s", createdAt: 0, updatedAt: 0 }), fadedAt: now - DAY },
    );
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store,
      clock: () => now,
    });
    const section = await svc.recallSection("偏好");
    expect(section).toContain("新偏好");
    expect(section).toContain("老偏好"); // topK=5 内仍出线（资格闸不受时间权重影响）
    expect(section).not.toContain("淡忘条目");
    // 回写：注入幸存者（排序后 [新, 老]——新条目强度高胜出首位）；faded 3 号不记
    expect(store.recalled).toEqual([{ ids: [2, 1], at: now }]);
    expect(store.list().find((e) => e.id === 2)!.recallCount).toBe(1);
    expect(store.list().find((e) => e.id === 3)!.recallCount).toBe(0);
  });

  test("⑤ 唯一强相关的老条目仍能出线并复活（资格与排序解耦）", async () => {
    const store = fakeStore();
    const now = 400 * DAY; // 强度≈0（远超三个半衰期）
    store.entries.push(life({ id: 9, kind: "fact", text: "孤本事实", source: "s", createdAt: 0, updatedAt: 0 }));
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store,
      clock: () => now,
    });
    const section = await svc.recallSection("孤本");
    expect(section).toContain("孤本事实");
    expect(store.recalled[0]!.ids).toEqual([9]); // 出线即回写复活（锄点刷新）
  });

  test("⑥ GC 三段：fade（观察窗内不删）→ 观察窗外物理删；复活重置观察窗", () => {
    const store = fakeStore();
    let now = 400 * DAY;
    store.entries.push(
      life({ id: 1, kind: "preference", text: "旧A", source: "s", createdAt: 0, updatedAt: 0 }),
      life({ id: 2, kind: "preference", text: "旧B", source: "s", createdAt: 0, updatedAt: 0 }),
    );
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store,
      clock: () => now,
    });
    svc.gcNow();
    expect(store.fades.sort()).toEqual([1, 2]); // 第一轮：fade
    expect(store.list()).toHaveLength(2); // 观察窗内不物理删
    // 复活 1 号（重置观察窗）
    now += 10 * DAY;
    expect(svc.restoreMemoryEntry(1)).toBe(true);
    // 观察窗外第二轮：只删 2（1 号已复活不在 purge 候选）
    now += 31 * DAY;
    svc.gcNow();
    expect(store.list().map((e) => e.id)).toEqual([1]);
    expect(store.list()[0]!.fadedAt).toBe(0);
  });

  test("⑦ maybeGc 节流：窗口内二连零动作；窗口外放行", () => {
    const store = fakeStore();
    let now = 400 * DAY;
    store.entries.push(life({ id: 1, kind: "preference", text: "旧", source: "s", createdAt: 0, updatedAt: 0 }));
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store,
      clock: () => now,
    });
    svc.maybeGc();
    expect(store.fades).toEqual([1]);
    now += DAY; // 窗口内
    svc.maybeGc();
    expect(store.fades).toEqual([1]); // 零新增动作
    now += 25 * 3_600_000 * 24; // 超窗口
    svc.maybeGc();
    expect(store.fades).toEqual([1]); // 该条目已 faded（fadeMany 只动 active）——零动作即验证节流后仍无重复 fade
  });

  test("⑧ 软上限：append 后 count > SOFT_CAP → 主动 GC（绕节流）", async () => {
    const store = fakeStore();
    const now = 400 * DAY;
    store.entries.push(life({ id: 1, kind: "preference", text: "旧", source: "s", createdAt: 0, updatedAt: 0 }));
    // 覆写 count 触发软上限面（不真插 2000 条）
    (store as { count: () => number }).count = () => STEWARD_MEMORY_SOFT_CAP + 1;
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store,
      clock: () => now,
    });
    const outcome = await svc.appendMemoryEntry("手动记一条");
    expect(outcome.ok).toBe(true);
    expect(store.fades).toEqual([1]); // append 后主动 GC 已 fade 旧条目
  });

  test("⑨ pin/restore 委托：置顶隐含解除淡忘 + 刷 updatedAt；active restore 幂等 no-op", () => {
    const store = fakeStore();
    const now = 400 * DAY;
    store.entries.push({ ...life({ id: 1, kind: "preference", text: "旧", source: "s", createdAt: 0, updatedAt: 0 }), fadedAt: now - DAY });
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store,
      clock: () => now,
    });
    // active restore no-op（faded 才可恢复）
    expect(svc.restoreMemoryEntry(99)).toBe(false);
    // 置顶隐含解除淡忘 + 刷 updatedAt
    expect(svc.pinMemoryEntry(1, true)).toBe(true);
    const pinned = store.list()[0]!;
    expect(pinned.pinned).toBe(true);
    expect(pinned.fadedAt).toBe(0);
    expect(pinned.updatedAt).toBe(now);
    // 置顶条目强度恒满（永不 fade）
    expect(memoryStrength(pinned, now + 10_000 * DAY)).toBe(1);
    expect(svc.pinMemoryEntry(1, false)).toBe(true); // 取消置顶
    expect(store.list()[0]!.pinned).toBe(false);
  });

  test("⑩ GC 定时器：startGcTimer 幂等 + dispose 清理", () => {
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store: fakeStore(),
    });
    svc.startGcTimer();
    svc.startGcTimer(); // 幂等（不叠加定时器）
    svc.dispose();
    svc.dispose(); // 幂等
  });
});

// ── 防双写水位闸直接单测（设置页长期记忆组批）────────────────────────
//
// 与 steward-memory-tool.test.ts ⑥⑦ 的区别：那边断言在 fakeMemory 镜像面
// （fake 自持 lastExplicitRememberAt）；此处构造**真实 StewardMemoryService**
// （受控 clock + fake 出站依赖），断言落在真实实现的水位置位/读面语义上——
// 双写场景：轮内显式 remember（steward-turn/manual）置位 → 总结器记忆点
// 经 explicitRememberedSince(spanStart) 判本轮让位；自动生产源
// （session-summary）不置位不误伤。
describe("防双写水位闸（explicitRememberedSince 真实实现直接单测）", () => {
  /** 受控时钟服务构造糖（t 可变——模拟轮内时间推进）。 */
  function svcAt(t: number): { svc: StewardMemoryService; store: ReturnType<typeof fakeStore>; t: { now: number } } {
    const clock = { now: t };
    const store = fakeStore();
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(),
      embeddingConfig: fakeLookup(),
      store,
      clock: () => clock.now,
    });
    return { svc, store, t: clock };
  }

  test("① 初始态：水位 -1 → explicitRememberedSince 任意起点 false", () => {
    const { svc } = svcAt(1000);
    expect(svc.explicitRememberedSince(0)).toBe(false);
    expect(svc.explicitRememberedSince(1000)).toBe(false);
  });

  test("② 显式 remember（steward-turn）成功 → 水位置位：since ≤ 写入时刻 true / since > 写入时刻 false", async () => {
    const { svc, t } = svcAt(500);
    await svc.remember("用户偏好简洁回复", "preference", "steward-turn");
    expect(svc.explicitRememberedSince(0)).toBe(true); // 轮 spanStart（=0）以来写过
    expect(svc.explicitRememberedSince(500)).toBe(true); // 等号含入（>= 语义：本轮锚点整点写入算本轮）
    t.now = 900;
    expect(svc.explicitRememberedSince(901)).toBe(false); // 水位 500 < 901：下轮 spanStart 之后才写的才算
  });

  test("③ manual 人工新增同样置位（appendMemoryEntry → remember source=manual）", async () => {
    const { svc } = svcAt(700);
    const outcome = await svc.appendMemoryEntry("手动记一条", "preference");
    expect(outcome.ok).toBe(true);
    expect(svc.explicitRememberedSince(700)).toBe(true);
  });

  test("④ 自动生产源不置位：session-summary 记忆点入库 → 水位不动（显式写入才防双写）", async () => {
    const { svc } = svcAt(300);
    const outcome = await svc.rememberSessionMemoryPoint("总结器提炼的偏好", "preference", "habit");
    expect(outcome.updated).toBe(false); // 入库成功（新增）
    expect(svc.explicitRememberedSince(0)).toBe(false); // 自动源不置水位
  });

  test("⑤ 写失败不置位：embed 抛错 → remember 抛错 + 水位不动（总结器下锚点可补写）", async () => {
    const store = fakeStore();
    const svc = new StewardMemoryService({
      config: fakeConfig(ENABLED_KV),
      embedding: fakeEmbedding(3, true), // embed 抛错
      embeddingConfig: fakeLookup(),
      store,
      clock: () => 800,
    });
    await expect(svc.remember("存不进去的", "fact", "steward-turn")).rejects.toThrow("端点不可达");
    expect(svc.explicitRememberedSince(0)).toBe(false);
  });

  test("⑥ 双写场景全链：轮内显式写入后同轮总结器让位，下轮恢复可写", async () => {
    const { svc, t } = svcAt(1000);
    // 第 1 轮（spanStart=1000）：显式 remember 成功 → 本轮防双写闸关
    await svc.remember("用户偏好简洁", "preference", "steward-turn");
    expect(svc.explicitRememberedSince(1000)).toBe(true); // 总结器看到 true → 本轮记忆点让位
    // 第 2 轮（spanStart=2000）：显式水位（1000）不越界 → 总结器照常产记忆点
    t.now = 2000;
    expect(svc.explicitRememberedSince(2000)).toBe(false);
    // 第 2 轮记忆点入库（session-summary 自动源）→ 不置水位（第 3 轮仍可产）
    await svc.rememberSessionMemoryPoint("第 2 轮总结器提炼", "preference", "habit");
    expect(svc.explicitRememberedSince(2000)).toBe(false);
    // 第 3 轮（spanStart=3000）：闸仍开
    t.now = 3000;
    expect(svc.explicitRememberedSince(3000)).toBe(false);
  });
});
