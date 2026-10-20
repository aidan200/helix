/**
 * KgViewerService 两处评审 low 条目单测：
 * - #24 logEventText：change_log op → 中文叙述词表全覆盖（缺 case 会回落原始
 *   英文 op，面板出现生英文）；断言面 = 全部 KnowledgeWriteOpKind 均产出中文
 *   且不等于原始 op。
 * - #27 indexStatus rebuild 的 fire-and-forget 向量联动：syncAll 拒绝（DB
 *   故障下 listEmbedTargets 抛错）不得成为 unhandledRejection，回执照常返回。
 */
import { describe, expect, test } from "bun:test";
import type { KnowledgeGraphPort } from "../../src/application/ports/outbound/KnowledgeGraphPort";
import type { KgProjectService } from "../../src/application/services/kg/KgProjectService";
import type { KgReportService } from "../../src/application/services/kg/KgReportService";
import type { KgVerifyService } from "../../src/application/services/kg/KgVerifyService";
import type { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import { KgViewerService, logEventText } from "../../src/application/services/kg/KgViewerService";
import type { KnowledgeWriteOpKind } from "../../src/domain/kg/types";

const ROOT = "/tmp/unit-kg-viewer-low/alpha";

/** change_log.op 词表（types.KnowledgeWriteOpKind 等价面——逐个断言有中文叙述）。 */
const OP_KINDS: readonly KnowledgeWriteOpKind[] = [
  "createNode",
  "updateNode",
  "supersede",
  "declareAnchors",
  "addEdge",
  "removeEdge",
  "batchCreateNodes",
  "proposeCandidate",
  "decideCandidate",
  "prune",
  "anchorRelocate",
];

describe("logEventText：change_log op 词表全覆盖（评审 low #24）", () => {
  test("每个 op 都产出中文叙述，不回落原始英文 op", () => {
    for (const op of OP_KINDS) {
      const text = logEventText(op, null);
      expect(text).not.toBe(op);
      expect(/[\u4e00-\u9fff]/u.test(text)).toBe(true);
    }
  });

  test("带 reason 的 op 叙述携带理由（评审补全的 anchorRelocate/decideCandidate 同口径）", () => {
    expect(logEventText("removeEdge", null)).toBe("移除知识边（约束/依赖关系解除）");
    expect(logEventText("batchCreateNodes", null)).toBe("批量创建节点（新知识入库）");
    expect(logEventText("proposeCandidate", null)).toBe("候选入库（待人工裁决）");
    expect(logEventText("anchorRelocate", "符号改名")).toContain("锚点机械重定位：符号改名");
    expect(logEventText("decideCandidate", "人审通过")).toContain("候选裁决：人审通过");
  });
});

describe("indexStatus rebuild：向量联动 fire-and-forget 吸收拒绝（评审 low #27）", () => {
  test("syncAll 拒绝 → 无 unhandledRejection，索引状态回执照常成功", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const graph = {
        getIndexStatus: () => ({ baseline: "1", symbolCount: 1, degraded: false }),
        countNodes: () => 0,
        latestIteration: () => null,
        countCandidatesByStatus: () => ({ pending: 0, deferred: 0, applied: 0, discarded: 0 }),
        listEscalations: () => [],
      } as unknown as KnowledgeGraphPort;
      const service = new KgViewerService({
        project: { resolve: (p: string) => (p === "alpha" ? ROOT : undefined), hasIndex: () => true } as unknown as KgProjectService,
        graph,
        verify: { findOrphans: () => [], findConflicts: () => [], findActivityMismatch: () => [] } as unknown as KgVerifyService,
        report: {} as unknown as KgReportService,
        write: {} as unknown as KgWriteService,
        sync: {
          getStatus: () => ({ phase: "synced" as const, baseline: "1", symbolCount: 1, degraded: false, syncedAt: null }),
          triggerManual: () => Promise.resolve({} as never),
          isBuilding: () => false,
        },
        vectorSync: { syncAll: () => Promise.reject(new Error("DB 故障：listEmbedTargets 抛错")) },
      });

      const result = await service.indexStatus("alpha", true);
      expect(result.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled.length).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
