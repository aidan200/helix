import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { KnowledgeGraphPort } from "../../src/application/ports/outbound/KnowledgeGraphPort";
import type { KnowledgeStorePort } from "../../src/application/ports/outbound/KnowledgeStorePort";
import type { FsWatchEvent, FsWatchPort } from "../../src/application/ports/outbound/FsWatchPort";
import {
  FS_WATCH_IGNORED_SEGMENTS,
  isIgnoredWatchRelPath,
  isIgnoredWatchSegment,
  KgFsWatchService,
} from "../../src/application/services/kg/KgFsWatchService";
import { KgSyncService } from "../../src/application/services/kg/KgSyncService";
import { FsWatchAdapter } from "../../src/adapters/driven/fs-watch/FsWatchAdapter";
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
 * KgFsWatchService / FsWatchAdapter 单测（B3 fs-watch 重新挂接）：
 * - ignore 面纯逻辑（.helix-kg/.codegraph/node_modules/.git/dist 段级命中）；
 * - 事件 → onFsEvent → 去抖 → sync 链路（fake watcher + 真 KgSyncService）；
 * - 索引建成（onSynced）→ watcher 挂接；
 * - 自激励防护（真 fs：sync 产物目录写入不回流）——死循环防护必测；
 * - watcher 生命周期（幂等挂接/stopWatching 接缝/dispose 全停）；
 * - Bun runtime fs.watch 实测（真 tmp 目录 recursive）+ Linux 目录分层兜底
 *   （platform 注入强制走兜底分支）。
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待条件成立（固定 sleep 的确定性替代，避免慢机时序竞态 flaky）。 */
async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await sleep(stepMs);
  }
}

const ROOT = "/tmp/unit-kg-fs-watch";

// ── fake / stub 基建 ────────────────────────────────────────

/** 事件剧本 + 生命周期计数的 fake 监控端口（纯内存，零真 fs）。 */
class FakeWatchPort implements FsWatchPort {
  readonly watched: string[] = [];
  readonly closed: string[] = [];
  failOnWatch = false;
  private readonly handlers = new Map<string, (e: FsWatchEvent) => void>();

  watch(root: string, onEvent: (e: FsWatchEvent) => void): { close(): void } {
    if (this.failOnWatch) throw new Error("注入故障：watch 建立失败");
    this.watched.push(root);
    this.handlers.set(root, onEvent);
    return {
      close: () => {
        this.closed.push(root);
        this.handlers.delete(root);
      },
    };
  }

  emit(root: string, eventPath: string, kind: FsWatchEvent["kind"]): void {
    this.handlers.get(root)?.({ path: eventPath, kind });
  }
}

/** onFsEvent 记录间谍（KgFsWatchService 的 sync 结构面子集）。 */
class SyncSpy {
  readonly events: { root: string; path: string; kind: string }[] = [];
  onFsEvent(root: string, p: string, kind: "write" | "remove"): void {
    this.events.push({ root, path: p, kind });
  }
}

/** sync 批记录 store（链路测试断言面）。 */
class MemStore implements KnowledgeStorePort {
  readonly batches: SymbolBatch[] = [];

  writeKnowledge(): never {
    throw new Error("writeKnowledge 不在 fs-watch 测试面");
  }

  async applySync(_projectRoot: string, batch: SymbolBatch): Promise<void> {
    this.batches.push(batch);
  }

  purgeAll(): never {
    throw new Error("purgeAll 不在 fs-watch 测试面");
  }

  resetIndexFace(): never {
    throw new Error("resetIndexFace 不在 fs-watch 测试面");
  }
}

/** 可编程基准读面 stub（与 kg-sync-service.test.ts 同形）。 */
class StubGraph implements KnowledgeGraphPort {
  view: SyncBaselineView = { files: [], symbols: [], activeAnchors: [], anchorDeclarations: [] };
  status: IndexStatus = { baseline: null, symbolCount: 0, degraded: false };

  listNodeIdsByOriginBatches(): readonly string[] {
    return [];
  }

