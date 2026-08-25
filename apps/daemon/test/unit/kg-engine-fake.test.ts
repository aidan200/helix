import { describe, expect, test } from "bun:test";
import { CodegraphEngineFake } from "../mocks/CodegraphEngineFake";
import { EngineUnavailableError } from "../../src/adapters/driven/codegraph-engine/CodegraphEngineAdapter";
import type { EngineSymbol } from "../../src/domain/kg/types";

/**
 * T2.1（U 层）：CodegraphEnginePort 内存 fake 可用性——T2.2（KgSyncService
 * 去抖/单飞/degraded 编排）及后续集成测试的公共基建（test-design §5）：
 * 可注入符号 fixture / 不可用态 / 延迟；调用记录可断言。
 */

const SYMBOL: EngineSymbol = {
  id: "class:aaa",
  kind: "class",
  name: "Greeter",
  qualifiedName: "Greeter",
  filePath: "src/app.ts",
  language: "typescript",
  signature: null,
  startLine: 1,
  endLine: 20,
  startColumn: 0,
  endColumn: 1,
};

describe("CodegraphEngineFake（引擎测试基建）", () => {
  test("① fixture 注入：exportSymbols 原样返回注入的符号集", async () => {
    const fake = new CodegraphEngineFake({
      symbols: [SYMBOL],
      containsEdges: [{ containerId: "file:src/app.ts", symbolId: "class:aaa" }],
      files: [{ path: "src/app.ts", contentHash: "deadbeef", modifiedAt: 1, indexedAt: 2 }],
    });
    const set = await fake.exportSymbols("/proj");
    expect(set.symbols).toEqual([SYMBOL]);
    expect(set.containsEdges).toHaveLength(1);
    expect(set.files).toHaveLength(1);
  });

  test("② 缺省：空 SymbolSet（空索引是合法状态，非 degraded——语义与降级显式区分）", async () => {
    const fake = new CodegraphEngineFake();
    const set = await fake.exportSymbols("/proj");
    expect(set.symbols).toEqual([]);
    expect(set.containsEdges).toEqual([]);
    expect(set.files).toEqual([]);
  });

  test("③ 不可用态：两方法均抛 EngineUnavailable（T2.2 degraded 路径输入）", async () => {
    const fake = new CodegraphEngineFake({ unavailable: true });
    await expect(fake.ensureIndex("/proj")).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(fake.exportSymbols("/proj")).rejects.toBeInstanceOf(EngineUnavailableError);
  });

  test("④ 延迟注入：exportSymbols 至少阻塞 delayMs（去抖/单飞时序测试面）", async () => {
    const fake = new CodegraphEngineFake({ delayMs: 50 });
    const startedAt = Date.now();
    await fake.exportSymbols("/proj");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
  });

  test("⑤ ensureIndex 结果注入（freshness fixture）+ 调用记录", async () => {
    const fake = new CodegraphEngineFake({
      ensureResult: { initialized: true, mode: "sync", lastIndexed: "2026-08-25T10:00:00.000Z" },
    });
    const freshness = await fake.ensureIndex("/proj");
    expect(freshness.mode).toBe("sync");
    await fake.exportSymbols("/proj");
    expect(fake.calls).toEqual([
      { method: "ensureIndex", projectRoot: "/proj" },
      { method: "exportSymbols", projectRoot: "/proj" },
    ]);
  });
});
