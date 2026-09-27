import { describe, expect, test } from "bun:test";
import { relocateAnchors } from "../../src/domain/kg/anchor-relocate";
import type { AnchorDeclRow, MaterializedAnchor } from "../../src/domain/kg/types";

/**
 * 锚机械重定位纯函数单测（kg-auto-adjudication-design.md §4 L0）。
 *
 * 设计映射（E-9 orphan 三形态 → 机械处置）：
 * - 形态2 跨文件迁移（主形态）→ R1b（symbol 同名搬家）/ R1（path 精确声明文件移动）/ R2（同文件符号改名）机械重写声明；
 * - 形态3 无声明旧键 → R3 机械 prune（节点附着面健康时）；
 * - 形态1 符号消亡（声明仍在）→ 不动，保留 tombstone 信号（归 L1 裁决）。
 * 稳定期门：输入只收存量 tombstone（断链轮仅落快照），由 sync 接线保证。
 * 误挂率 0 目标：唯一性歧义 / evidence 缺失 / kind 不符 / 相似度不达 → 一律不动。
 */

interface Sym {
  readonly name: string;
  readonly kind: string;
  readonly file: string;
  readonly spanStart: number;
  readonly spanEnd: number;
}

function tomb(
  nodeId: string,
  anchorKind: "path" | "symbol",
  anchorPath: string,
  anchorSymbol: string | null,
  evidence?: string,
): MaterializedAnchor & { evidence?: string } {
  return { nodeId, anchorKind, anchorPath, anchorSymbol, ...(evidence !== undefined ? { evidence } : {}) };
}

function decl(nodeId: string, scopeKind: AnchorDeclRow["scopeKind"], pattern: string): AnchorDeclRow {
  return { nodeId, scopeKind, pattern };
}

const EV_RENAME = JSON.stringify({ kind: "function", spanStart: 10, spanEnd: 50 });
const EV_MOVE_SYMBOL = JSON.stringify({ kind: "function", spanStart: 1, spanEnd: 80 });
const EV_PATH_MOVE = JSON.stringify({ symbolNames: ["parseConfig", "validateConfig", "CONFIG_DEFAULTS"] });