  countActiveNodes(): number {
    return 0;
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

// ── 测试清理注册表 ──────────────────────────────────────────

const activeSyncs: KgSyncService[] = [];
const activeWatches: KgFsWatchService[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  for (const w of activeWatches) w.dispose();
  activeWatches.length = 0;
  for (const s of activeSyncs) s.dispose();
  activeSyncs.length = 0;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function makeTmpProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "kg-fs-watch-"));
  tmpDirs.push(dir);
  return dir;
}

// ── ① ignore 面（纯逻辑） ───────────────────────────────────

describe("KgFsWatchService：ignore 面（自激励防护清单）", () => {
  test("① 忽略清单覆盖 .helix-kg/.codegraph/node_modules/.git/dist", () => {
    for (const seg of [".helix-kg", ".codegraph", "node_modules", ".git", "dist"]) {
      expect(FS_WATCH_IGNORED_SEGMENTS).toContain(seg);
      expect(isIgnoredWatchSegment(seg)).toBe(true);
    }
  });

  test("② 忽略段命中：根级/嵌套级均忽略；形似段（dist-util）不误伤", () => {
    expect(isIgnoredWatchRelPath(".helix-kg/kg.db")).toBe(true); // sync 写库产物
    expect(isIgnoredWatchRelPath(".codegraph/codegraph.db")).toBe(true); // 引擎索引产物
    expect(isIgnoredWatchRelPath("node_modules/pkg/index.js")).toBe(true);
    expect(isIgnoredWatchRelPath(".git/HEAD")).toBe(true);
    expect(isIgnoredWatchRelPath("dist/bundle.js")).toBe(true);
    expect(isIgnoredWatchRelPath("src/.helix-kg/tmp")).toBe(true); // 嵌套命中
    expect(isIgnoredWatchRelPath("packages/a/dist/out.js")).toBe(true); // 嵌套命中
    expect(isIgnoredWatchRelPath("src/a.ts")).toBe(false);
    expect(isIgnoredWatchRelPath("src/dist-util/a.ts")).toBe(false); // 段级精确匹配
    expect(isIgnoredWatchRelPath("docs/distro.md")).toBe(false);
  });
});

// ── ② 事件 → 去抖 → sync 链路（fake watcher + 真 KgSyncService） ──

describe("KgFsWatchService：事件 → onFsEvent → 去抖 → sync 链路", () => {
  function makeChain(opts: { onSynced?: (root: string) => void } = {}): {
    watcher: FakeWatchPort;
    store: MemStore;
    engine: CodegraphEngineFake;
    sync: KgSyncService;
    fsWatch: KgFsWatchService;
  } {
    const watcher = new FakeWatchPort();
    const store = new MemStore();
    const graph = new StubGraph();
    const engine = new CodegraphEngineFake({
      files: [{ path: "src/a.ts", contentHash: "h1", modifiedAt: 100, indexedAt: 100 }],
      symbols: [],
    });
    const sync = new KgSyncService({
      store,
      graph,
      engine,
      debounceMs: 12,
      retryBackoffMs: 5,
      ...(opts.onSynced !== undefined ? { onSynced: opts.onSynced } : {}),
    });
    const fsWatch = new KgFsWatchService({ sync, watcher });
    activeSyncs.push(sync);
    activeWatches.push(fsWatch);
    return { watcher, store, engine, sync, fsWatch };
  }

  test("③ watcher 事件喂 onFsEvent：忽略路径不喂，源文件 write/remove 透传", () => {
    const fake = new FakeWatchPort();
    const spy = new SyncSpy();
    const svc = new KgFsWatchService({ sync: spy, watcher: fake });
    activeWatches.push(svc);
    svc.watchProject(ROOT);
    fake.emit(ROOT, `${ROOT}/.helix-kg/kg.db`, "write"); // 自激励产物 → 过滤
    fake.emit(ROOT, `${ROOT}/.codegraph/codegraph.db`, "write");
    fake.emit(ROOT, `${ROOT}/node_modules/pkg/index.js`, "write");
    fake.emit(ROOT, `${ROOT}/src/a.ts`, "write");
    fake.emit(ROOT, `${ROOT}/src/gone.ts`, "remove");
    expect(spy.events).toEqual([
      { root: ROOT, path: `${ROOT}/src/a.ts`, kind: "write" },
      { root: ROOT, path: `${ROOT}/src/gone.ts`, kind: "remove" },
    ]);
  });

  test("④ 索引建成（onSynced）→ watcher 挂接；改源文件 → 去抖后 sync 触发", async () => {
    let chain!: ReturnType<typeof makeChain>;
    chain = makeChain({ onSynced: (root) => chain.fsWatch.watchProject(root) });
    const { watcher, store, engine, sync, fsWatch } = chain;
    // 挂接前：未监控
    expect(fsWatch.isWatching(ROOT)).toBe(false);
    // 索引建成（首建 sync 成功）→ onSynced 钩子挂接 watcher
    await sync.triggerManual(ROOT);
    expect(fsWatch.isWatching(ROOT)).toBe(true);
    expect(watcher.watched).toEqual([ROOT]);
    expect(store.batches.length).toBe(1); // 首建批

    // 改源文件（hash 演进）→ watcher 事件 → 去抖 → 新 sync 批含该文件
    engine.setSymbols({
      files: [{ path: "src/a.ts", contentHash: "h2", modifiedAt: 200, indexedAt: 200 }],
      symbols: [],
      containsEdges: [],
    });
    watcher.emit(ROOT, `${ROOT}/src/a.ts`, "write");
    await waitFor(() => store.batches.length === 2);
    const batch = store.batches[1]!;
    expect(batch.files.map((f) => f.path)).toContain("src/a.ts");
    expect(batch.files[0]!.sha256).toBe("h2"); // 变更文件被重新导入
  });

  test("⑤ sync 写库产物事件（.helix-kg）不触发新 sync（自激励防护·fake 面）", async () => {
    const { watcher, store, fsWatch } = makeChain();
    fsWatch.watchProject(ROOT);
    watcher.emit(ROOT, `${ROOT}/.helix-kg/kg.db`, "write");
    watcher.emit(ROOT, `${ROOT}/.helix-kg/kg.db-wal`, "write");
    await sleep(80); // 超过去抖窗（12ms）仍零批 = 事件未进队列
    expect(store.batches.length).toBe(0);
  });
});

