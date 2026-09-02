/**
 * subscription-ledger —— v0.3 monitor 档订阅生命周期簿记（T3.2，CL-2；
 * 契约 v0.3 §2；AD-2/Q-2b①③④；TR-AD-23 订阅契约 / TR-AD-5 重连恢复）。
 *
 * 客户端侧订阅图权威（daemon 不持跨连接状态——tier 表随连接销毁即丢，
 * TR-AD-23③）：
 * - activeId：活跃会话内部镜像。store 经 React dispatch 异步更新（同 tick
 *   批处理时 topologyRef 滞后），而快照→清单等同 tick 帧链需要同步判据——
 *   故活跃位由本簿随 switchTo/newDraft/onSnapshot(激活) 同步推进；
 * - tiers：本连接已发出档位（last-sent；幂等语义 = Map.set 覆盖收敛）+ 首连
 *   自动 attach 的静默登记（daemon attach 即 full，簿记对齐——否则 newDraft
 *   对该会话零降档命令，流量放大）；
 * - pending：切换「先升后降」挂起——subscribe(new, full) 立即发，旧活跃
 *   （及连切链上的中间目标）降档延迟至 ack（= session.snapshot 帧到达，
 *   contract §2.1 回执形态）才发出，瞬时双 full 窗口内不丢帧不串台。
 *
 * 快照路由判定（onSnapshot 的 dispatch 位）：daemon 对每次 subscribe 均重推
 * 该会话全量快照（WsServerAdapter 既有语义，不分档位）——monitor 档补订/
 * 降档的回推快照是纯 ack 噪声，若进 dispatcher 会把后台会话顶成活跃
 * （frame.ts：快照 = 连接级重建指令）。故「快照是否进 dispatcher」由本簿
 * 判定：仅 ①当前活跃重建 ②切换/草稿链激活 放行；其余吞帧。
 *
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now；出站命令经
 * commands.ts 构造器（@helix/protocol 同源类型）。
 */
import type { SessionSubscribeCommand, SessionUnsubscribeCommand } from "@helix/protocol";
import { sessionSubscribeCommand, sessionUnsubscribeCommand } from "@/shared/api/commands";

export type SubscriptionTier = "full" | "monitor";
export type SubscriptionCommand = SessionSubscribeCommand | SessionUnsubscribeCommand;

/** onSnapshot 判定结果：commands = 出站命令（降档收口/激活升档）；dispatch = 快照是否进 dispatcher。 */
export interface SnapshotVerdict {
  commands: SubscriptionCommand[];
  dispatch: boolean;
}

export class SubscriptionLedger {
  /** 活跃会话镜像（同步推进；见模块头）。 */
  private activeId: string | null = null;
  /** 已发出档位簿记（sessionId → tier）。 */
  private readonly tiers = new Map<string, SubscriptionTier>();
  /** 先升后降挂起：target = 等待 ack 的新活跃；demote = ack 后降 monitor 的会话链。 */
  private pending: { target: string; demote: string[] } | null = null;
  /** 草稿链待激活：无活跃时 created 补订的会话——其回推快照 = 激活指令
   *  （区别于降档/补订 ack 噪声；daemon 对每次 subscribe 均重推快照，
   *  newDraft 降档 ack 若走「快照优先激活」会把草稿顶回旧会话——E 层实查）。 */
  private readonly pendingActivation = new Set<string>();

  /** 观测面（测试/诊断）：某会话当前簿记档位。 */
  tierOf(sessionId: string): SubscriptionTier | undefined {
    return this.tiers.get(sessionId);
  }

  private set(sessionId: string, tier: SubscriptionTier): SessionSubscribeCommand {
    this.tiers.set(sessionId, tier);
    return sessionSubscribeCommand(sessionId, tier);
  }

  private isPendingDemote(sessionId: string): boolean {
    return this.pending?.demote.includes(sessionId) ?? false;
  }

