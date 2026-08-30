import { afterEach, describe, expect, test } from "bun:test";
import type { KnowledgeGraphPort } from "../../src/application/ports/outbound/KnowledgeGraphPort";
import type { KnowledgeStorePort } from "../../src/application/ports/outbound/KnowledgeStorePort";
import { KgSyncService } from "../../src/application/services/kg/KgSyncService";
import type {
  AttachmentSnapshot,
  ChangeLogEntry,
  IndexStatus,
  NodeDetail,
  NodeDigestRow,
  SymbolBatch,
  SyncBaselineView,
  VerifyView,
} from "../../src/domain/kg/types";
import { CodegraphEngineFake } from "../mocks/CodegraphEngineFake";

/**
 * KgSyncService 单测（AD-15 触发与并发模型，CL-2.A5/§六）：
 * 双源汇队列 去重 → 去抖 → 单飞 → 四步编排。
 * 内存 fake store/graph + T2.1 引擎 fake——零真库零真 watch（I 层覆盖）。
 */

const ROOT = "/tmp/unit-kg-sync";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待条件成立（固定 sleep 的确定性替代，避免慢机时序竞态 flaky）。 */
async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await sleep(stepMs);
  }
}

/** 并发审计 fake store：applySync 重入即抛（「至多一个写事务」机械断言）。 */
class AuditStore implements KnowledgeStorePort {
  readonly batches: SymbolBatch[] = [];
  private active = 0;
  maxActive = 0;
  failFirst = 0;

  writeKnowledge(): never {
    throw new Error("writeKnowledge 不在 sync 单测面");
  }

  async applySync(projectRoot: string, batch: SymbolBatch): Promise<void> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    if (this.maxActive > 1) throw new Error("并发写事务违规（单飞互斥被破坏）");
    try {
      await sleep(2); // 制造异步窗口暴露并发
      if (this.failFirst > 0) {
        this.failFirst -= 1;
        throw new Error("注入故障：applySync 失败");
      }
      this.batches.push(batch);
    } finally {
      this.active -= 1;
    }
  }

  purgeAll(): never {
    throw new Error("purgeAll 不在 sync 单测面");
  }

  resetIndexFace(): never {
    throw new Error("resetIndexFace 不在 sync 单测面");
  }
}

/** 可编程基准读面 fake（degraded/增量序列测试注入点）。 */
class StubGraph implements KnowledgeGraphPort {
  view: SyncBaselineView = { files: [], symbols: [], activeAnchors: [], anchorDeclarations: [] };
  status: IndexStatus = { baseline: null, symbolCount: 0, degraded: false };

  listNodeIdsByOriginBatches(): readonly string[] {
    return []; // T2.2 F2.7 反查面：sync 测试不消费
  }

  countActiveNodes(): number {
    return 0; // T3.2 准入口径面：sync 测试不消费
  }

  countActiveLayeredNodes(): number {
    return 0; // O-9 精化口径面：sync 测试不消费
  }

  getSyncBaseline(): SyncBaselineView {
    return this.view;
  }

  getVerifyView(): VerifyView {
    return { nodes: [], edges: [], anchors: [], anchorDeclarations: [], files: [] };
  }

  getChangeLog(): readonly ChangeLogEntry[] {
    return [];
  }

  getIndexStatus(): IndexStatus {
    return this.status;
  }

  getAttachmentSnapshot(): AttachmentSnapshot {
    return { nodes: [], fileAnchors: [], symbolAnchors: [], contains: [] };
  }

  search(): readonly NodeDigestRow[] {
    return [];
  }

  getNode(): NodeDetail | null {
    return null;
  }

  countNodes(): number {
    return 0;
  }

  latestIteration(): string | null {
    return null;
  }
}

function makeService(opts: {
  debounceMs?: number;
  engine?: CodegraphEngineFake;
  store?: AuditStore;
  graph?: StubGraph;
  retryBackoffMs?: number;
} = {}): { service: KgSyncService; store: AuditStore; graph: StubGraph; engine: CodegraphEngineFake } {
  const store = opts.store ?? new AuditStore();
  const graph = opts.graph ?? new StubGraph();
  const engine =
    opts.engine ??
    new CodegraphEngineFake({
      files: [{ path: "src/a.ts", contentHash: "h1", modifiedAt: 100, indexedAt: 100 }],
      symbols: [],
    });
  const service = new KgSyncService({
    store,
    graph,
    engine,
    debounceMs: opts.debounceMs ?? 12,
    retryBackoffMs: opts.retryBackoffMs ?? 5,
  });
  return { service, store, graph, engine };
}

