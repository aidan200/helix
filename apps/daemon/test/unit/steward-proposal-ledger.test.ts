/**
 * ProposalLedger 确认闸聚合单测（DDD 重构批 1：确认闸子域抽取——TDD 红→绿）。
 *
 * 聚合职责（从 StewardService 迁出的纯状态机，行为逐项等价）：
 * - propose：新卡登记（actionId 递增）/ 同 key 在途复用（凭据换血 TTL 重置）/
 *   同 key 已成功终局拦截（返回终局信息供「已做过」回灌）；
 * - consume：单次消费（二次不存在）；
 * - void：作废幂等；
 * - settle：终局登记（succeeded 拦重复 / voided 放行重提）+ FIFO 容量上限 +
 *   同 key 其余在途卡静默收敛；
 * - expireDue / remindDue：TTL 批次作废 / 30s 可达性提醒（聚合口径一条）；
 * - resolveRunCards：run 收口卡处置（deliver 类续活 / destructive 撤除）；
 * - snapshot：插入序。
 *
 * 约束（kg 切片）：TR-240 确认链路状态面（弹卡出口唯一/终局收敛/口令路由
 * 仅 pending 在场/生命周期统一）——本聚合是其一等公民载体；E-276 两段式
 * 语义不变。批 1 绞杀不变量：既有 steward-confirm-chain/two-phase/reliability
 * 测试全绿 = 行为等价证明（本文件只钉聚合内聚行为）。
 */
import { describe, expect, test } from "bun:test";
import { DomainError } from "../../src/domain/DomainError";
import {
  ProposalLedger,
  type PendingAction,
  pendingKeyOf,
} from "../../src/domain/steward/confirmation/ProposalLedger";

describe("载荷/上限守卫（评审 low #75/#76）", () => {
  test("kind 与载荷形状不匹配 → pendingKeyOf 抛 DomainError（不是 TypeError）", () => {
    const broken = { kind: "send", displayTarget: "x", message: "m", toolCall: { id: "", name: "propose_send" } } as PendingAction;
    expect(() => pendingKeyOf(broken)).toThrow(DomainError);
    expect(() => pendingKeyOf(broken)).toThrow(/缺少对应载荷/);
  });

  test("registryMax < 1 / 非整数 → 构造抛 DomainError（原本 0 会让上限失效）", () => {
    expect(() => new ProposalLedger({ now: () => 0, registryMax: 0 })).toThrow(/registryMax 非法/);
    expect(() => new ProposalLedger({ now: () => 0, registryMax: 1.5 })).toThrow(/registryMax 非法/);
    expect(() => new ProposalLedger({ now: () => 0, registryMax: 1 })).not.toThrow();
  });
});

// ── fixtures ───────────────────────────────────────────────

function sendAction(agentId = "agent-1", message = "看看情况"): PendingAction {
  return {
    kind: "send",
    displayTarget: agentId,
    message: `向 ${agentId} 递话`,
    toolCall: { id: "call-1", name: "propose_send" },
    send: { agentId, message },
  };
}

function surfaceDestructiveAction(): PendingAction {
  return {
    kind: "surfaceAct",
    displayTarget: "browser:tab-1",
    message: "在页面上执行删除",
    toolCall: { id: "call-2", name: "act" },
    surfaceAct: {
      surfaceId: "browser:tab-1",
      verb: "click",
      risk: "destructive",
      args: { selector: "#delete" },
    } as PendingAction["surfaceAct"],
  };
}

function makeLedger(nowRef = { now: 1_000_000 }) {
  return { ledger: new ProposalLedger({ now: () => nowRef.now }), nowRef };
}

// ── propose ────────────────────────────────────────────────