// ── ③ 生命周期 ──────────────────────────────────────────────

describe("KgFsWatchService：watcher 生命周期", () => {
  test("⑥ watchProject 幂等；stopWatching 接缝关闭单项目；dispose 全停", () => {
    const watcher = new FakeWatchPort();
    const svc = new KgFsWatchService({ sync: new SyncSpy(), watcher });
    activeWatches.push(svc);
    expect(svc.watchProject(ROOT)).toBe(true);
    expect(svc.watchProject(ROOT)).toBe(true); // 幂等 no-op
    expect(watcher.watched).toEqual([ROOT]);

    svc.watchProject(`${ROOT}-b`);
    expect(watcher.watched).toEqual([ROOT, `${ROOT}-b`]);

    svc.stopWatching(ROOT); // index-delete 消费接缝
    expect(svc.isWatching(ROOT)).toBe(false);
    expect(svc.isWatching(`${ROOT}-b`)).toBe(true);
    expect(watcher.closed).toEqual([ROOT]);
    svc.stopWatching(ROOT); // 未挂 no-op 不抛

    expect(svc.watchProject(ROOT)).toBe(true); // stop 后可重挂
    svc.dispose();
    expect(svc.isWatching(ROOT)).toBe(false);
    expect(svc.isWatching(`${ROOT}-b`)).toBe(false);
    expect(watcher.closed.length).toBe(3);
    svc.dispose(); // 幂等
  });

  test("⑦ watch 建立失败不抛：warn 留痕返回 false，主链路不阻断", () => {
    const watcher = new FakeWatchPort();
    watcher.failOnWatch = true;
    const warnings: string[] = [];
    const svc = new KgFsWatchService({
      sync: new SyncSpy(),
      watcher,
      logger: { info: () => {}, warn: (m) => warnings.push(m) },
    });
    activeWatches.push(svc);
    expect(svc.watchProject(ROOT)).toBe(false);
    expect(svc.isWatching(ROOT)).toBe(false);
    expect(warnings.length).toBe(1);
  });
});

// ── ④ 真 fs：Bun fs.watch 实测 + 自激励防护 ──────────────────