  /**
   * 启动/清单对齐（session.list.result 到达）：活跃 full 先行 + 其余全部
   * monitor（逐会话订阅，工作台会话数有限无批量命令需求）+ 清单外残留退订
   * （deleted 帧丢失兜底）。幂等：档位一致零命令。挂起降档中的会话不抢降
   * （先升后降严格序保护）。
   */
  syncList(sessionIds: string[]): SubscriptionCommand[] {
    const out: SubscriptionCommand[] = [];
    const activeId = this.activeId;
    if (
      activeId !== null &&
      sessionIds.includes(activeId) &&
      this.tiers.get(activeId) !== "full" &&
      !this.isPendingDemote(activeId)
    ) {
      out.push(this.set(activeId, "full"));
    }
    for (const id of sessionIds) {
      if (id === activeId || this.isPendingDemote(id)) continue;
      if (this.tiers.get(id) !== "monitor") out.push(this.set(id, "monitor"));
    }
    for (const id of [...this.tiers.keys()]) {
      if (!sessionIds.includes(id) && id !== activeId) {
        this.tiers.delete(id);
        out.push(sessionUnsubscribeCommand(id));
      }
    }
    return out;
  }

  /** created（list_changed）：补订 monitor（幂等；档位升级归 switchTo/快照激活）。
   *  无活跃（草稿链）时登记 pendingActivation——该会话的回推快照 = 激活指令。 */
  addCreated(sessionId: string): SubscriptionCommand[] {
    if (this.tiers.has(sessionId)) return [];
    if (this.activeId === null) this.pendingActivation.add(sessionId);
    return [this.set(sessionId, "monitor")];
  }

  /** deleted（list_changed）：退订 + 挂起降档/待激活清理（ack 时不再降它）。 */
  removeDeleted(sessionId: string): SubscriptionCommand[] {
    this.pendingActivation.delete(sessionId);
    if (this.pending !== null) {
      this.pending = {
        target: this.pending.target,
        demote: this.pending.demote.filter((id) => id !== sessionId),
      };
    }
    if (!this.tiers.has(sessionId)) return [];
    this.tiers.delete(sessionId);
    return [sessionUnsubscribeCommand(sessionId)];
  }

  /**
   * 切换（先升后降，Q-2b③）：subscribe(new, full) 立即发；旧活跃降档挂起至
   * ack（onSnapshot(target)）。快速连切：前一挂起的 target 与 demote 链归并
   * 到新挂起（中间目标未 ack 也一并降——它已非活跃）。重复切换同会话归
   * provider 前置拦截（active.sessionId === target 原样），此处不防。
   */
  switchTo(newId: string): SubscriptionCommand[] {
    const prevId = this.activeId;
    const demote: string[] = [...(this.pending?.demote ?? [])];
    if (this.pending !== null && this.pending.target !== newId && this.tiers.get(this.pending.target) === "full") {
      demote.push(this.pending.target);
    }
    if (prevId !== null && prevId !== newId) demote.push(prevId);
    this.pending = { target: newId, demote: [...new Set(demote)].filter((id) => id !== newId) };
    this.pendingActivation.delete(newId); // 切换即显式激活意图，草稿链登记失效
    this.activeId = newId; // 乐观推进（switch-started 同步置 store loading）
    // 恒发（幂等）：保障每次切换都有新鲜快照作 ack（回切未降档会话亦然）
    return [this.set(newId, "full")];
  }

  /**
   * 新建草稿（F(1.2).1）：旧活跃即降 monitor（后台照跑，取代旧 unsubscribe——
   * monitor 档正是「切走照跑 + 未读徽标」语义）；挂起中的切换收口（切换意图
   * 废弃，不再等 ack——全部归 monitor）。
   */
  newDraft(): SubscriptionCommand[] {
    const ids = new Set<string>([...(this.pending?.demote ?? [])]);
    if (this.pending !== null) ids.add(this.pending.target);
    if (this.activeId !== null) ids.add(this.activeId);
    this.pending = null;
    this.activeId = null;
    const out: SubscriptionCommand[] = [];
    for (const id of ids) {
      if (this.tiers.get(id) === "full") out.push(this.set(id, "monitor"));
    }
    return out;
  }

  /** 删活跃会话本地先转草稿（deleteSession 路径）：活跃位置零（零命令——
   *  退订由随后的 list_changed{deleted} 驱动 removeDeleted 发出）。 */
  dropActive(): void {
    this.activeId = null;
  }

