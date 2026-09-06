import { describe, expect, test } from "bun:test";
import type { KnowledgeGraphPort } from "../../src/application/ports/outbound/KnowledgeGraphPort";
import type { KgProjectService } from "../../src/application/services/kg/KgProjectService";
import type { KgReportService } from "../../src/application/services/kg/KgReportService";
import type { KgVerifyService } from "../../src/application/services/kg/KgVerifyService";
import { KgViewerService } from "../../src/application/services/kg/KgViewerService";
import type { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import type {
  AnchorReverseHit,
  AttachmentSnapshot,
  CandidateRow,
  CandidateStatusCounts,
  ChangeLogEntry,
  IndexStatus,
  KnowledgeNode,
  NodeDetail,
  NodeDigestRow,
  SyncBaselineView,
  VerifyView,
} from "../../src/domain/kg/types";

/**
 * KgViewerService 详情页三项全图扫描缓存（code-review M7③）单测：
 * assembleDetail 的 findActivityMismatch（全 verify 视图+启发排序）/
 * getAttachmentSnapshot 全量 / search("") 全表 LIKE 按版本戳（sync 基准戳 ×
 * 节点数 × 最近迭代）缓存复用——版本不变多次 nodeDetail 只扫一轮；基准戳
 * 推进 / 节点新建 / confirm 写路径即时失效重建。
 */

const ROOT = "/tmp/unit-kg-viewer/alpha";

function nodeOf(id: string, status: "draft" | "confirmed" | "superseded" = "confirmed"): KnowledgeNode {
  return {
    id,
    kind: "rule",
    name: `节点${id}`,
    digest: `${id} 摘要`,
    scene: "测试场景",
    body: `${id} 正文`,
    domain: null,
    layer: null,
    originBatchId: null,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function detailOf(node: KnowledgeNode): NodeDetail {
  return {
    node,
    anchorDeclarations: [],
    materializedAnchors: [],
    edges: node.id === "TR-1" ? [{ verb: "governs", otherId: "TR-2", direction: "out" }] : [],
    supersedeChain: [{ nodeId: node.id, name: node.name, status: node.status, relation: "self" }],
    changeLog: [],
  };
}

/** 调用计数的可编程 graph stub（三项扫描计数 + 版本戳探针可演进）。 */
class CountingGraph implements KnowledgeGraphPort {
  status: IndexStatus = { baseline: "1", symbolCount: 0, degraded: false };
  nodeCount = 2;
  iteration: string | null = "iter-1";
  mismatchCalls = 0; // 经 verify stub 计数（此处不计）
  snapshotCalls = 0;
  searchCalls = 0;
  private readonly details = new Map<string, NodeDetail>();

  setDetail(detail: NodeDetail): void {
    this.details.set(detail.node.id, detail);
  }

  getNode(_root: string, id: string): NodeDetail | null {
    return this.details.get(id) ?? null;
  }

  getIndexStatus(): IndexStatus {
    return this.status;
  }

  countNodes(): number {
    return this.nodeCount;
  }

  latestIteration(): string | null {
    return this.iteration;
  }

  getAttachmentSnapshot(): AttachmentSnapshot {
    this.snapshotCalls += 1;
    return { nodes: [], fileAnchors: [], symbolAnchors: [], contains: [] };
  }

  search(): readonly NodeDigestRow[] {
    this.searchCalls += 1;
    return [...this.details.values()].map((d) => ({
      id: d.node.id,
      kind: d.node.kind,
      name: d.node.name,
      digest: d.node.digest,
      scene: d.node.scene,
      status: d.node.status,
      domain: d.node.domain,
    }));
  }

  getSyncBaseline(): SyncBaselineView {
    return { files: [], symbols: [], activeAnchors: [], anchorDeclarations: [] };
  }

  getVerifyView(): VerifyView {
    return { nodes: [], edges: [], anchors: [], anchorDeclarations: [], files: [] };
  }

  getChangeLog(): readonly ChangeLogEntry[] {
    return [];
  }

  reverseAnchorLookup(): readonly AnchorReverseHit[] {
    return [];
  }

  countActiveNodes(): number {
    return 0;
  }

  countActiveLayeredNodes(): number {
    return 0;
  }

  listNodeIdsByOriginBatches(): readonly string[] {
    return [];
  }

  countCandidatesByStatus(): CandidateStatusCounts {
    return { pending: 0, deferred: 0, applied: 0, discarded: 0 };
  }

  listCandidates(): readonly CandidateRow[] {
    return [];
  }
}

function makeService(graph: CountingGraph): { service: KgViewerService; verify: { mismatchCalls: number } } {
  const verify = {
    mismatchCalls: 0,
    findActivityMismatch: (): readonly never[] => {
      verify.mismatchCalls += 1;
      return [];
    },
    findOrphans: (): readonly never[] => [],
    findConflicts: (): readonly never[] => [],
  };
  const project = {
    resolve: (p: string) => (p === "alpha" ? ROOT : undefined),
    hasIndex: () => true,
  } as unknown as KgProjectService;
  const write = {
    write: () => ({ ok: true, value: {} }),
  } as unknown as KgWriteService;
  const service = new KgViewerService({
    project,
    graph,
    verify: verify as unknown as KgVerifyService,
    report: {} as unknown as KgReportService,
    write,
    sync: {
      getStatus: () => ({ phase: "synced" as const, baseline: "1", symbolCount: 0, degraded: false, syncedAt: null }),
      triggerManual: () => Promise.resolve({} as never),
      isBuilding: () => false,
    },
  });
  return { service, verify };
}

describe("KgViewerService 详情页三项全图扫描缓存（M7③）", () => {
  test("① 版本戳不变：多次 nodeDetail 三项扫描只执行一轮（缓存复用）", () => {
    const graph = new CountingGraph();
    graph.setDetail(detailOf(nodeOf("TR-1")));
    graph.setDetail(detailOf(nodeOf("TR-2")));
    const { service, verify } = makeService(graph);

    const first = service.nodeDetail("alpha", "TR-1");
    expect(first.ok).toBe(true);
    expect(verify.mismatchCalls).toBe(1);
    expect(graph.snapshotCalls).toBe(1);
    expect(graph.searchCalls).toBe(1);

    // 同节点再查 + 异节点查询：版本戳未变 → 零重扫（修复前每次点击 O(全图)×3）
    service.nodeDetail("alpha", "TR-1");
    const other = service.nodeDetail("alpha", "TR-2");
    expect(other.ok).toBe(true);
    expect(verify.mismatchCalls).toBe(1);
    expect(graph.snapshotCalls).toBe(1);
    expect(graph.searchCalls).toBe(1);

    // 缓存内容仍正确：TR-1 关系 peer 解析到 TR-2 摘要行
    const d1 = service.nodeDetail("alpha", "TR-1");
    const relations = (d1.ok ? d1.value.relations : []) as readonly { verb: string; peer: { id: string; name: string } }[];
    expect(relations[0]!.peer.name).toBe("节点TR-2");
  });

  test("② sync 基准戳推进 → 缓存失效重扫（符号/锚层变更收敛）", () => {
    const graph = new CountingGraph();
    graph.setDetail(detailOf(nodeOf("TR-1")));
    const { service, verify } = makeService(graph);
    service.nodeDetail("alpha", "TR-1");
    expect(verify.mismatchCalls).toBe(1);

    graph.status = { baseline: "2", symbolCount: 0, degraded: false }; // sync 完成推进基准戳
    service.nodeDetail("alpha", "TR-1");
    expect(verify.mismatchCalls).toBe(2);
    expect(graph.snapshotCalls).toBe(2);
    expect(graph.searchCalls).toBe(2);
  });

  test("③ 知识层新建节点（计数推进）→ 缓存失效重扫（新 peer 不可见防「已删除节点」假象）", () => {
    const graph = new CountingGraph();
    graph.setDetail(detailOf(nodeOf("TR-1")));
    const { service, verify } = makeService(graph);
    service.nodeDetail("alpha", "TR-1");
    expect(verify.mismatchCalls).toBe(1);

    graph.nodeCount = 3; // createNode 落库（基准戳不推进——知识层写不动符号层）
    graph.setDetail(detailOf(nodeOf("TR-3")));
    service.nodeDetail("alpha", "TR-1");
    expect(verify.mismatchCalls).toBe(2);
    expect(graph.searchCalls).toBe(2);
  });

  test("④ confirm 写路径即时失效（status 翻转进 peer 徽章不等下次 sync）", () => {
    const graph = new CountingGraph();
    const draft = detailOf(nodeOf("TR-1", "draft"));
    graph.setDetail(draft);
    graph.setDetail(detailOf(nodeOf("TR-2")));
    const { service, verify } = makeService(graph);
    service.nodeDetail("alpha", "TR-2");
    expect(verify.mismatchCalls).toBe(1);

    const confirmed = service.confirm("alpha", "TR-1");
    expect(confirmed.ok).toBe(true);
    // confirm 后首次 nodeDetail：即使版本探针未变也重扫（本服务写路径主动失效）
    service.nodeDetail("alpha", "TR-2");
    expect(verify.mismatchCalls).toBe(2);
  });
});
