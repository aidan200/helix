/**
 * subscription-ledger 单测 —— v0.3 monitor 档订阅生命周期（T3.2，CL-2；
 * 契约 v0.3 §2；AD-2/Q-2b①③④；TR-AD-23 订阅契约 / TR-AD-5 重连恢复）。
 *
 * 覆盖五态：
 * - 启动 syncList：活跃 full 先行 + 其余全部 monitor（逐会话命令序）+ 幂等
 *   收敛（同档位零命令）+ 清单外残留退订；
 * - created 补订 monitor / deleted 退订（含挂起降档清理）；
 * - 切换先升后降：subscribe(new, full) 立即发，旧活跃降档挂起至 ack
 *   （onSnapshot(target) 才发 subscribe(old, monitor)）；快速连切归并；
 * - 快照路由判定：活跃重建/激活快照 dispatch=true；monitor 档 ack 快照吞帧
 *   （dispatch=false——daemon 每次 subscribe 均重推快照，后台 ack 不进
 *   dispatcher，防活跃串台）；草稿链激活时 monitor → full 升级；
 * - 重连 replay：按当前活跃/后台分档重放全订阅图（daemon 不持跨连接状态，
 *   幂等 subscribe 天然收敛）。
 *
 * 活跃位 = 簿记内部镜像（同步推进；React 批处理下 store 滞后，同 tick
 * 快照→清单链以本簿为准）。
 */
import { describe, expect, test } from "vitest";
import { SubscriptionLedger } from "./subscription-ledger";

/** 命令断言投影：[type, sessionId, tier?] 三元组序。 */
function proj(cmds: readonly { type: string; sessionId?: string; payload?: unknown }[]) {
  return cmds.map((c) => [
    c.type,
    c.sessionId,
    (c.payload as { tier?: string } | undefined)?.tier,
  ]);
}

/** 首连激活（daemon 自动 attach 快照 → 活跃位建立；tier 未簿记零命令）。 */
function activateFirst(l: SubscriptionLedger, sessionId: string): void {
  const v = l.onSnapshot(sessionId);
  if (!v.dispatch || v.commands.length !== 0) throw new Error("首连激活前置失败");
}

describe("SubscriptionLedger —— 启动全图订阅（syncList）", () => {
  test("活跃 full 先行，其余按清单序 monitor；幂等收敛零重发", () => {
    const l = new SubscriptionLedger();
    activateFirst(l, "a"); // daemon 自动 attach 快照（tier 未簿记 → 零命令）
    const cmds = l.syncList(["a", "b", "c"]);
    expect(proj(cmds)).toEqual([
      ["session.subscribe", "a", "full"],
      ["session.subscribe", "b", "monitor"],
      ["session.subscribe", "c", "monitor"],
    ]);
    // 幂等：同清单同活跃 → 零命令
    expect(l.syncList(["a", "b", "c"])).toEqual([]);
  });

  test("清单外残留退订；活跃不在清单不退订；活跃缺省（首连前清单先到）全 monitor", () => {
    const l = new SubscriptionLedger();
    activateFirst(l, "a");
    l.syncList(["a", "b"]);
    // b 从清单消失（deleted 帧丢失兜底）→ 退订；a 保持 full 零命令
    expect(proj(l.syncList(["a"]))).toEqual([["session.unsubscribe", "b", undefined]]);
    // 活跃缺省：全部 monitor（快照后到则由激活/syncList 再对齐）
    const l2 = new SubscriptionLedger();
    expect(proj(l2.syncList(["x", "y"]))).toEqual([
      ["session.subscribe", "x", "monitor"],
      ["session.subscribe", "y", "monitor"],
    ]);
  });

  test("挂起降档中的旧活跃不被 syncList 抢降（先升后降严格序保护）", () => {
    const l = new SubscriptionLedger();
    activateFirst(l, "a");
    l.syncList(["a", "b"]);
    l.switchTo("b"); // a 降档挂起（等 b 快照 ack）
    // 清单重到（重连 reconcile 等）：a 仍 full，不得抢先降 monitor
    expect(l.syncList(["a", "b"])).toEqual([]);
    expect(l.tierOf("a")).toBe("full");
  });
});

