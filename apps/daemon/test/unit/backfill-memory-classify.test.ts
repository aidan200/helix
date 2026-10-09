/**
 * 存量记忆条目判官批量分类回填（批B）单测。
 *
 * 红绿证据链（brief 测试要求逐条——判官面为 JudgePort.noul 单概率形态，
 * brief 的「严格 JSON 解析」按实况调整为「概率→判定映射 + 非法值容错 +
 * 调用级重试/跳过」，形态调整已留档）：
 * 1. 批量判解析：verdictFromProbabilities 概率→判定映射（边界含 0.5）、
 *    非法概率（NaN）→ null（该条跳过保持现状）；
 * 2. 机械取名：matchProjectName 唯一命中取名 / 零命中回落 / 多命中保守
 *    回落（宁保守归 global 不伪造项目名）；
 * 3. 判定链 classifyEntry（fake JudgePort）：habit 命中短路（2 问）、
 *    非 habit 三问、project 判定经 resolveMemoryWriteAttrs 单点出口
 *    （有名取名 / 无名回落 general+global + warn——一致性约束回归）；
 *    判官抛错问级重试一次、仍失败该条 skip；
 * 4. 回写幂等（真 store :memory:）：首跑回写 + meta 幂等标记；重跑已判
 *    跳过（判官零调用、数据零翻转）；新增条目增量判；不动
 *    text/vector/生命周期/updated_at/session_id/source/created_at 列；
 * 5. 判官缺席（judge=null）整批放弃零写入；判官恒抛错 → 全 skip 零写入
 *    （原子性：失败批次零写入）；dryRun 判定照跑零落库；
 * 6. fake JudgePort 全链路集成：AUTO_SOURCES（auto-sediment/session-summary）
 *    外的 progress/steward-turn/manual 原样保留，前后分布交叉表正确。
 */
import { describe, expect, test } from "bun:test";
import { getLoadablePath } from "sqlite-vec";
import { SqliteVecMemoryStore } from "../../src/adapters/driven/steward-memory/SqliteVecMemoryStore";
import type { StewardMemoryAppendItem } from "../../src/application/ports/outbound/StewardMemoryPort";
import type { JudgePort } from "../../src/application/ports/outbound/JudgePort";
import {
  BACKFILL_CLASSIFY_MARKER,
  KIND_QUESTION,
  HABIT_QUESTION,
  PROJECT_QUESTION,
  verdictFromProbabilities,
  matchProjectName,
  classifyEntry,
  runBackfill,
} from "../../scripts/backfill-memory-classify";

// ── fixtures ──────────────────────────────────────────────

const V = Float32Array.from([1, 0, 0]);

interface JudgeScript {
  /** question 前缀 → 概率（缺 0.5）；failQuestions 首次抛错（重试路径）。 */
  readonly probs?: Partial<Record<"kind" | "habit" | "project", number>>;
  readonly failFirst?: Partial<Record<"kind" | "habit" | "project", number>>;
  readonly alwaysFail?: boolean;
}

function fakeJudge(script: JudgeScript): JudgePort & {
  readonly calls: { state: string; question: string }[];
} {
  const calls: { state: string; question: string }[] = [];
  const failed = new Set<string>();
  const pick = (q: string): { which: "kind" | "habit" | "project"; p: number } | null => {
    if (q === KIND_QUESTION) return { which: "kind", p: script.probs?.kind ?? 0.5 };
    if (q === HABIT_QUESTION) return { which: "habit", p: script.probs?.habit ?? 0.5 };
    if (q === PROJECT_QUESTION) return { which: "project", p: script.probs?.project ?? 0.5 };
    return null;
  };
  return {
    calls,
    async noul(state, question) {
      calls.push({ state, question });
      const hit = pick(question);
      if (hit === null) throw new Error(`测试脚本未覆盖问题：${question}`);
      if (script.alwaysFail) throw new Error("判官端点不可达");
      const failBudget = script.failFirst?.[hit.which] ?? 0;
      if (failBudget > 0 && !failed.has(hit.which)) {
        failed.add(hit.which);
        throw new Error("网络抖动（首败重试路径）");
      }
      return hit.p;
    },
    endpointLabel: () => "fake-judge",
  };
}

function makeStore(): SqliteVecMemoryStore {
  return new SqliteVecMemoryStore(":memory:", getLoadablePath());
}

interface SeedRow {
  readonly kind: "preference" | "fact" | "progress";
  readonly text: string;
  readonly source: string;
  readonly domain?: "habit" | "general" | "project";
  readonly projectScope?: string;
}