describe("anchor-relocate：机械重定位（L0，误挂率 0）", () => {
  test("① R2 同文件符号改名：唯一候选 span 重叠 ≥0.5 → 重写声明 symbol 名", () => {
    const result = relocateAnchors({
      tombstones: [tomb("TR-1", "symbol", "src/config.ts", "loadConfig", EV_RENAME)],
      declarations: [decl("TR-1", "symbol", "src/config.ts#loadConfig")],
      materialized: [],
      filePaths: ["src/config.ts"],
      symbols: [
        { name: "parseConfig", kind: "function", file: "src/config.ts", spanStart: 2, spanEnd: 8 },
        { name: "fetchConfig", kind: "function", file: "src/config.ts", spanStart: 12, spanEnd: 48 },
        { name: "CONFIG_DEFAULTS", kind: "constant", file: "src/config.ts", spanStart: 1, spanEnd: 1 },
      ] satisfies readonly Sym[],
    });
    expect(result.rewrites).toEqual([
      {
        nodeId: "TR-1",
        scopeKind: "symbol",
        oldPattern: "src/config.ts#loadConfig",
        newPattern: "src/config.ts#fetchConfig",
        rule: "R2-symbol-rename",
        evidence: "src/config.ts#loadConfig → src/config.ts#fetchConfig（kind=function, span 重叠 0.90）",
      },
    ]);
    expect(result.prunes.map((p) => [p.nodeId, p.anchorSymbol])).toEqual([["TR-1", "loadConfig"]]);
  });

  test("② R2 歧义否决：两个同 kind 同 span 窗口候选 → 不动", () => {
    const result = relocateAnchors({
      tombstones: [tomb("TR-1", "symbol", "src/a.ts", "old", EV_RENAME)],
      declarations: [decl("TR-1", "symbol", "src/a.ts#old")],
      materialized: [],
      filePaths: ["src/a.ts"],
      symbols: [
        { name: "candA", kind: "function", file: "src/a.ts", spanStart: 10, spanEnd: 30 },
        { name: "candB", kind: "function", file: "src/a.ts", spanStart: 12, spanEnd: 50 },
      ] satisfies readonly Sym[],
    });
    expect(result.rewrites).toEqual([]);
    expect(result.prunes).toEqual([]);
  });

  test("③ R2 kind 不符 / evidence 缺失 → 不动（防误挂）", () => {
    const kindMismatch = relocateAnchors({
      tombstones: [tomb("TR-1", "symbol", "src/a.ts", "old", EV_RENAME)],
      declarations: [decl("TR-1", "symbol", "src/a.ts#old")],
      materialized: [],
      filePaths: ["src/a.ts"],
      symbols: [{ name: "cand", kind: "class", file: "src/a.ts", spanStart: 10, spanEnd: 50 }] satisfies readonly Sym[],
    });
    expect(kindMismatch.rewrites).toEqual([]);

    const noEvidence = relocateAnchors({
      tombstones: [tomb("TR-1", "symbol", "src/a.ts", "old")],
      declarations: [decl("TR-1", "symbol", "src/a.ts#old")],
      materialized: [],
      filePaths: ["src/a.ts"],
      symbols: [{ name: "cand", kind: "function", file: "src/a.ts", spanStart: 10, spanEnd: 50 }] satisfies readonly Sym[],
    });
    expect(noEvidence.rewrites).toEqual([]);
    expect(noEvidence.prunes).toEqual([]);
  });

  test("④ R1b symbol 跨文件迁移（E-9 形态2 主形态）：旧文件消失 + 唯一新文件有同名同 kind 符号 → 重写 pathGlob（仅精确路径声明）", () => {
    const result = relocateAnchors({
      tombstones: [tomb("TR-2", "symbol", "src/services/task-engine.ts", "sweepBatches", EV_MOVE_SYMBOL)],
      declarations: [decl("TR-2", "symbol", "src/services/task-engine.ts#sweepBatches")],
      materialized: [],
      filePaths: ["src/services/orchestrator.ts"],
      symbols: [
        { name: "sweepBatches", kind: "function", file: "src/services/orchestrator.ts", spanStart: 5, spanEnd: 60 },
      ] satisfies readonly Sym[],
    });
    expect(result.rewrites).toEqual([
      {
        nodeId: "TR-2",
        scopeKind: "symbol",
        oldPattern: "src/services/task-engine.ts#sweepBatches",
        newPattern: "src/services/orchestrator.ts#sweepBatches",
        rule: "R1b-symbol-cross-file",
        evidence: "src/services/task-engine.ts#sweepBatches → src/services/orchestrator.ts#sweepBatches（唯一同名同 kind 宿主）",
      },
    ]);
    expect(result.prunes.length).toBe(1);
  });

  test("⑤ R1b glob 声明 / 多候选宿主 → 不动", () => {
    const globDecl = relocateAnchors({
      tombstones: [tomb("TR-2", "symbol", "src/services/task-engine.ts", "sweepBatches", EV_MOVE_SYMBOL)],
      declarations: [decl("TR-2", "symbol", "src/services/**#sweepBatches")],
      materialized: [],
      filePaths: ["src/services/orchestrator.ts"],
      symbols: [
        { name: "sweepBatches", kind: "function", file: "src/services/orchestrator.ts", spanStart: 5, spanEnd: 60 },
      ] satisfies readonly Sym[],
    });
    expect(globDecl.rewrites).toEqual([]);

    const multiHost = relocateAnchors({
      tombstones: [tomb("TR-2", "symbol", "src/a.ts", "fn", EV_MOVE_SYMBOL)],
      declarations: [decl("TR-2", "symbol", "src/a.ts#fn")],
      materialized: [],
      filePaths: ["src/b.ts", "src/c.ts"],
      symbols: [
        { name: "fn", kind: "function", file: "src/b.ts", spanStart: 1, spanEnd: 5 },
        { name: "fn", kind: "function", file: "src/c.ts", spanStart: 1, spanEnd: 5 },
      ] satisfies readonly Sym[],
    });
    expect(multiHost.rewrites).toEqual([]);
  });

  test("⑥ R1 path 精确声明文件移动：符号名集 Jaccard ≥0.9 唯一宿主 → 重写精确路径", () => {
    const result = relocateAnchors({
      tombstones: [tomb("TR-3", "path", "src/legacy/config.ts", null, EV_PATH_MOVE)],
      declarations: [decl("TR-3", "path", "src/legacy/config.ts")],
      materialized: [],
      filePaths: ["src/core/config.ts"],
      symbols: [
        { name: "parseConfig", kind: "function", file: "src/core/config.ts", spanStart: 1, spanEnd: 20 },
        { name: "validateConfig", kind: "function", file: "src/core/config.ts", spanStart: 22, spanEnd: 40 },
        { name: "CONFIG_DEFAULTS", kind: "constant", file: "src/core/config.ts", spanStart: 42, spanEnd: 42 },
      ] satisfies readonly Sym[],
    });
    expect(result.rewrites).toEqual([
      {
        nodeId: "TR-3",
        scopeKind: "path",
        oldPattern: "src/legacy/config.ts",
        newPattern: "src/core/config.ts",
        rule: "R1-path-move",
        evidence: "src/legacy/config.ts → src/core/config.ts（符号名集 Jaccard 1.00）",
      },
    ]);
    expect(result.prunes.length).toBe(1);
  });

  test("⑦ R1 Jaccard 不达 0.9 → 不动（既移又重构 = 语义场景，归 L1）", () => {
    const result = relocateAnchors({
      tombstones: [tomb("TR-3", "path", "src/legacy/config.ts", null, EV_PATH_MOVE)],
      declarations: [decl("TR-3", "path", "src/legacy/config.ts")],
      materialized: [],
      filePaths: ["src/core/config.ts"],
      symbols: [{ name: "parseConfig", kind: "function", file: "src/core/config.ts", spanStart: 1, spanEnd: 20 }] satisfies readonly Sym[],
    });
    expect(result.rewrites).toEqual([]);
    expect(result.prunes).toEqual([]);
  });

  test("⑧ R3 无声明旧键 + 节点附着面健康 → 机械 prune（E-9 形态3 永不自愈项）", () => {
    const result = relocateAnchors({
      tombstones: [tomb("TR-4", "symbol", "src/old.ts", "gone", EV_MOVE_SYMBOL)],
      declarations: [decl("TR-4", "symbol", "src/new.ts#keep")],
      materialized: [{ nodeId: "TR-4", anchorKind: "symbol", anchorPath: "src/new.ts", anchorSymbol: "keep" }],
      filePaths: ["src/new.ts"],
      symbols: [{ name: "keep", kind: "function", file: "src/new.ts", spanStart: 1, spanEnd: 5 }] satisfies readonly Sym[],
    });
    expect(result.rewrites).toEqual([]);
    expect(result.prunes.map((p) => [p.nodeId, p.anchorSymbol])).toEqual([["TR-4", "gone"]]);
  });

  test("⑨ 形态1 符号消亡（声明仍在）→ 保留 tombstone（真信号，不机械处置）", () => {
    const result = relocateAnchors({
      tombstones: [tomb("TR-5", "symbol", "src/a.ts", "deleted", EV_RENAME)],
      declarations: [decl("TR-5", "symbol", "src/a.ts#deleted")],
      materialized: [{ nodeId: "TR-5", anchorKind: "path", anchorPath: "src/a.ts", anchorSymbol: null }],
      filePaths: ["src/a.ts"],
      symbols: [{ name: "other", kind: "function", file: "src/a.ts", spanStart: 1, spanEnd: 5 }] satisfies readonly Sym[],
    });
    expect(result.rewrites).toEqual([]);
    expect(result.prunes).toEqual([]);
  });

  test("⑩ R3 节点零附着（无其他活锚无声明）→ 保留 tombstone（归体检/orphan_node 口径）", () => {
    const result = relocateAnchors({
      tombstones: [tomb("TR-6", "symbol", "src/old.ts", "gone", EV_MOVE_SYMBOL)],
      declarations: [],
      materialized: [],
      filePaths: [],
      symbols: [] satisfies readonly Sym[],
    });
    expect(result.prunes).toEqual([]);
  });
});