describe("SubscriptionLedger —— created / deleted", () => {
  test("created 补订 monitor（幂等）；deleted 退订（不在簿零命令）", () => {
    const l = new SubscriptionLedger();
    activateFirst(l, "a");
    l.syncList(["a", "b"]);
    expect(proj(l.addCreated("d"))).toEqual([["session.subscribe", "d", "monitor"]]);
    expect(l.addCreated("d")).toEqual([]); // 幂等
    expect(proj(l.removeDeleted("d"))).toEqual([["session.unsubscribe", "d", undefined]]);
    expect(l.removeDeleted("d")).toEqual([]); // 不在簿零命令
  });

  test("deleted 命中挂起降档 → 从挂起集清除（ack 时不再降它）", () => {
    const l = new SubscriptionLedger();
    activateFirst(l, "a");
    l.syncList(["a", "b"]);
    l.switchTo("b");
    l.removeDeleted("a"); // a 在 ack 前被删
    const ack = l.onSnapshot("b");
    expect(ack.commands).toEqual([]); // a 已删，不降档（removeDeleted 已退订）
    expect(ack.dispatch).toBe(true);
  });
});

describe("SubscriptionLedger —— 切换先升后降", () => {
  test("subscribe(new, full) 立即发；ack 前零降档；ack 后才 subscribe(old, monitor)", () => {
    const l = new SubscriptionLedger();
    activateFirst(l, "a");
    l.syncList(["a", "b"]);
    expect(proj(l.switchTo("b"))).toEqual([["session.subscribe", "b", "full"]]);
    // ack 未达：旧活跃不降（瞬时双 full 窗口）
    expect(l.tierOf("a")).toBe("full");
    const ack = l.onSnapshot("b");
    expect(ack.dispatch).toBe(true); // 切换 ack 快照 = 激活指令（进 dispatcher）
    expect(proj(ack.commands)).toEqual([["session.subscribe", "a", "monitor"]]);
    expect(l.tierOf("b")).toBe("full");
    expect(l.tierOf("a")).toBe("monitor");
  });

  test("快速连切 A→B→C（B 未 ack）：ack(C) 归并降档 A 与 B", () => {
    const l = new SubscriptionLedger();
    activateFirst(l, "a");
    l.syncList(["a", "b", "c"]);
    l.switchTo("b");
    expect(proj(l.switchTo("c"))).toEqual([["session.subscribe", "c", "full"]]);
    const ack = l.onSnapshot("c");
    expect(proj(ack.commands)).toEqual([
      ["session.subscribe", "a", "monitor"],
      ["session.subscribe", "b", "monitor"],
    ]);
  });

  test("草稿（无活跃）切入：仅升档，ack 零降档命令", () => {
    const l = new SubscriptionLedger();
    l.syncList(["a", "b"]); // 活跃缺省：全 monitor
    expect(proj(l.switchTo("b"))).toEqual([["session.subscribe", "b", "full"]]);
    const ack = l.onSnapshot("b");
    expect(ack.dispatch).toBe(true);
    expect(ack.commands).toEqual([]);
  });
});

