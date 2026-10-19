/**
 * ProposalLedger —— 确认闸聚合（DDD 重构批 1：确认闸子域抽取）。
 *
 * 定位：管家确认闸的**纯状态机**（设计文档 docs/temp/steward-ddd-redesign.md
 * §3.2②）——pending 卡集合 + 提案终局登记簿 + 卡生命周期时间判定的单点。
 * 批 1 前这些状态散在 StewardService 的三组字段（pending/proposalRegistry/
 * actionSeq）与七个方法里，不变量靠注释；本聚合把它收编为显式领域模型，
 * **行为逐项等价**（绞杀不变量：既有 confirm-chain/two-phase/reliability
 * 测试全绿即证明）。
 *
 * 聚合规则（TR-240 确认链路状态面——本聚合是一等公民载体）：
 * - 弹卡出口唯一：同 key 在途复用（凭据换血 pauseToken/toolCall/createdAt，
 *   TTL 重置新确认窗口；remindedAt 保留——后熟卡零二次提醒）；
 * - 终局收敛：succeeded 拦重复提案（回灌「已做过」）/ voided 放行重提；
 *   settle 时同 key 其余在途卡静默收敛（返回被收敛清单供广播 superseded）；
 * - 单次消费：consume 后同 actionId 不复存在（执行失败也不可重放）；
 * - 生命周期统一：run 收口非 destructive 卡续活（意图不随 run 死而失效）、
 *   destructive 即时撤除、已终局零处置。
 *
 * 域边界（批 1 绞杀取舍）：聚合**返回结构化结果**而非事件回调——出站帧
 * （action.completed/notify/日志）的发射点与顺序保留在应用层逐点翻译，
 * ws 帧序列逐帧一致是批 1 的硬验收；domain 零 IO 零依赖注入端口（时钟
 * 注入除外）。executePending 执行体/口令路由/挂闸 gate 校验留应用层（批 3
 * 工具面子域归位）。PendingAction.surfaceAct 用本层自有的结构形状
 * （SurfaceActPayload）——不引 application 端口类型、也不引 protocol 的
 * SurfaceRisk（TR-13 双向禁令：domain 是依赖方向的被依赖端且 framework-free
 * 才可纯单测）：两侧字面量同值域时结构双向可赋值，跨层传递零转换。
 *
 * 为什么存在：确认闸是管家事故最高频区（10-06 确认链路修复批问题 1-7 +
 * 10-07 热修批③④），状态迁移全部隐式是根因；聚合化后卡生命周期判定
 * （到期/成熟/续活/收敛）表驱动可测，应用层只做编排与翻译。
 */

// ── 值对象与类型 ───────────────────────────────────

/** 表面动作请求的域内只读形状（M2；评审 F1：自
 *  application/ports/outbound/StewardSurfacePort 的 StewardSurfaceActRequest
 *  拆出——域层不得反向依赖 application，也不得 import protocol 类型）。
 *  risk 以域内字面量联合表达：应用层请求与本形状字段同值域时结构双向可
 *  赋值（协议 risk 词表若扩值，应用层赋值点先编译错，不会静默漂移）。 */
export interface SurfaceActPayload {
  readonly surfaceId: string;
  readonly verb: string;
  readonly args: Record<string, unknown>;
  readonly risk: "read" | "write" | "destructive";
}

/** 确认闸目标（面板两行渲染语义重载：send = 递话目标实例；createSession /
 *  spawnReview = 动作标识；deliverSession = 递话目标会话；surfaceAct = 表面
 *  动作目标 surfaceId——见各分支注释）。自 StewardService 迁入（批 1）。 */
export interface PendingAction {
  readonly kind: "send" | "createSession" | "spawnReview" | "deliverSession" | "surfaceAct";
  /** 面板确认卡「目标」行显示值（send = agentId；createSession = "新会话"；
   *  spawnReview = "<reviewType>@<project>"；deliverSession = sessionId）。 */
  readonly displayTarget: string;
  /** 面板确认卡「内容」行显示值（动作摘要全文）。 */
  readonly message: string;
  /** 提案时的工具调用（confirm 执行结果回灌工作记忆的配对锚）。 */
  readonly toolCall: { id: string; name: string };
  /** send 形态载荷。 */
  readonly send?: { agentId: string; message: string };
  /** createSession 形态载荷（initialMessage = 用户想带着话题开始的初始内容——建成即作为首条消息投递；缺省纯建空会话）。 */
  readonly createSession?: { title: string; initialMessage?: string };
  /** deliverSession 形态载荷（驾驶舱批：session 级 steer 投递）。 */
  readonly deliverSession?: { sessionId: string; text: string };
  /** spawnReview 形态载荷。 */
  readonly spawnReview?: {
    reviewType: "code-review" | "kg-review";
    project: string;
    params: Record<string, unknown>;
  };
  /** surfaceAct 形态载荷（M2 表面动作——risk 已定档，经确认闸后走同一动作管道）。 */
  readonly surfaceAct?: SurfaceActPayload;
}