const active: KgSyncService[] = [];
afterEach(() => {
  for (const s of active) s.dispose();
  active.length = 0;
});

describe("KgSyncService：双源汇队列去重（CL-2.A5）", () => {
  test("① 写后通知 + watch 同 双事件 → 单次 sync 且批含该文件一次", async () => {
    const { service, store } = makeService();
    active.push(service);
    service.notifyWrite(ROOT, `${ROOT}/src/a.ts`, "hash-a1");
    service.onFsEvent(ROOT, `${ROOT}/src/a.ts`, "write"); // watch 兜底同文件
    await sleep(60);
    expect(store.batches.length).toBe(1);
    expect(store.batches[0]!.files.map((f) => f.path)).toEqual(["src/a.ts"]);
  });

  test("② 同文件多次写（hash 演进）→ 队列键=path 覆盖旧 hash，窗口内单次处理", async () => {
    const { service, store } = makeService();
    active.push(service);
    service.notifyWrite(ROOT, `${ROOT}/src/a.ts`, "hash-1");
    service.notifyWrite(ROOT, `${ROOT}/src/a.ts`, "hash-2");
    await sleep(60);
    expect(store.batches.length).toBe(1);
    expect(store.batches[0]!.files.length).toBe(1);
  });

  test("③ watch remove 事件入删除集：sync 后 batch.deletedFiles 含该文件", async () => {
    const { service, store, graph } = makeService();
    active.push(service);
    graph.view = {
      files: [{ path: "src/gone.ts", mtime: 1, sha256: "x" }],
      symbols: [],
      activeAnchors: [],
      anchorDeclarations: [],
    };
    service.onFsEvent(ROOT, `${ROOT}/src/gone.ts`, "remove");
    await sleep(60);
    expect(store.batches.length).toBe(1);
    expect(store.batches[0]!.deletedFiles).toEqual(["src/gone.ts"]);
    expect(store.batches[0]!.files).toEqual([]); // 引擎面无此文件 → 不导入
  });
});

