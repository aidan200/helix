import type { CodegraphEnginePort } from "../../src/application/ports/outbound/CodegraphEnginePort";
import type { IndexFreshness, SymbolSet } from "../../src/domain/kg/types";
import { EngineUnavailableError } from "../../src/adapters/driven/codegraph-engine/CodegraphEngineAdapter";

/**
 * CodegraphEngineFake —— CodegraphEnginePort 内存假实现（test/mocks，
 * T2.2 KgSyncService 去抖/单飞/degraded 编排及后续集成测试的公共基建，
 * test-design §5：可注入符号 fixture / 不可用态 / 延迟；调用记录可断言）。
 * 与生产 adapter 同接口不同实现，不进 src/。
 */

/** fake 注入面：默认空符号集（空索引合法态）+ 立即成功的 ensureIndex。 */
export interface CodegraphEngineFakeOptions {
  readonly symbols?: SymbolSet["symbols"];
  readonly containsEdges?: SymbolSet["containsEdges"];
  readonly files?: SymbolSet["files"];
  /** true：两方法均抛 EngineUnavailableError（degraded 路径输入）。 */
  readonly unavailable?: boolean;
  /** 方法调用人工延迟 ms（去抖窗口/单飞合并等待的时序测试面）。 */
  readonly delayMs?: number;
  /** ensureIndex 返回注入（缺省：已初始化 + sync 增量的健康态）。 */
  readonly ensureResult?: IndexFreshness;
}

/** 调用记录（T2.2 断言 sync 编排触发面）。 */
export interface EngineCallRecord {
  readonly method: "ensureIndex" | "exportSymbols";
  readonly projectRoot: string;
}

export class CodegraphEngineFake implements CodegraphEnginePort {
  readonly calls: EngineCallRecord[] = [];

  private readonly fixture: SymbolSet;
  private readonly unavailable: boolean;
  private readonly delayMs: number;
  private readonly ensureResult: IndexFreshness;

  constructor(opts: CodegraphEngineFakeOptions = {}) {
    this.fixture = {
      symbols: opts.symbols ?? [],
      containsEdges: opts.containsEdges ?? [],
      files: opts.files ?? [],
    };
    this.unavailable = opts.unavailable ?? false;
    this.delayMs = opts.delayMs ?? 0;
    this.ensureResult = opts.ensureResult ?? { initialized: true, mode: "sync", lastIndexed: null };
  }

  async ensureIndex(projectRoot: string): Promise<IndexFreshness> {
    this.calls.push({ method: "ensureIndex", projectRoot });
    await this.settle();
    this.assertNotUnavailable();
    return this.ensureResult;
  }

  async exportSymbols(projectRoot: string): Promise<SymbolSet> {
    this.calls.push({ method: "exportSymbols", projectRoot });
    await this.settle();
    this.assertNotUnavailable();
    return this.fixture;
  }

  private async settle(): Promise<void> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  private assertNotUnavailable(): void {
    if (this.unavailable) {
      throw new EngineUnavailableError("fake 注入：引擎不可用（degraded 路径）");
    }
  }
}