  /**
   * 快照到达（session.snapshot 帧 = subscribe 回执，contract §2.1 ack 形态）：
   * ① 命中挂起 target → 先升后降收口（demote 链逐一降 monitor）；
   * ② 激活判定：快照目标 ≠ 当前活跃且（挂起 target / 无活跃——草稿链/首连）
   *    → 进 dispatcher（目标转活跃）+ monitor 档位补升 full（草稿链 created
   *    先补订 monitor 的升级点）；首连自动 attach（tier 簿为空）静默登记 full
   *    （daemon attach 即 full，零命令冗余噪声）；
   * ③ 其余（monitor 档 subscribe 的回推快照）→ 纯 ack 噪声吞帧（dispatch=false）。
   */
  onSnapshot(sessionId: string): SnapshotVerdict {
    const commands: SubscriptionCommand[] = [];
    // 挂起 target 命中（先升后降 ack）：demote 链逐一降 monitor 后收口
    //（switchTo 乐观推进 activeId=target，故须先于活跃重建判定）
    if (this.pending?.target === sessionId) {
      for (const id of this.pending.demote) {
        if (this.tiers.get(id) === "full") commands.push(this.set(id, "monitor"));
      }
      this.pending = null;
      return { commands, dispatch: true }; // 切换 ack 快照 = 激活指令（进 dispatcher）
    }
    if (sessionId === this.activeId) {
      return { commands, dispatch: true }; // 活跃重建（重连/升档回推）：原样进 dispatcher
    }
    if (this.activeId !== null) {
      return { commands, dispatch: false }; // monitor 档 ack 噪声：吞帧防串台
    }
    // 无活跃三分支：
    // ① 草稿链激活（created 补订登记在册）→ 进 dispatcher + monitor 升 full；
    // ② 首连自动 attach（本连接未发任何 subscribe，tier 簿为空）→ 既有兜底激活
    //    + 静默登记 full（只簿记不发命令——daemon attach 本就是 full，发命令是
    //    冗余噪声；bug3 根因②修复：不登记则后续 newDraft 对该会话零降档命令，
    //    daemon 侧 full 订阅持续全量推流，流量放大）；
    // ③ 其余 = 降档/补订 ack 噪声（daemon 对每次 subscribe 均重推快照——如
    //    newDraft 降 monitor 的回推）→ 吞帧保草稿（E 层实查：若激活会把草稿
    //    顶回旧会话，首条消息误发旧会话）。
    if (this.pendingActivation.has(sessionId)) {
      this.pendingActivation.delete(sessionId);
      this.activeId = sessionId;
      if (this.tiers.get(sessionId) === "monitor") commands.push(this.set(sessionId, "full"));
      return { commands, dispatch: true };
    }
    if (this.tiers.size === 0) {
      // 先判 tiers.size === 0 再登记（登记后簿非空，顺序不可颠倒）
      this.activeId = sessionId;
      this.tiers.set(sessionId, "full"); // 静默簿记（零命令；见模块头/上注）
      return { commands, dispatch: true };
    }
    return { commands, dispatch: false };
  }

  /**
   * connection.welcome 活跃习得（list 抢跑竞态防线）：welcome 载荷带 daemon
   * 当前会话（握手 attach 即 full）——无活跃位时习得之，与 conn 消费者的
   * sessionId 习得对称（store 习得而簿记不习得 = 两者对「活跃」认知分叉的
   * 根因）。两类到达形态：
   * - 快照先到（常规）：簿记空 → 静默登记 full（同 onSnapshot ②，零命令）；
   * - list.result 先到（hello 的冷会话快照组装 await 期间 session.list 插队）：
   *   syncList 已把活跃会话打成 monitor（daemon 档位真被降）→ 重发 full 修复。
   * 已有活跃位（重连 replay 后）原样不覆盖——用户当前选择优先。
   */
  learnAttached(sessionId: string): SubscriptionCommand[] {
    if (this.activeId !== null) return [];
    this.activeId = sessionId;
    if (this.tiers.get(sessionId) === "monitor") return [this.set(sessionId, "full")];
    this.tiers.set(sessionId, "full");
    return [];
  }

  /**
   * 断连重连重放（TR-AD-5）：daemon tier 表随连接销毁 → 按当前分档重放全
   * 订阅图（活跃 full 先行 + 簿记其余 monitor；无条件重发——幂等 subscribe
   * 天然收敛）。pending 跨重连保留：重连后 daemon 自动 attach 当前会话并
   * 重推快照，若命中 target 即收口挂起降档。
   */
  replay(): SubscriptionCommand[] {
    const out: SubscriptionCommand[] = [];
    if (this.activeId !== null) out.push(this.set(this.activeId, "full"));
    for (const id of this.tiers.keys()) {
      if (id !== this.activeId) out.push(this.set(id, "monitor"));
    }
    return out;
  }
}