describe("SubscriptionLedger —— 快照路由判定（onSnapshot）", () => {
  test("活跃会话快照（重连/升档回推）→ dispatch，零命令；monitor 档 ack 快照 → 吞帧", () => {
    const l = new SubscriptionLedger();
    activateFirst(l, "a");
    l.syncList(["a", "b"]);
    // 活跃重建快照：dispatch=true 且不产生命令（a 已 full）
    expect(l.onSnapshot("a")).toEqual({ commands: [], dispatch: true });
    // b 的 monitor subscribe 回推快照：纯 ack 噪声 → 吞帧（防活跃串台）
    expect(l.onSnapshot("b")).toEqual({ commands: [], dispatch: false });
    expect(l.tierOf("b")).toBe("monitor"); // 吞帧不改簿记
  });

  test("草稿链激活（无活跃 + monitor 档位）→ dispatch + 升 full 命令", () => {
    const l = new SubscriptionLedger();
    activateFirst(l, "a");
    l.syncList(["a"]);
    l.newDraft(); // a → monitor，活跃位置零
    l.addCreated("n"); // created 补订 monitor
    const r = l.onSnapshot("n"); // daemon 草稿链快照回推 → n 转活跃
    expect(r.dispatch).toBe(true);
    expect(proj(r.commands)).toEqual([["session.subscribe", "n", "full"]]);
  });

  test("newDraft：旧活跃即降 monitor + 挂起切换收口（含 pending target 与 demote 链）", () => {
    const l = new SubscriptionLedger();
    activateFirst(l, "a");
    l.syncList(["a", "b"]);
    l.switchTo("b"); // b 升 full（未 ack），a 挂起
    // 用户立即新建草稿：a/b 均归 monitor（切换意图废弃，不再等 ack）
    expect(proj(l.newDraft())).toEqual([
      ["session.subscribe", "a", "monitor"],
      ["session.subscribe", "b", "monitor"],
    ]);
    // 迟到快照（b 的降档 ack——daemon 对每次 subscribe 均重推快照）：非草稿链
    // created 登记 → 吞帧保草稿（零命令零激活；E 层实查：激活会把草稿顶回 b）
    const late = l.onSnapshot("b");
    expect(late).toEqual({ commands: [], dispatch: false });
    expect(l.tierOf("b")).toBe("monitor"); // 吞帧不改簿记
  });

  test("newDraft 降档 ack 快照吞帧（E 层回归：daemon 每次 subscribe 重推快照）", () => {
    const l = new SubscriptionLedger();
    activateFirst(l, "a");
    l.syncList(["a", "b"]);
    expect(proj(l.newDraft())).toEqual([["session.subscribe", "a", "monitor"]]);
    // daemon 回推 a 快照（降档 ack）：不得激活（草稿须保持）
    expect(l.onSnapshot("a")).toEqual({ commands: [], dispatch: false });
    // 草稿链 created → 补订 monitor → 回推快照 = 激活指令（升 full）
    l.addCreated("n");
    const r = l.onSnapshot("n");
    expect(r.dispatch).toBe(true);
    expect(proj(r.commands)).toEqual([["session.subscribe", "n", "full"]]);
  });

  test("dropActive（删活跃本地转草稿）：活跃位置零，零命令；退订归 removeDeleted", () => {
    const l = new SubscriptionLedger();
    activateFirst(l, "a");
    l.syncList(["a", "b"]);
    l.dropActive();
    // 活跃位置零零命令；a 已删 → 下个清单对齐时作清单外残留退订（兜底）
    expect(proj(l.syncList(["b"]))).toEqual([["session.unsubscribe", "a", undefined]]);
  });
});

describe("SubscriptionLedger —— 重连重放（replay）", () => {
  test("按当前分档重放全图：活跃 full 先行 + 其余 monitor（无条件重发）", () => {
    const l = new SubscriptionLedger();
    activateFirst(l, "a");
    l.syncList(["a", "b", "c"]);
    l.switchTo("b");
    l.onSnapshot("b"); // 收口：b full / a,c monitor
    // 断连重连：daemon tier 表随连接销毁 → 全图重放
    expect(proj(l.replay())).toEqual([
      ["session.subscribe", "b", "full"],
      ["session.subscribe", "a", "monitor"],
      ["session.subscribe", "c", "monitor"],
    ]);
  });

  test("空簿有活跃（首连前断线）→ 仅活跃 full；空簿无活跃 → 零命令", () => {
    const l = new SubscriptionLedger();
    activateFirst(l, "a");
    expect(proj(l.replay())).toEqual([["session.subscribe", "a", "full"]]);
    expect(new SubscriptionLedger().replay()).toEqual([]);
  });

  test("replay 后簿记分档与重放一致（幂等收敛起点）", () => {
    const l = new SubscriptionLedger();
    activateFirst(l, "a");
    l.syncList(["a", "b"]);
    l.switchTo("b"); // 断线发生在 ack 前：pending 保留，replay 按当前分档
    expect(proj(l.replay())).toEqual([
      ["session.subscribe", "b", "full"],
      ["session.subscribe", "a", "monitor"],
    ]);
    // 重连后 daemon 重推 b 快照 → 命中 pending target → 降档收口（幂等：a 已 monitor）
    const ack = l.onSnapshot("b");
    expect(ack.dispatch).toBe(true);
    expect(ack.commands).toEqual([]);
  });
});