describe("ProposalLedger.propose", () => {
  test("新卡登记：actionId 递增（steward-action-N）+ pending 收录", () => {
    const { ledger } = makeLedger();
    const r1 = ledger.propose(sendAction("a"), { pauseToken: "t1" });
    const r2 = ledger.propose(sendAction("b"), { pauseToken: "t2" });
    if (r1.kind !== "created" || r2.kind !== "created") throw new Error("unreachable");
    expect(r1.actionId).toBe("steward-action-1");
    expect(r2.actionId).toBe("steward-action-2");
    expect(ledger.size).toBe(2);
    expect(ledger.pendingSnapshot()).toEqual(["steward-action-1", "steward-action-2"]);
  });

  test("同 key 在途 → 复用旧卡（凭据换血：pauseToken/createdAt/toolCall 更新、remindedAt 保留）", () => {
    const { ledger, nowRef } = makeLedger();
    const first = ledger.propose(sendAction(), { pauseToken: "t1" });
    if (first.kind !== "created") throw new Error("unreachable");
    // 提醒后（remindedAt 已置位）
    nowRef.now += 60_000;
    ledger.remindDue(nowRef.now, 30_000);
    // 同 key 重提（同 agent 同文本）
    nowRef.now += 10_000;
    const again = ledger.propose(sendAction(), { pauseToken: "t2" });
    if (again.kind !== "reused") throw new Error(`expected reused, got ${again.kind}`);
    expect(again.actionId).toBe(first.actionId); // 不新弹不新凭据
    expect(ledger.size).toBe(1);
    const entry = ledger.entryOf(first.actionId);
    if (entry === undefined) throw new Error("unreachable");
    expect(entry.pauseToken).toBe("t2"); // 凭据换血
    expect(entry.createdAt).toBe(nowRef.now); // TTL 重置新确认窗口
    expect(entry.remindedAt).toBe(1_000_000 + 60_000); // 提醒标记保留（零二次提醒）
  });

  test("同 key 已成功终局 → 拦截（返回终局信息供「已做过」回灌）", () => {
    const { ledger } = makeLedger();
    const r = ledger.propose(sendAction(), { pauseToken: "t1" });
    if (r.kind !== "created") throw new Error("unreachable");
    ledger.consume(r.actionId);
    ledger.settle(pendingKeyOf(sendAction()), "succeeded", r.actionId, "已投递");
    const again = ledger.propose(sendAction(), { pauseToken: "t2" });
    if (again.kind !== "blocked") throw new Error(`expected blocked, got ${again.kind}`);
    expect(again.settled.status).toBe("succeeded");
    expect(again.settled.actionId).toBe(r.actionId);
    expect(ledger.size).toBe(0); // 零新卡
  });

  test("同 key 已 voided 终局 → 放行新提案（重提按新卡）", () => {
    const { ledger } = makeLedger();
    const r = ledger.propose(sendAction(), { pauseToken: "t1" });
    if (r.kind !== "created") throw new Error("unreachable");
    ledger.void(r.actionId);
    const again = ledger.propose(sendAction(), { pauseToken: "t2" });
    expect(again.kind).toBe("created");
  });
});

// ── consume / void ─────────────────────────────────────────

describe("ProposalLedger.consume / void", () => {
  test("consume 单次消费：首次返回 entry 并删除；二次 undefined", () => {
    const { ledger } = makeLedger();
    const r = ledger.propose(sendAction(), { pauseToken: "t1" });
    if (r.kind !== "created") throw new Error("unreachable");
    const entry = ledger.consume(r.actionId);
    expect(entry?.action.displayTarget).toBe("agent-1");
    expect(ledger.consume(r.actionId)).toBeUndefined(); // 单次语义
  });

  test("void 幂等：不存在静默 undefined；在途删除并返回", () => {
    const { ledger } = makeLedger();
    expect(ledger.void("steward-action-999")).toBeUndefined(); // 幂等
    const r = ledger.propose(sendAction(), { pauseToken: "t1" });
    if (r.kind !== "created") throw new Error("unreachable");
    const entry = ledger.void(r.actionId);
    expect(entry?.key).toBe(pendingKeyOf(sendAction()));
    expect(ledger.size).toBe(0);
  });
});

// ── settle（终局登记 + 同 key 收敛 + 容量上限）──────────────

describe("ProposalLedger.settle", () => {
  test("succeeded 记终局；同 key 其余在途卡静默收敛（返回被收敛清单）", () => {
    const { ledger } = makeLedger();
    const a = ledger.propose(sendAction(), { pauseToken: "t1" });
    if (a.kind !== "created") throw new Error("unreachable");
    // 另一张不同 key 的卡不受影响
    const other = ledger.propose(sendAction("agent-2"), { pauseToken: "t2" });
    if (other.kind !== "created") throw new Error("unreachable");
    ledger.consume(a.actionId);
    const collapsed = ledger.settle(pendingKeyOf(sendAction()), "succeeded", a.actionId, "done");
    expect(collapsed).toEqual([]); // 无同 key 在途（本卡已消费）
    const settled = ledger.settledOf(pendingKeyOf(sendAction()));
    expect(settled?.status).toBe("succeeded");
    expect(settled?.detail).toBe("done");
    expect(ledger.size).toBe(1); // agent-2 卡不受连带
  });

  test("终局登记簿 FIFO 容量上限（超限淘汰最老）", () => {
    const { ledger } = makeLedger();
    for (let i = 0; i < 260; i += 1) {
      const r = ledger.propose(sendAction(`agent-${i}`), {});
      if (r.kind !== "created") throw new Error("unreachable");
      ledger.settle(pendingKeyOf(sendAction(`agent-${i}`)), "voided", r.actionId, "x");
    }
    // 超过 256 上限后最老的被淘汰（agent-0 淘汰、agent-259 仍在）
    expect(ledger.settledOf(pendingKeyOf(sendAction("agent-0")))).toBeUndefined();
    expect(ledger.settledOf(pendingKeyOf(sendAction("agent-259")))).toBeDefined();
  });
});