function seed(store: SqliteVecMemoryStore, rows: readonly SeedRow[]): void {
  const items: StewardMemoryAppendItem[] = rows.map((r, i) => ({
    kind: r.kind,
    text: r.text,
    source: r.source,
    createdAt: 1000 + i,
    vector: V,
    ...(r.domain !== undefined ? { domain: r.domain } : {}),
    ...(r.projectScope !== undefined ? { projectScope: r.projectScope } : {}),
  }));
  store.append(items);
}

function snapshot(store: SqliteVecMemoryStore): Map<number, ReturnType<SqliteVecMemoryStore["list"]>[number]> {
  return new Map(store.list().map((e) => [e.id, e]));
}

// ── 1. 概率→判定映射（批量判解析面）────────────────────────

describe("verdictFromProbabilities：概率→判定映射", () => {
  test("kind 高概率 + habit 命中 → preference/habit", () => {
    expect(verdictFromProbabilities(0.9, 0.8, undefined)).toEqual({ kind: "preference", domain: "habit" });
  });

  test("kind 低 + habit 未命中 + project 命中 → fact/project", () => {
    expect(verdictFromProbabilities(0.3, 0.2, 0.9)).toEqual({ kind: "fact", domain: "project" });
  });

  test("kind 低 + 双未命中 → fact/general", () => {
    expect(verdictFromProbabilities(0.3, 0.2, 0.3)).toEqual({ kind: "fact", domain: "general" });
  });

  test("边界含 0.5：kindP=0.5 → preference；habitP=0.5 → habit（不问 project）", () => {
    expect(verdictFromProbabilities(0.5, 0.5, undefined)).toEqual({ kind: "preference", domain: "habit" });
  });

  test("kindP<0.5 → fact（habit 未命中时才消费 projectP）", () => {
    expect(verdictFromProbabilities(0.49, 0.2, 0.5)).toEqual({ kind: "fact", domain: "project" });
  });

  test("非法 kindP（NaN/越界）→ null（该条跳过保持现状）", () => {
    expect(verdictFromProbabilities(Number.NaN, 0.8, undefined)).toBeNull();
    expect(verdictFromProbabilities(1.2, 0.8, undefined)).toBeNull();
    expect(verdictFromProbabilities(-0.1, 0.8, undefined)).toBeNull();
  });

  test("非法 habitP → null", () => {
    expect(verdictFromProbabilities(0.9, Number.NaN, undefined)).toBeNull();
  });

  test("habit 未命中但 projectP 非法 → null", () => {
    expect(verdictFromProbabilities(0.9, 0.2, Number.NaN)).toBeNull();
    expect(verdictFromProbabilities(0.9, 0.2, 1.5)).toBeNull();
  });
});

// ── 2. 机械取名（宁可保守不伪造）──────────────────────────

describe("matchProjectName：条目文本机械取名", () => {
  test("唯一命中 → 项目名", () => {
    expect(matchProjectName("helix 的 daemon 测试在 apps/daemon/test", ["helix"])).toBe("helix");
  });

  test("大小写不敏感命中", () => {
    expect(matchProjectName("Helix 的仓库布局是 monorepo", ["helix"])).toBe("helix");
  });

  test("零命中 → undefined（回落 general+global）", () => {
    expect(matchProjectName("本机是 macOS，测试用 bun", ["helix"])).toBeUndefined();
  });

  test("多命中 → undefined（保守：无法唯一定名不伪造）", () => {
    expect(matchProjectName("helix 与 serena 两个项目共用 bun", ["helix", "serena"])).toBeUndefined();
  });

  test("候选集空 → undefined", () => {
    expect(matchProjectName("helix 的规则", [])).toBeUndefined();
  });
});

// ── 3. 判定链（fake JudgePort）─────────────────────────────

