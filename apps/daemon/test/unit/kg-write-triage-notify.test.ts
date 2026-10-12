import { describe, expect, test } from "bun:test";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import type { KnowledgeStorePort } from "../../src/application/ports/outbound/KnowledgeStorePort";
import type { KnowledgeWriteOp, WriteResult } from "../../src/domain/kg/types";

/**
 * KgWriteService autoTriage 钩子单测（B批：静默点自动触发）：
 * 仅候选台账变化（proposeCandidate/decideCandidate）成功后通知触发器；
 * 其他 op 与失败写入零通知（防抖/裁决在触发器侧；钩子内失败不阻塞写入）。
 */

const ROOT = "/tmp/unit-write-notify/alpha";

function makeService(storeResult?: WriteResult): {
  service: KgWriteService;
  notified: string[];
  throwOnNotify?: boolean;
} {
  const notified: string[] = [];
  const service = new KgWriteService({
    store: {
      writeKnowledge: (_root: string, _op: KnowledgeWriteOp) => storeResult ?? { ok: true, nodeId: "N-1" },
    } as unknown as KnowledgeStorePort,
    autoTriage: { onCandidateChange: (projectRoot: string) => notified.push(projectRoot) },
  });
  return { service, notified };
}

describe("KgWriteService autoTriage 通知钩子", () => {
  test("proposeCandidate 成功 → 通知一次", () => {
    const h = makeService();
    const result = h.service.write(ROOT, {
      kind: "proposeCandidate",
      candidateKind: "sediment",
      title: "发现",
      body: "reason: ...\nevidence: ...",
    } as unknown as KnowledgeWriteOp);
    expect(result.ok).toBe(true);
    expect(h.notified).toEqual([ROOT]);
  });

  test("decideCandidate 成功 → 通知一次", () => {
    const h = makeService();
    const result = h.service.write(ROOT, {
      kind: "decideCandidate",
      candidateId: "CAND-1",
      decision: "deferred",
    } as unknown as KnowledgeWriteOp);
    expect(result.ok).toBe(true);
    expect(h.notified).toEqual([ROOT]);
  });

  test("createNode 成功 → 零通知（候选面之外）", () => {
    const h = makeService();
    const result = h.service.write(ROOT, {
      kind: "createNode",
      draft: { kind: "rule", name: "规则", digest: "摘要", scene: "适用场景" },
    } as unknown as KnowledgeWriteOp);
    expect(result.ok).toBe(true);
    expect(h.notified).toEqual([]);
  });

  test("写入失败 → 零通知", () => {
    const h = makeService({ ok: false, error: { code: "KG_E_STATE", message: "终态", path: "op.candidateId" } });
    const result = h.service.write(ROOT, {
      kind: "decideCandidate",
      candidateId: "CAND-1",
      decision: "applied",
    } as unknown as KnowledgeWriteOp);
    expect(result.ok).toBe(false);
    expect(h.notified).toEqual([]);
  });

  test("校验拒绝（空 body 候选）→ 零通知", () => {
    const h = makeService();
    const result = h.service.write(ROOT, {
      kind: "proposeCandidate",
      candidateKind: "sediment",
      title: "发现",
      body: "   ",
    } as unknown as KnowledgeWriteOp);
    expect(result.ok).toBe(false);
    expect(h.notified).toEqual([]);
  });

  test("钩子缺席零行为（向后兼容）", () => {
    const service = new KgWriteService({
      store: { writeKnowledge: () => ({ ok: true, nodeId: "N-1" }) } as unknown as KnowledgeStorePort,
    });
    const result = service.write(ROOT, {
      kind: "decideCandidate",
      candidateId: "CAND-1",
      decision: "deferred",
    } as unknown as KnowledgeWriteOp);
    expect(result.ok).toBe(true);
  });
});