/** 在途确认卡条目（自 StewardService 迁入——pending Map 的值形态）。 */
export interface PendingEntry {
  readonly action: PendingAction;
  /** 登记簿幂等 key（verb|targetId|contentHash；缺省由 pendingKeyOf 现算）。 */
  readonly key?: string;
  /** 挂闸凭据（引擎 pauseToken——run 收口后续活时换血；轮外提案缺席）。 */
  readonly pauseToken?: string;
  readonly createdAt: number;
  /** 已提醒时刻（undefined = 未提醒；聚合提醒覆盖全集后零二次）。 */
  remindedAt?: number;
}

/** 提案终局记录（登记簿值形态）。 */
export interface ProposalSettlement {
  readonly status: "succeeded" | "voided";
  readonly actionId: string;
  readonly detail: string;
  readonly settledAt: number;
}

/** propose 三路结果：新卡 / 在途复用（换血）/ 已成功终局拦截。 */
export type ProposeOutcome =
  | { readonly kind: "created"; readonly actionId: string; readonly entry: PendingEntry }
  | { readonly kind: "reused"; readonly actionId: string; readonly entry: PendingEntry }
  | { readonly kind: "blocked"; readonly settled: ProposalSettlement };

/** run 收口卡处置结果：续活 / 撤除（供应用层翻译帧与日志）。 */
export interface RunCardsResolution {
  readonly kept: { readonly actionId: string; readonly action: PendingAction }[];
  readonly withdrawn: { readonly actionId: string; readonly action: PendingAction }[];
}

/** 可达性提醒聚合结果（首成熟卡代表 + 全集口径文案数据）。 */
export interface RemindOutcome {
  readonly first: { readonly actionId: string; readonly entry: PendingEntry };
  readonly total: number;
}

// ── key 计算（纯函数——自 StewardService 迁入）────────────────

/** 内容指纹（FNV-1a 32 位十六进制——登记簿 key 的 contentHash 位；非密码学
 *  用途，只求同内容同值异内容异值且极轻）。 */
function contentHashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** 提案登记簿 key = verb|targetId|contentHash（弹卡出口唯一化的幂等键；
 *  targetId 按 verb 语义取：send=agentId / deliver=sessionId / create=title /
 *  spawnReview=type@project / surfaceAct=verb@surfaceId）。 */
export function pendingKeyOf(action: PendingAction): string {
  switch (action.kind) {
    case "send":
      return `send|${action.send!.agentId}|${contentHashOf(action.send!.message)}`;
    case "deliverSession":
      return `deliverSession|${action.deliverSession!.sessionId}|${contentHashOf(action.deliverSession!.text)}`;
    case "createSession": {
      const c = action.createSession!;
      return `createSession|${c.title}|${contentHashOf(c.initialMessage ?? "")}`;
    }
    case "spawnReview": {
      const r = action.spawnReview!;
      return `spawnReview|${r.reviewType}@${r.project}|${contentHashOf(JSON.stringify(r.params))}`;
    }
    case "surfaceAct": {
      const s = action.surfaceAct!;
      return `surfaceAct|${s.verb}@${s.surfaceId}|${s.risk}|${contentHashOf(JSON.stringify(s.args))}`;
    }
  }
}

/** 提案终局登记簿上限（FIFO 淘汰——终局记录仅服务短窗幂等判定，无持久价值）。 */
export const STEWARD_PROPOSAL_REGISTRY_MAX = 256;

// ── 聚合 ───────────────────────────────────────────────────

/**
 * 确认闸聚合（pending 卡集合 + 终局登记簿）。
 * 时钟注入（测试步进 TTL/提醒窗）；其余零依赖——出站翻译归应用层。
 */