describe("classifyEntry：判定链与问级重试", () => {
  test("habit 命中短路——kind + habit 恰两问", async () => {
    const judge = fakeJudge({ probs: { kind: 0.9, habit: 0.9 } });
    const out = await classifyEntry(judge, "用户要求答复用白话", ["helix"]);
    expect(out).toMatchObject({ ok: true, kind: "preference", domain: "habit", projectScope: "global" });
    expect(judge.calls).toHaveLength(2);
  });

  test("非 habit 三问——kind/habit/project", async () => {
    const judge = fakeJudge({ probs: { kind: 0.2, habit: 0.1, project: 0.9 } });
    const out = await classifyEntry(judge, "本机 macOS 的默认 shell 是 zsh", ["helix"]);
    expect(out).toMatchObject({ ok: true, kind: "fact", domain: "general", projectScope: "global" });
    expect(judge.calls).toHaveLength(3);
  });

  test("project 判定 + 文本唯一命中项目名 → project/项目名（一致性约束单点出口）", async () => {
    const judge = fakeJudge({ probs: { kind: 0.2, habit: 0.1, project: 0.95 } });
    const warnings: string[] = [];
    const out = await classifyEntry(judge, "helix 的 daemon 测试在 apps/daemon/test", ["helix"], {
      warn: (m) => warnings.push(m),
    });
    expect(out).toMatchObject({ ok: true, kind: "fact", domain: "project", projectScope: "helix" });
    expect(warnings).toBeEmpty();
  });

  test("project 判定但文本无项目名 → 回落 general+global + warn（不伪造项目名）", async () => {
    const judge = fakeJudge({ probs: { kind: 0.2, habit: 0.1, project: 0.95 } });
    const warnings: string[] = [];
    const out = await classifyEntry(judge, "daemon 的测试在 apps/daemon/test 目录", ["helix"], {
      warn: (m) => warnings.push(m),
    });
    expect(out).toMatchObject({ ok: true, kind: "fact", domain: "general", projectScope: "global" });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("回落");
  });

  test("判官首问抛错——问级重试一次成功 → 正常判定", async () => {
    const judge = fakeJudge({ probs: { kind: 0.9, habit: 0.9 }, failFirst: { kind: 1 } });
    const out = await classifyEntry(judge, "用户习惯极简确认", ["helix"]);
    expect(out).toMatchObject({ ok: true, kind: "preference", domain: "habit" });
  });

  test("判官重试仍抛错 → 该条 skip（ok=false，保持现状缺省）", async () => {
    const judge = fakeJudge({ alwaysFail: true });
    const out = await classifyEntry(judge, "用户习惯极简确认", ["helix"]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("判官");
  });
});

// ── 4/5/6. 编排器（真 store + fake JudgePort 集成）─────────

describe("runBackfill：编排回写（幂等/原子性/范围钳制）", () => {
  function seededStore(): SqliteVecMemoryStore {
    const store = makeStore();
    seed(store, [
      { kind: "preference", text: "用户要求答复用白话", source: "session-summary" },
      { kind: "preference", text: "本机 macOS 测试用 bun", source: "auto-sediment" },
      { kind: "preference", text: "helix 的 daemon 测试在 apps/daemon/test", source: "session-summary" },
      { kind: "progress", text: "会话进展", source: "session-progress", domain: "project", projectScope: "helix" },
      { kind: "preference", text: "用户显式说过的话", source: "steward-turn" },
    ]);
    return store;
  }

  test("集成：AUTO_SOURCES 外原样保留 + 回写正确 + 分布交叉表", async () => {
    const store = seededStore();
    const judge = fakeJudge({ probs: { kind: 0.9, habit: 0.9 } });
    const report = await runBackfill({ store, judge });
    const rows = new Map(store.list().map((e) => [e.text, e]));
    // session-summary 偏好 → habit 确认（新值经单点落 global）
    expect(rows.get("用户要求答复用白话")).toMatchObject({ kind: "preference", domain: "habit", projectScope: "global" });
    // 范围钳制：progress / steward-turn 原样
    expect(rows.get("会话进展")).toMatchObject({ kind: "progress", domain: "project", projectScope: "helix" });
    expect(rows.get("用户显式说过的话")).toMatchObject({ kind: "preference", domain: "habit", projectScope: "global" });
    expect(report.status).toBe("done");
    expect(report.planned).toBe(3);
    expect(report.processed).toBe(3);
    expect(report.before.find((r) => r.source === "session-progress")).toBeDefined();
    expect(report.after.find((r) => r.source === "session-progress")).toBeDefined();
    store.close();
  });

  test("幂等：重跑已判跳过（判官零调用、数据零翻转）+ 新增条目增量判", async () => {
    const store = seededStore();
    await runBackfill({ store, judge: fakeJudge({ probs: { kind: 0.9, habit: 0.9 } }) });
    const afterFirst = snapshot(store);
    const judge2 = fakeJudge({ probs: { kind: 0.1, habit: 0.1 } });
    const report2 = await runBackfill({ store, judge: judge2 });
    expect(judge2.calls).toBeEmpty();
    expect(report2.processed).toBe(0);
    for (const [id, e] of afterFirst) {
      expect(store.list().find((x) => x.id === id)).toEqual(e);
    }
    // 新增一条 auto-sediment：增量只判新条目
    seed(store, [{ kind: "preference", text: "新增记忆点", source: "auto-sediment" }]);
    const judge3 = fakeJudge({ probs: { kind: 0.1, habit: 0.1 } });
    const report3 = await runBackfill({ store, judge: judge3 });
    expect(judge3.calls.length).toBe(3); // 一条 × 三问（kind/habit/project）
    expect(report3.processed).toBe(1);
    expect(store.list().find((e) => e.text === "新增记忆点")).toMatchObject({ kind: "fact", domain: "general" });
    store.close();
  });

  test("不动列：text/vector 元数据生命周期/source/created_at/updated_at 全保留", async () => {
    const store = seededStore();
    const before = snapshot(store);
    await runBackfill({ store, judge: fakeJudge({ probs: { kind: 0.1, habit: 0.1, project: 0.9 } }) });
    for (const [id, prev] of before) {
      const now = store.list().find((e) => e.id === id)!;
      expect({
        text: now.text,
        source: now.source,
        createdAt: now.createdAt,
        updatedAt: now.updatedAt,
        lastRecalledAt: now.lastRecalledAt,
        recallCount: now.recallCount,
        fadedAt: now.fadedAt,
        pinned: now.pinned,
      }).toEqual({
        text: prev.text,
        source: prev.source,
        createdAt: prev.createdAt,
        updatedAt: prev.updatedAt,
        lastRecalledAt: prev.lastRecalledAt,
        recallCount: prev.recallCount,
        fadedAt: prev.fadedAt,
        pinned: prev.pinned,
      });
    }
    store.close();
  });

  test("判官缺席（judge=null）→ aborted 整批放弃零写入零调用", async () => {
    const store = seededStore();
    const before = snapshot(store);
    const report = await runBackfill({ store, judge: null });
    expect(report.status).toBe("aborted");
    expect(report.processed).toBe(0);
    for (const [id, prev] of before) {
      expect(store.list().find((e) => e.id === id)).toEqual(prev);
    }
    store.close();
  });

  test("判官恒抛错 → 全部 skip 零写入（失败批次原子性）", async () => {
    const store = seededStore();
    const before = snapshot(store);
    const report = await runBackfill({ store, judge: fakeJudge({ alwaysFail: true }), options: { batchSize: 2 } });
    expect(report.processed).toBe(0);
    expect(report.skipped).toBe(3);
    for (const [id, prev] of before) {
      expect(store.list().find((e) => e.id === id)).toEqual(prev);
    }
    // 幂等标记零落（skipped 条目下次可重判）
    expect(store.readMetaIds(BACKFILL_CLASSIFY_MARKER).size).toBe(0);
    store.close();
  });

  test("批内部分失败：成功条回写、失败条跳过不标记", async () => {
    const store = seededStore();
    // 前 2 次调用失败 = 条1 的 kind 问两连败 → 条1 skip，其余条全成功
    let budget = 2;
    const judge: JudgePort = {
      async noul(_state, _question) {
        if (budget > 0) {
          budget -= 1;
          throw new Error("抖动");
        }
        return 0.9;
      },
      endpointLabel: () => "partial-fail",
    };
    const report = await runBackfill({ store, judge, options: { batchSize: 1 } });
    expect(report.processed).toBe(2);
    expect(report.skipped).toBe(1);
    expect(store.readMetaIds(BACKFILL_CLASSIFY_MARKER).size).toBe(2);
    store.close();
  });

  test("dryRun：判定照跑、库零变化", async () => {
    const store = seededStore();
    const before = snapshot(store);
    const report = await runBackfill({ store, judge: fakeJudge({ probs: { kind: 0.1, habit: 0.1 } }), options: { dryRun: true } });
    expect(report.processed).toBe(3);
    for (const [id, prev] of before) {
      expect(store.list().find((e) => e.id === id)).toEqual(prev);
    }
    expect(store.readMetaIds(BACKFILL_CLASSIFY_MARKER).size).toBe(0);
    store.close();
  });

  test("多命中项目名保守回落：general+global + warn 进报告", async () => {
    const store = makeStore();
    seed(store, [
      { kind: "preference", text: "helix 与 serena 共用 bun 工具链", source: "session-summary" },
    ]);
    const report = await runBackfill({
      store,
      judge: fakeJudge({ probs: { kind: 0.1, habit: 0.1, project: 0.95 } }),
      options: { projects: ["helix", "serena"] },
    });
    expect(store.list()[0]).toMatchObject({ domain: "general", projectScope: "global" });
    expect(report.warnings.length).toBe(1);
    store.close();
  });
});
