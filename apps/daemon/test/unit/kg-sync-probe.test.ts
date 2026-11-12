/**
 * KgSyncService 停排自愈批（kg 韧性批配套）：
 *
 * 事故形态（2026-11-12）：ex-sad kg 连接坏态期间 sync 连续失败 77 次——
 * 现状 failCount 超 5 次即停排自动重试（仅 warn 留痕），之后只能等外部
 * 触发；连接坏态不 evict 时外部触发也全失败，停排即永久。修复两件：
 * 1. 失败为 IOERR → onIoError 回调（组合根接 KgDatabase.evict）——退避
 *    重试的下一次自动懒开新连接，自愈闭环；
 * 2. 停排后排低频探测（probeAfterStopMs，缺省 30min）——恢复即成功路径
 *    清零 failCount，回到正常退避排程；不再永久停摆。
 */
import { describe, test, expect, afterEach } from "bun:test";
import { KgSyncService } from "../../src/application/services/kg/KgSyncService";
import type { KnowledgeGraphPort } from "../../src/application/ports/outbound/KnowledgeGraphPort";

const ROOT = "/w/projA";
const ioErr = (): Error => Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Harness {
  sync: KgSyncService;
  warns: string[];
  evicted: string[];
  baselineCalls: { count: number };
  synced: string[];
  setBaseline(action: "ioerr" | "ok"): void;
}

function makeSync(overrides?: { probeAfterStopMs?: number }): Harness {
  const warns: string[] = [];
  const evicted: string[] = [];
  const synced: string[] = [];
  const baselineCalls = { count: 0 };
  let baselineAction: "ioerr" | "ok" = "ioerr";
  const graph = {
    getSyncBaseline: () => {
      baselineCalls.count += 1;
      if (baselineAction === "ioerr") throw ioErr();
      // 成功形状：syncOnce 成功路径消费的深字段全供（空集——materialize/relocate 空转）
      return { baseline: "b1", files: [], anchorDeclarations: [], activeAnchors: [], orphanedAnchors: [], symbols: [] };
    },
    getIndexStatus: () => ({ baseline: "b1", symbolCount: 0, degraded: false }),
  } as unknown as KnowledgeGraphPort;
  const sync = new KgSyncService({
    store: { applySync: async () => {} } as never,
    graph,
    engine: {
      ensureIndex: async () => {},
      exportSymbols: async () => ({ symbols: [], containsEdges: [], files: [] }),
    } as never,
    onSynced: (root: string) => synced.push(root),
    onIoError: (root: string) => evicted.push(root),
    logger: { warn: (m: string) => warns.push(m) },
    debounceMs: 1,
    retryBackoffMs: 1,
    probeAfterStopMs: overrides?.probeAfterStopMs ?? 15,
  });
  return {
    sync,
    warns,
    evicted,
    baselineCalls,
    synced,
    setBaseline: (action) => {
      baselineAction = action;
    },
  };
}

afterEach(() => {
  // 各用例自 dispose；兜底再清全量（幂等）
});

describe("KgSyncService IOERR 自愈与停排探测", () => {
  test("失败为 IOERR → onIoError 被调（组合根接 evict——重试自动换新连接）", async () => {
    const h = makeSync();
    await h.sync.triggerManual(ROOT).catch(() => {});
    expect(h.evicted.length).toBeGreaterThanOrEqual(1);
    expect(h.evicted[0]).toBe(ROOT);
    h.sync.dispose();
  });

  test("超限停排后按探测间隔重排（不永久停摆）：探测持续触发重试，恢复成功即回正常排程", async () => {
    const h = makeSync();
    try {
      // 阶段一：连续失败至停排（退避 5 次后第 6 次停排 + 排探测）
      await h.sync.triggerManual(ROOT).catch(() => {});
      await sleep(120); // 退避链（1+2+4+8+16ms）+ 探测（15ms）若干轮全部走完
      expect(h.warns.some((w) => w.includes("停排"))).toBe(true);
      const callsAfterStop = h.baselineCalls.count;
      expect(callsAfterStop).toBeGreaterThanOrEqual(7); // 停排后探测仍在触发（非永久停摆）

      // 阶段二：故障恢复 → 下次探测成功 → failCount 清零（onSynced 回调 + syncedAt 推进）
      h.setBaseline("ok");
      await sleep(40);
      expect(h.synced.length).toBeGreaterThanOrEqual(1);

      // 阶段三：恢复后再失败一次 → 走退避（failCount=1 ≤ 上限），不新增停排 warn
      const stopWarnsBefore = h.warns.filter((w) => w.includes("停排")).length;
      h.setBaseline("ioerr");
      await h.sync.triggerManual(ROOT).catch(() => {});
      await sleep(10);
      expect(h.warns.filter((w) => w.includes("停排")).length).toBe(stopWarnsBefore);
    } finally {
      h.sync.dispose();
    }
  });

  test("dispose 清探测 timer——停排后 dispose 不残留定时器（无迟触发）", async () => {
    const h = makeSync({ probeAfterStopMs: 25 });
    await h.sync.triggerManual(ROOT).catch(() => {});
    await sleep(120); // 到达停排 + 探测已排
    const calls = h.baselineCalls.count;
    h.sync.dispose();
    await sleep(40);
    expect(h.baselineCalls.count).toBe(calls); // dispose 后零新调用
  });
});
