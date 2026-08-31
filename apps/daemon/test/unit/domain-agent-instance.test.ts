import { describe, expect, test } from "bun:test";
import {
  AgentInstance,
  isMainInstanceId,
  LEGACY_MAIN_INSTANCE_ID,
  newInstanceId,
  type AgentInstanceData,
} from "../../src/domain/agent/AgentInstance";
import { AgentLifecycle } from "../../src/domain/agent/AgentLifecycle";
import { DomainError } from "../../src/domain/DomainError";

/**
 * F1.7（unit 半）+ F1.9：AgentInstance 一等概念——
 * ① 创建/销毁一等 API 独立可用（无会话按序推进前置）；
 * ② 实例状态机合法迁移矩阵（queued→running→done/failed；queued 直接收口
 *    failed/cancelled；AD-10：cancelled 仅自 queued——重启清队语义）；
 * ③ 终态封闭（done/failed/cancelled 无出边——F1.9 终态不回 running，
 *    重派 = 新 instanceId 新实例）；
 * ④ 多实例并存：乱序交错序列互不干扰、不产生非法半态；
 * ⑤ AgentLifecycle 注册表语义（会话内多实例并存，AD-3）；
 * ⑥ T10a 方案 A：实例 id 统一生成单点 + legacy "main" 只读兼容判别。
 */

function subagent(n: number, state?: AgentInstanceData["state"]): AgentInstance {
  return AgentInstance.create({
    instanceId: `agent-${n}`,
    kind: "subagent",
    profileKind: "subagent-worker",
    sessionId: "s-1",
    createdAt: "2024-01-01T00:00:00.000Z",
    state,
  });
}