// ── expireDue / remindDue ──────────────────────────────────

describe("ProposalLedger.expireDue / remindDue", () => {
  test("expireDue 快照式：返回到期列表不删除；markExpired 逐个删（同批收敛前置删除后 no-op）", () => {
    const { ledger, nowRef } = makeLedger();
    const a = ledger.propose(sendAction("a"), {});
    const b = ledger.propose(sendAction("b"), {});
    if (a.kind !== "created" || b.kind !== "created") throw new Error("unreachable");
    nowRef.now += 300_000; // 两卡同时到期（ttl=300s）
    const expired = ledger.expireDue(nowRef.now, 300_000);
    expect(expired.map((e) => e.actionId).sort()).toEqual([a.actionId, b.actionId].sort());
    expect(ledger.size).toBe(2); // 快照式：不删除
    expect(ledger.markExpired(a.actionId)?.action.displayTarget).toBe("a");
    expect(ledger.markExpired(a.actionId)).toBeUndefined(); // 二次 no-op（已被删）
    ledger.markExpired(b.actionId);
    expect(ledger.size).toBe(0);
    expect(ledger.expireDue(nowRef.now, 300_000)).toEqual([]); // 幂等空集
  });

  test("remindDue：首成熟卡触发聚合提醒（覆盖全集 remindedAt）→ 二次调用零提醒", () => {
    const { ledger, nowRef } = makeLedger();
    const a = ledger.propose(sendAction("a"), {});
    ledger.propose(sendAction("b"), {});
    if (a.kind !== "created") throw new Error("unreachable");
    nowRef.now += 31_000; // 首卡成熟（30s）
    const first = ledger.remindDue(nowRef.now, 30_000);
    expect(first?.total).toBe(2); // 聚合口径：全集 N=2
    expect(first?.first.actionId).toBe(a.actionId);
    const second = ledger.remindDue(nowRef.now, 30_000);
    expect(second).toBeUndefined(); // 全集已置 remindedAt——零二次提醒
  });
});

// ── resolveRunCards（run 收口卡处置）───────────────────────

describe("ProposalLedger.resolveRunCards", () => {
  test("非 destructive 卡续活（返回 kept）；已终局卡零处置", () => {
    const { ledger } = makeLedger();
    const r = ledger.propose(sendAction(), { pauseToken: "t1" });
    if (r.kind !== "created") throw new Error("unreachable");
    const { kept, withdrawn } = ledger.resolveRunCards([r.actionId]);
    expect(kept.map((k) => k.actionId)).toEqual([r.actionId]);
    expect(withdrawn).toEqual([]);
  });

  test("destructive 卡撤除（返回 withdrawn + 从 pending 删除）", () => {
    const { ledger } = makeLedger();
    const r = ledger.propose(surfaceDestructiveAction(), { pauseToken: "t1" });
    if (r.kind !== "created") throw new Error("unreachable");
    const { kept, withdrawn } = ledger.resolveRunCards([r.actionId]);
    expect(kept).toEqual([]);
    expect(withdrawn.map((w) => w.actionId)).toEqual([r.actionId]);
    expect(ledger.size).toBe(0);
  });

  test("已终局（先 confirm）卡零处置", () => {
    const { ledger } = makeLedger();
    const r = ledger.propose(sendAction(), { pauseToken: "t1" });
    if (r.kind !== "created") throw new Error("unreachable");
    ledger.consume(r.actionId);
    const { kept, withdrawn } = ledger.resolveRunCards([r.actionId]);
    expect(kept).toEqual([]);
    expect(withdrawn).toEqual([]);
  });
});

// ── 读面 ───────────────────────────────────────────────────

describe("ProposalLedger 读面", () => {
  test("latestPendingActionId：createdAt 最大（相等取后入）；空集 undefined", () => {
    const { ledger, nowRef } = makeLedger();
    expect(ledger.latestPendingActionId()).toBeUndefined();
    const a = ledger.propose(sendAction("a"), {});
    if (a.kind !== "created") throw new Error("unreachable");
    nowRef.now += 5;
    ledger.propose(sendAction("b"), {});
    expect(ledger.latestPendingActionId()).toBe("steward-action-2");
  });

  test("findPendingIdByKey：同 key 在途定位；entryOf 快照读", () => {
    const { ledger } = makeLedger();
    const r = ledger.propose(sendAction(), {});
    if (r.kind !== "created") throw new Error("unreachable");
    expect(ledger.findPendingIdByKey(pendingKeyOf(sendAction()))).toBe(r.actionId);
    expect(ledger.entryOf(r.actionId)?.action.kind).toBe("send");
  });
});
