import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KgDatabase } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";

/**
 * SqliteKnowledgeGraph 读面统一缺库守卫（code-review 低危组7）：
 * 库文件缺席时全部公共读方法返回各自空形状/零计数，且**不新建库文件**
 * （knowledgeConnection → connectionOf 会 mkdir+new Database 建库——读面
 * 调用即副作用建库，latestIteration 既有 existsSync 先例的全读面推广）。
 */
describe("SqliteKnowledgeGraph 缺库守卫（读面不建库）", () => {
  test("库文件缺席 → 各读方法空形状 + .helix-kg 目录不创建", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "kg-nodb-"));
    try {
      const graph = new SqliteKnowledgeGraph({ database: new KgDatabase() });

      expect(graph.getAttachmentSnapshot(projectRoot)).toEqual({
        nodes: [],
        fileAnchors: [],
        symbolAnchors: [],
        contains: [],
      });
      expect(graph.search(projectRoot, "TR-")).toEqual([]);
      expect(graph.reverseAnchorLookup(projectRoot, "src/foo.ts")).toEqual([]);
      expect(graph.getNode(projectRoot, "TR-1")).toBeNull();
      expect(graph.getSyncBaseline(projectRoot)).toEqual({
        files: [],
        symbols: [],
        activeAnchors: [],
        anchorDeclarations: [],
      });
      expect(graph.getIndexStatus(projectRoot)).toEqual({ baseline: null, symbolCount: 0, degraded: false });
      expect(graph.getVerifyView(projectRoot)).toEqual({
        nodes: [],
        edges: [],
        anchors: [],
        anchorDeclarations: [],
        files: [],
      });
      expect(graph.getChangeLog(projectRoot, "iter-x")).toEqual([]);
      expect(graph.countNodes(projectRoot)).toBe(0);
      expect(graph.countActiveNodes(projectRoot)).toBe(0);
      expect(graph.countActiveLayeredNodes(projectRoot)).toBe(0);
      expect(graph.listNodeIdsByOriginBatches(projectRoot, ["b-1"])).toEqual([]);
      expect(graph.latestIteration(projectRoot)).toBeNull();
      expect(graph.countCandidatesByStatus(projectRoot)).toEqual({
        pending: 0,
        deferred: 0,
        applied: 0,
        discarded: 0,
      });
      expect(graph.listCandidates(projectRoot, {})).toEqual([]);
      expect(graph.listGlobalResidentRules(projectRoot)).toEqual([]);

      // 核心断言：读面零副作用——库目录/文件不存在（未 mkdir、未建库）
      expect(existsSync(join(projectRoot, ".helix-kg"))).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