describe("① 创建/销毁一等 API（F1.9：不依赖会话按序推进）", () => {
  test("create 缺省 queued；显式 state 可指定；toData 全量往返", () => {
    const a = subagent(1);
    expect(a.instanceId).toBe("agent-1");
    expect(a.kind).toBe("subagent");
    expect(a.profileKind).toBe("subagent-worker");
    expect(a.sessionId).toBe("s-1");
    expect(a.current).toBe("queued"); // spawn 缺省态（秒回出卡）
    expect(a.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(a.isTerminal).toBe(false);

    const b = subagent(2, "running");
    expect(b.current).toBe("running");

    const back = AgentInstance.restore(a.toData());
    expect(back.toData()).toEqual(a.toData());
    expect(back.current).toBe("queued");
  });

  test("主实例 id 统一生成（T10a 方案 A）：agent-<唯一串>，kind=\"main\"", () => {
    const id = newInstanceId();
    expect(id).toMatch(/^agent-[0-9a-f]{32}$/); // 非纯数字 N（uuid 去横线形态）
    const main = AgentInstance.create({
      instanceId: id,
      kind: "main",
      profileKind: "main-session",
      sessionId: "s-1",
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    expect(main.instanceId).toBe(id);
    expect(main.kind).toBe("main");
  });

  test("destroy 从任意非终态收口到合法终态（无任何会话前置动作）", () => {
    const a = subagent(1); // queued
    a.destroy("failed"); // queued 直接收口 failed（不经 running）
    expect(a.current).toBe("failed");
    expect(a.isTerminal).toBe(true);

    const b = subagent(2);
    b.destroy("cancelled"); // 重启清队语义（queued→cancelled）
    expect(b.current).toBe("cancelled");
  });

  test("destroy 终态幂等（no-op，不抛错）", () => {
    const a = subagent(1);
    a.markRunning();
    a.complete();
    expect(() => a.destroy("failed")).not.toThrow();
    expect(a.current).toBe("done"); // 已终态不改变
  });

  test("destroy 非法终态目标抛 DomainError 且状态不变", () => {
    const a = subagent(1);
    a.markRunning();
    expect(() => a.destroy("cancelled")).toThrow(DomainError); // running→cancelled 非法（AD-10）
    expect(a.current).toBe("running");
  });
});

describe("② 实例状态机合法迁移矩阵", () => {
  test("queued → running → done / failed（主路径与崩溃路径）", () => {
    const ok = subagent(1);
    ok.markRunning();
    expect(ok.current).toBe("running");
    ok.complete();
    expect(ok.current).toBe("done");

    const bad = subagent(2);
    bad.markRunning();
    bad.fail("崩溃");
    expect(bad.current).toBe("failed");
  });

  test("queued 直接收口 failed（不等执行）", () => {
    const a = subagent(1);
    a.fail("spawn 即失败");
    expect(a.current).toBe("failed");
  });

  test("cancel 仅自 queued（AD-10：cancelled 只在重启清队产生）", () => {
    const a = subagent(1);
    a.cancel();
    expect(a.current).toBe("cancelled");

    const b = subagent(2);
    b.markRunning();
    expect(() => b.cancel()).toThrow(DomainError);
    expect(b.current).toBe("running"); // 非法迁移不改状态
  });

  test("canTransition / assertIn 观测面", () => {
    const a = subagent(1);
    expect(a.canTransition("running")).toBe(true);
    expect(a.canTransition("done")).toBe(false); // queued 不可直达 done
    a.markRunning();
    a.assertIn("running");
    expect(() => a.assertIn("queued")).toThrow(DomainError);
  });

  // ── ⑤ park/resume：parked 非终态（设计稿 park-resume §2.1） ──

  test("running ──park──▶ parked ──resume──▶ running 往返", () => {
    const a = subagent(1);
    a.markRunning();
    a.park();
    expect(a.current).toBe("parked");
    expect(a.isTerminal).toBe(false); // 非终态：不写 closure、不触发收口链
    a.resume();
    expect(a.current).toBe("running");
    a.complete(); // resume 后正常收口
    expect(a.current).toBe("done");
  });

  test("parked → failed 合法（kill/崩溃/重启收口）；park 仅自 running", () => {
    const killed = subagent(1);
    killed.markRunning();
    killed.park();
    killed.fail("parked 期间 kill");
    expect(killed.current).toBe("failed");

    const queued = subagent(2); // queued 无执行载体不可 park
    expect(() => queued.park()).toThrow(DomainError);
    expect(queued.current).toBe("queued");

    const parked = subagent(3, "running");
    parked.park();
    expect(() => parked.park()).toThrow(DomainError); // parked 不可再 park
    expect(() => parked.complete()).toThrow(DomainError); // parked 不可直达 done（挂起期无自然收口）
    expect(parked.current).toBe("parked"); // 非法迁移无半态
  });

  test('restore("parked") 合法（快照往返保留挂起态）', () => {
    const a = subagent(1, "parked");
    expect(AgentInstance.restore(a.toData()).current).toBe("parked");
  });
});

describe("③ 终态封闭（F1.9：终态不回 running）", () => {
  test.each(["done", "failed", "cancelled"] as const)("终态 %s 无任何出边", (final) => {
    const a = subagent(1);
    if (final === "cancelled") a.cancel();
    else if (final === "failed") a.fail("收口");
    else {
      a.markRunning();
      a.complete();
    }
    for (const to of ["queued", "running", "parked", "done", "failed", "cancelled"] as const) {
      expect(a.canTransition(to)).toBe(false);
      expect(() => a.transition(to)).toThrow(DomainError);
    }
    expect(a.current).toBe(final); // 全部非法尝试后状态不变（无半态）
  });
});

describe("④ 多实例并存：乱序交错序列互不干扰（F1.9）", () => {
  test("两个同类型 worker（agent-1/agent-2）仅凭 instanceId 可区分，状态机各自独立", () => {
    const a1 = subagent(1);
    const a2 = subagent(2);
    // 乱序交错：a2 先跑完、a1 排队中收口 failed、再起 a3
    a2.markRunning();
    a1.fail("预算外取消");
    a2.complete();
    const a3 = subagent(3);
    a3.markRunning();

    expect(a1.current).toBe("failed");
    expect(a2.current).toBe("done");
    expect(a3.current).toBe("running");
    // 同类型多实例可区分（F1.7 验收：两个 worker 数据可区分）
    expect(new Set([a1, a2, a3].map((x) => x.instanceId))).toEqual(
      new Set(["agent-1", "agent-2", "agent-3"]),
    );
  });

  test("重派 = 新 instanceId 新实例（终态实例不被复用）", () => {
    const dead = subagent(1);
    dead.markRunning();
    dead.fail("失败");
    const retry = subagent(2); // 调度重派：新实例新 id
    retry.markRunning();
    expect(dead.isTerminal).toBe(true);
    expect(retry.current).toBe("running");
    expect(retry.instanceId).not.toBe(dead.instanceId);
  });
});

describe("⑤ AgentLifecycle 注册表语义（AD-3：会话内实例注册表）", () => {
  test("register/find/list 多实例并存；重复注册抛错", () => {
    const lc = new AgentLifecycle();
    const main = AgentInstance.create({
      instanceId: LEGACY_MAIN_INSTANCE_ID,
      kind: "main",
      profileKind: "main-session",
      sessionId: "s-1",
      createdAt: "2024-01-01T00:00:00.000Z",
      state: "running",
    });
    lc.registerInstance(main);
    lc.registerInstance(subagent(1));
    lc.registerInstance(subagent(2));

    expect(lc.instanceCount).toBe(3);
    expect(lc.findInstance("agent-1")?.profileKind).toBe("subagent-worker");
    expect(lc.findInstance(LEGACY_MAIN_INSTANCE_ID)?.kind).toBe("main");
    expect(lc.listInstances().map((x) => x.instanceId)).toEqual(["main", "agent-1", "agent-2"]);

    expect(() => lc.registerInstance(subagent(1))).toThrow(DomainError); // 同 id 重复注册
    expect(lc.instanceCount).toBe(3); // 失败注册不产生半态
  });

  test("unregister 任意时刻可用（销毁一等 API，不依赖会话状态推进）", () => {
    const lc = new AgentLifecycle();
    const a1 = subagent(1);
    lc.registerInstance(a1);
    a1.markRunning(); // 仍 running 的实例也可出册（窗口销毁由编排决策）
    const out = lc.unregisterInstance("agent-1");
    expect(out).toBe(a1);
    expect(lc.instanceCount).toBe(0);
    expect(lc.unregisterInstance("agent-1")).toBeUndefined(); // 幂等
  });

  test("注册表与主实例会话状态机独立（注册实例不改变会话 lifecycle 状态）", () => {
    const lc = new AgentLifecycle();
    expect(lc.current).toBe("idle");
    lc.registerInstance(subagent(1));
    lc.registerInstance(subagent(2));
    expect(lc.current).toBe("idle"); // 不因注册实例而迁移
    lc.transition("running"); // 既有主状态机行为不变
    expect(lc.current).toBe("running");
    expect(lc.instanceCount).toBe(2);
  });
});

describe("⑦ newInstanceId / isMainInstanceId（T10a 方案 A：id 生成单点 + kind 判别）", () => {
  test("newInstanceId：agent-<唯一串>（非纯数字 N；连续生成互异——无撞号概念）", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newInstanceId()));
    expect(ids.size).toBe(100); // 连续生成互异（重启后无序号基线亦无撞号）
    for (const id of ids) {
      expect(id).toMatch(/^agent-[0-9a-f]{32}$/); // 非 agent-\d+ 纯数字形态
      expect(id).not.toBe(LEGACY_MAIN_INSTANCE_ID);
    }
  });

  test("isMainInstanceId：会话主实例 id / legacy \"main\" / 缺省 均判 main；其余判非", () => {
    const mainId = newInstanceId();
    expect(isMainInstanceId(mainId, mainId)).toBe(true); // 该会话主实例 id
    expect(isMainInstanceId("main", mainId)).toBe(true); // legacy 字面只读兼容
    expect(isMainInstanceId(undefined, mainId)).toBe(true); // 旧载荷省略 = main 推断（读侧保留）
    expect(isMainInstanceId("agent-1", mainId)).toBe(false); // SubAgent（含旧序号形态）
    expect(isMainInstanceId(newInstanceId(), mainId)).toBe(false); // 他会话/他实例 id
    // legacy 会话（mainId 自身 = "main"）自闭合
    expect(isMainInstanceId("main", LEGACY_MAIN_INSTANCE_ID)).toBe(true);
    expect(isMainInstanceId("agent-7", LEGACY_MAIN_INSTANCE_ID)).toBe(false);
  });
});