describe("KgSyncService：去抖窗口批量合并", () => {
  test("④ 窗口内 3 文件事件 → 一次 sync 且批含 3 文件", async () => {
    const { service, store, engine } = makeService();
    active.push(service);
    engine.setSymbols({
      files: [
        { path: "src/a.ts", contentHash: "ha", modifiedAt: 1, indexedAt: 1 },
        { path: "src/b.ts", contentHash: "hb", modifiedAt: 1, indexedAt: 1 },
        { path: "src/c.ts", contentHash: "hc", modifiedAt: 1, indexedAt: 1 },
      ],
      symbols: [],
      containsEdges: [],
    });
    service.notifyWrite(ROOT, `${ROOT}/src/a.ts`, "ha");
    service.notifyWrite(ROOT, `${ROOT}/src/b.ts`, "hb");
    service.onFsEvent(ROOT, `${ROOT}/src/c.ts`, "write");
    await sleep(80);
    expect(store.batches.length).toBe(1);
    expect(store.batches[0]!.files.map((f) => f.path).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  test("⑤ 窗口结束后新事件 → 新窗口新 sync（去抖只合并窗口内事件）", async () => {
    const { service, store } = makeService();
    active.push(service);
    service.notifyWrite(ROOT, `${ROOT}/src/a.ts`, "ha");
    await sleep(60);
    service.notifyWrite(ROOT, `${ROOT}/src/a.ts`, "ha2");
    await sleep(60);
    expect(store.batches.length).toBe(2);
  });
});

describe("KgSyncService：单飞互斥（AD-15）", () => {
  test("⑥ running 中新触发 → pending 合并重跑（不丢弃），无并发事务", async () => {
    const engine = new CodegraphEngineFake({
      delayMs: 50, // 拖长第一次 sync，制造 running 窗口
      files: [{ path: "src/a.ts", contentHash: "h1", modifiedAt: 100, indexedAt: 100 }],
      symbols: [],
    });
    const { service, store } = makeService({ engine });
    active.push(service);
    service.notifyWrite(ROOT, `${ROOT}/src/a.ts`, "h1"); // 窗口 12ms 后开跑
    // 轮询至第一次 sync 确实 running（固定 sleep 在慢机上可能早于开跑或已过窗，时序竞态源）
    await waitFor(() => service.getStatus(ROOT).phase === "building");
    service.notifyWrite(ROOT, `${ROOT}/src/a.ts`, "h1"); // running 中新事件
    // 轮询至第一次 + 合并重跑全部落库（不再假设 200ms 内完成）
    await waitFor(() => store.batches.length === 2);
    await waitFor(() => service.getStatus(ROOT).phase !== "building");
    expect(store.batches.length).toBe(2); // 第一次 + 合并重跑
    expect(store.maxActive).toBe(1); // 任意时刻至多一个写事务（审计断言）
  });

  test("⑦ 手动触发合并等待：running 中 triggerManual 返回重跑结果", async () => {
    const engine = new CodegraphEngineFake({
      delayMs: 50,
      files: [{ path: "src/a.ts", contentHash: "h1", modifiedAt: 100, indexedAt: 100 }],
      symbols: [],
    });
    const { service, store } = makeService({ engine });
    active.push(service);
    const first = service.triggerManual(ROOT);
    await sleep(20); // running 中
    const merged = service.triggerManual(ROOT); // 合并等待
    const [firstResult, mergedResult] = await Promise.all([first, merged]);
    expect(firstResult.baseline).not.toBe(mergedResult.baseline); // 两次独立 sync，基准戳推进
    expect(store.batches.length).toBe(2);
    expect(store.maxActive).toBe(1);
  });

  test("⑧ applySync 失败 → 退避重试成功且失败计数清零（F-21 结构参数）", async () => {
    const { service, store } = makeService();
    active.push(service);
    store.failFirst = 1;
    await expect(service.triggerManual(ROOT)).rejects.toThrow("注入故障");
    await sleep(60); // retryBackoffMs=5 → 自动退避重试很快发生
    expect(store.batches.length).toBe(1); // 重试成功落库，窗口未丢
    await service.triggerManual(ROOT); // 服务仍可用（failCount 已清零）
    expect(store.batches.length).toBe(2);
  });
});

describe("KgSyncService：四步编排与状态面", () => {
  test("⑨ 引擎不可用 → degraded 批（EngineUnavailable 捕获；docs-only 物化：path 锚物化/symbol 锚跳过）", async () => {
    const engine = new CodegraphEngineFake({ unavailable: true });
    const { service, store, graph } = makeService({ engine });
    active.push(service);
    graph.view = {
      files: [{ path: "src/a.ts", mtime: 5, sha256: "prev" }],
      symbols: [],
      activeAnchors: [],
      anchorDeclarations: [
        { nodeId: "TR-1", scopeKind: "path", pattern: "src/**" },
        { nodeId: "E-1", scopeKind: "symbol", pattern: "src/a.ts#Handler" },
      ],
    };
    const result = await service.triggerManual(ROOT);
    expect(result.degraded).toBe(true);
    expect(store.batches[0]!.degraded).toBe(true);
    // docs-only：path 声明 × 上一基准文件面物化；symbol 声明零锚
    expect(store.batches[0]!.materializedAnchors).toEqual([
      { nodeId: "TR-1", anchorPath: "src/a.ts", anchorSymbol: null, anchorKind: "path" },
    ]);
    // degraded 不清符号层（滞后合法）：无导入无删除
    expect(store.batches[0]!.files).toEqual([]);
    expect(store.batches[0]!.deletedFiles).toEqual([]);
  });

  test("⑩ 基准戳单调推进；getStatus 四态（absent→building→synced）", async () => {
    const { service, graph } = makeService();
    active.push(service);
    expect(service.getStatus(ROOT).phase).toBe("absent");
    const r1 = await service.triggerManual(ROOT);
    const r2 = await service.triggerManual(ROOT);
    expect(Number(r2.baseline)).toBeGreaterThan(Number(r1.baseline));
    graph.status = { baseline: r2.baseline, symbolCount: 3, degraded: false };
    expect(service.getStatus(ROOT).phase).toBe("synced");
    graph.status = { baseline: r2.baseline, symbolCount: 3, degraded: true };
    expect(service.getStatus(ROOT).phase).toBe("degraded");
  });

  test("⑪ mtime/hash 未变文件跳过导入（增量基准对比）", async () => {
    const { service, store, graph } = makeService();
    active.push(service);
    graph.view = {
      files: [{ path: "src/a.ts", mtime: 100, sha256: "h1" }], // 与引擎面完全一致
      symbols: [],
      activeAnchors: [],
      anchorDeclarations: [],
    };
    const result = await service.triggerManual(ROOT);
    expect(result.importedFiles).toBe(0); // 全量域内 mtime/hash 未变 → 跳过
    expect(store.batches[0]!.files).toEqual([]);
  });
});