export class ProposalLedger {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly registry = new Map<string, ProposalSettlement>();
  private readonly now: () => number;
  private readonly registryMax: number;
  private actionSeq = 0;

  constructor(deps: { now: () => number; registryMax?: number }) {
    this.now = deps.now;
    this.registryMax = deps.registryMax ?? STEWARD_PROPOSAL_REGISTRY_MAX;
  }

  /** 在途卡数（应用层 pausedGateToken 清旗判据）。 */
  get size(): number {
    return this.pending.size;
  }

  /**
   * 提案登记（弹卡出口唯一）：同 key 在途 → 复用旧卡凭据换血（TTL 重置、
   * remindedAt 保留）；同 key 已成功终局 → 拦截（blocked 携终局信息供「已
   * 做过」回灌）；否则新卡（actionId 单调递增 steward-action-N）。
   */
  propose(
    action: PendingAction,
    opts: { pauseToken?: string },
  ): ProposeOutcome {
    const key = pendingKeyOf(action);
    const existingId = this.findPendingIdByKey(key);
    if (existingId !== undefined) {
      const existing = this.pending.get(existingId)!;
      const entry: PendingEntry = {
        action: { ...action },
        key,
        pauseToken: opts.pauseToken,
        createdAt: this.now(),
        ...(existing.remindedAt !== undefined ? { remindedAt: existing.remindedAt } : {}),
      };
      this.pending.set(existingId, entry);
      return { kind: "reused", actionId: existingId, entry };
    }
    const settled = this.registry.get(key);
    if (settled !== undefined && settled.status === "succeeded") {
      return { kind: "blocked", settled };
    }
    this.actionSeq += 1;
    const actionId = `steward-action-${this.actionSeq}`;
    const entry: PendingEntry = {
      action: { ...action },
      key,
      ...(opts.pauseToken !== undefined ? { pauseToken: opts.pauseToken } : {}),
      createdAt: this.now(),
    };
    this.pending.set(actionId, entry);
    return { kind: "created", actionId, entry };
  }

  /** 新对话闸清卡面（clearHistory 调用）：仅清在途卡（自然过期语义）；
   *  终局登记簿保留（「已做过」拦截跨新对话——与批 1 前行为一致）。 */
  clear(): void {
    this.pending.clear();
  }

  /** 消费（单次语义：确认受理即删卡——执行失败也不可重放）。 */
  consume(actionId: string): PendingEntry | undefined {
    const entry = this.pending.get(actionId);
    if (entry === undefined) return undefined;
    this.pending.delete(actionId);
    return entry;
  }

  /** 作废（幂等——不存在静默；作废后同 actionId 再 confirm 报已消费）。 */
  void(actionId: string): PendingEntry | undefined {
    const entry = this.pending.get(actionId);
    if (entry === undefined) return undefined;
    this.pending.delete(actionId);
    return entry;
  }

  /**
   * 终局登记：registry 记终局（succeeded 拦重复 / voided 放行重提）+ FIFO
   * 容量上限 + **同 key 其余在途卡静默收敛**（返回被收敛清单——应用层广播
   * superseded 帧，零失效通知）。
   */
  settle(key: string, status: "succeeded" | "voided", actionId: string, detail: string): { actionId: string; entry: PendingEntry }[] {
    this.registry.delete(key);
    this.registry.set(key, { status, actionId, detail, settledAt: this.now() });
    if (this.registry.size > this.registryMax) {
      const oldest = this.registry.keys().next().value;
      if (oldest !== undefined && oldest !== key) this.registry.delete(oldest);
    }
    const collapsed: { actionId: string; entry: PendingEntry }[] = [];
    for (const [otherId, other] of [...this.pending]) {
      if (otherId === actionId) continue;
      if ((other.key ?? pendingKeyOf(other.action)) !== key) continue;
      this.pending.delete(otherId);
      collapsed.push({ actionId: otherId, entry: other });
    }
    return collapsed;
  }

  /** 登记簿终局查询（「已做过」拦截判定面）。 */
  settledOf(key: string): ProposalSettlement | undefined {
    return this.registry.get(key);
  }