describe("FsWatchAdapter：真 fs（Bun runtime fs.watch 实测）", () => {
  function makeRealWatch(platform?: string): { svc: KgFsWatchService; spy: SyncSpy; root: string } {
    const root = makeTmpProject();
    const spy = new SyncSpy();
    const svc = new KgFsWatchService({
      sync: spy,
      watcher: new FsWatchAdapter({
        isIgnoredSegment: isIgnoredWatchSegment,
        ...(platform !== undefined ? { platform } : {}),
      }),
    });
    activeWatches.push(svc);
    return { svc, spy, root };
  }

  /** 预建全部目录（含忽略面）后再挂 watch——避免建目录事件干扰断言。 */
  function seedProject(root: string): void {
    for (const dir of ["src", ".helix-kg", ".codegraph", "node_modules/pkg", ".git", "dist"]) {
      mkdirSync(path.join(root, dir), { recursive: true });
    }
  }

  test("⑧ 自激励防护（真 fs）：sync/引擎产物目录写入零事件回流；源文件 write/remove 正常", async () => {
    const { svc, spy, root } = makeRealWatch();
    seedProject(root);
    expect(svc.watchProject(root)).toBe(true);
    await sleep(400); // FSEvents 启动窗口：pre-watch 建目录事件迟到送达（合法目录事件）
    spy.events.length = 0; // 清零基线——本用例负断言面只看 watch 稳定后的产物写入

    // sync 写 .helix-kg/kg.db、引擎写 .codegraph/codegraph.db + 噪声面
    writeFileSync(path.join(root, ".helix-kg", "kg.db"), "db");
    writeFileSync(path.join(root, ".codegraph", "codegraph.db"), "idx");
    writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "m");
    writeFileSync(path.join(root, ".git", "HEAD"), "ref");
    writeFileSync(path.join(root, "dist", "bundle.js"), "b");
    await sleep(800); // fs 事件窗口（FSEvents 合并延迟兜底）
    expect(spy.events).toEqual([]); // 死循环防护：产物写入零回流

    // 源文件变更正常透传
    writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;");
    await waitFor(() => spy.events.some((e) => e.path.endsWith(path.join("src", "a.ts")) && e.kind === "write"));
    rmSync(path.join(root, "src", "a.ts"));
    await waitFor(() => spy.events.some((e) => e.path.endsWith(path.join("src", "a.ts")) && e.kind === "remove"));
  }, 15000);

  test("⑨ stopWatching 后真 fs 事件不再送达（生命周期真面）", async () => {
    const { svc, spy, root } = makeRealWatch();
    seedProject(root);
    svc.watchProject(root);
    await sleep(400); // FSEvents recursive 启动窗口（启动瞬间事件可能丢失——兜底信号面特性）
    writeFileSync(path.join(root, "src", "a.ts"), "v1");
    await waitFor(() => spy.events.length > 0);
    svc.stopWatching(root);
    const seen = spy.events.length;
    writeFileSync(path.join(root, "src", "b.ts"), "v2");
    await sleep(600);
    expect(spy.events.length).toBe(seen);
  }, 15000);

  test("⑩ Linux 兜底（目录分层，platform 注入）：既有子目录/新增目录/忽略不下钻", async () => {
    const { svc, spy, root } = makeRealWatch("linux"); // 强制走目录分层分支
    seedProject(root);
    mkdirSync(path.join(root, "src", "nested"), { recursive: true });
    expect(svc.watchProject(root)).toBe(true);

    // 既有嵌套子目录事件
    writeFileSync(path.join(root, "src", "nested", "deep.ts"), "d");
    await waitFor(() => spy.events.some((e) => e.path.endsWith(path.join("src", "nested", "deep.ts"))));

    // 新增目录增量补挂（mkdir 后留补挂窗口再写）
    mkdirSync(path.join(root, "src", "fresh"));
    await sleep(200);
    writeFileSync(path.join(root, "src", "fresh", "new.ts"), "n");
    await waitFor(() => spy.events.some((e) => e.path.endsWith(path.join("src", "fresh", "new.ts"))));

    // 忽略段不下钻：产物目录源头无 watcher，事件根本不产生
    writeFileSync(path.join(root, ".helix-kg", "kg.db"), "db");
    await sleep(500);
    expect(spy.events.filter((e) => e.path.includes(".helix-kg"))).toEqual([]);
  }, 15000);
});