  /** 在途同 key 卡定位（key 缺席时现算回退——防御注入态）。 */
  findPendingIdByKey(key: string): string | undefined {
    for (const [actionId, entry] of this.pending) {
      if ((entry.key ?? pendingKeyOf(entry.action)) === key) return actionId;
    }
    return undefined;
  }

  /** 最近一张 pending 卡（口令路由绑定锚——createdAt 最大，相等取后入）。 */
  latestPendingActionId(): string | undefined {
    let latest: { id: string; createdAt: number } | undefined;
    for (const [actionId, entry] of this.pending) {
      if (latest === undefined || entry.createdAt >= latest.createdAt) latest = { id: actionId, createdAt: entry.createdAt };
    }
    return latest?.id;
  }

  /** 在途卡快照（steward.pending.snapshot 帧——插入序；跨重启对账）。 */
  pendingSnapshot(): readonly string[] {
    return [...this.pending.keys()];
  }

  /** 在途卡条目读面（口令路由/意图判官消费）。 */
  entryOf(actionId: string): PendingEntry | undefined {
    return this.pending.get(actionId);
  }

  /** 在途卡条目列表（插入序——system prompt 在途提案段组装）。 */
  entries(): readonly PendingEntry[] {
    return [...this.pending.values()];
  }

  /**
   * TTL 批次作废（快照式）：返回到期卡列表**不删除**——删除由应用层逐卡
   * markExpired 驱动（复现原版帧时序：同批同 key 卡先被前卡 settle 收敛发
   * superseded 帧、后仍按快照发 timeout 帧；删除在循环内逐个发生）。
   * 未到期零返回；幂等空集。
   */
  expireDue(now: number, ttlMs: number): { actionId: string; entry: PendingEntry }[] {
    const expired: { actionId: string; entry: PendingEntry }[] = [];
    for (const [actionId, entry] of this.pending) {
      if (now - entry.createdAt < ttlMs) continue;
      expired.push({ actionId, entry });
    }
    return expired;
  }

  /** 到期卡逐个删除（快照循环体内调用；已被同 key 收敛先行删除 → undefined
   *  幂等 no-op——帧发射归应用层快照无条件驱动）。 */
  markExpired(actionId: string): PendingEntry | undefined {
    const entry = this.pending.get(actionId);
    if (entry === undefined) return undefined;
    this.pending.delete(actionId);
    return entry;
  }

  /**
   * 可达性提醒（聚合口径一条）：任一卡成熟（无人消费超 remindAfterMs）→
   * 覆盖全集 remindedAt（后熟卡零二次提醒）并返回 { first, total }——应用层
   * 按 N 组装单条提醒文案；已提醒/未成熟 → undefined。
   */
  remindDue(now: number, remindAfterMs: number): RemindOutcome | undefined {
    let matured: { actionId: string; entry: PendingEntry } | undefined;
    for (const [actionId, entry] of this.pending) {
      if (entry.remindedAt !== undefined) continue;
      if (now - entry.createdAt < remindAfterMs) continue;
      matured = { actionId, entry };
      break; // 聚合口径：任一成熟即代表全集出一条（文案按全集 N 组装）
    }
    if (matured === undefined) return undefined;
    const total = this.pending.size;
    for (const entry of this.pending.values()) entry.remindedAt = now; // 覆盖全集
    return { first: matured, total };
  }

  /**
   * run 收口卡处置（生命周期统一）：非 destructive 卡续活（意图不随 run 死
   * 而失效——返回 kept 供应用层记日志）；destructive（surfaceAct risk 档）
   * 即时撤除（从 pending 删除并返回 withdrawn——应用层广播 superseded 回执
   * 与高风险撤回通知）；已终局（先 confirm/cancel）零处置。
   */
  resolveRunCards(actionIds: readonly string[]): RunCardsResolution {
    const kept: { actionId: string; action: PendingAction }[] = [];
    const withdrawn: { actionId: string; action: PendingAction }[] = [];
    for (const actionId of actionIds) {
      const entry = this.pending.get(actionId);
      if (entry === undefined) continue; // 已终局（确认/作废先行）——无处置
      const destructive = entry.action.kind === "surfaceAct" && entry.action.surfaceAct?.risk === "destructive";
      if (!destructive) {
        kept.push({ actionId, action: entry.action });
        continue;
      }
      this.pending.delete(actionId);
      withdrawn.push({ actionId, action: entry.action });
    }
    return { kept, withdrawn };
  }
}
