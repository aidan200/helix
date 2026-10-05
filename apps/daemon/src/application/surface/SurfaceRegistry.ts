/**
 * SurfaceRegistry —— 表面协议组合根（M0 表面协议地基批；设计稿 §1/D3/D7/D8）。
 *
 * 每宿主一个 adapter 包（observe 上行 + act 下行），本注册表持有全部已注册
 * 表面：注册/注销 + observe 归一入口 + act 路由（verb→adapter，capabilities
 * 判据）+ 执行回执簿记（D7-1 原子性——seq 单调 + pending/completed 对账）。
 *
 * 协议纪律：
 * - D8 指令帧恒一种：本面产出的下行帧只经 sendAction（surface.action）；
 *   navigate 存量收编兼容期镜像旧 steward.navigate（emitLegacyNavigate——
 *   **M1 前检查点删除点**，调用面唯一）；
 * - D2 词汇表封闭：observe 拒收词汇表外 kind/origin；
 * - D7-2 回声过滤预备：动作帧 origin 恒 "steward"（消费接线留 M1）。
 *
 * M0 边界：动词注册校验面（防私造动词/跨表面同义不同名）留 M2——act 对
 * 未声明动词按「零目标拒绝」处理（delivered 0 + reason），不做白名单。
 */
import {
  isSurfaceEventKind,
  isSurfaceEventOrigin,
  isSurfaceNamespaceKind,
  surfaceIdOf,
  type SurfaceActionPayload,
  type SurfaceDescriptor,
  type SurfaceEvent,
  type SurfaceEventUplinkPayload,
  type SurfaceNamespaceKind,
  type SurfaceRisk,
} from "@helix/protocol";

/** 归一后事件观察者（M1 起组合根订阅面接管家感知 ring——StewardPerceptionService.onSurfaceEvent）。 */
export type SurfaceEventObserver = (event: SurfaceEvent) => void;

export interface SurfaceRegistryDeps {
  /**
   * 动作帧下发口（定向到具体表面连接——D8 与事件总线的分野）：key =
   * 注册时的连接身份（ws 层 sender），帧组装归 adapter 层
   * （EventStream.sendSurfaceAction）。
   */
  readonly sendAction: (key: unknown, action: SurfaceActionPayload) => void;
  /**
   * 兼容期双发镜像口（D8 存量收编③）：verb=navigate 时镜像旧
   * steward.navigate 广播——**M1 前检查点删除点**（组合根接线
   * EventStream.broadcastStewardNavigate）。
   */
  readonly emitLegacyNavigate?: (args: { sessionId: string }) => void;
  /** 时钟（observe/act 盖章 at；缺省 Date.now）。 */
  readonly now?: () => number;
}

/** 已注册表面（连接级身份 + 能力面）。 */
export interface RegisteredSurface {
  /** 命名空间（descriptor.kind——surfaceId 第一段）。 */
  readonly namespace: SurfaceNamespaceKind;
  /** daemon 分配的连接内表面身份（surfaceId 第二段）。 */
  readonly connId: string;
  /** 表面自述（幂等重注册覆盖）。 */
  readonly descriptor: SurfaceDescriptor;
}

/** act 结果（回执面向编排/接线层）。 */
export interface SurfaceActOutcome {
  /** 动词回显。 */
  readonly verb: string;
  /** 执行回执序号（registry 内单调 1 起——D7-1）。 */
  readonly seq: number;
  /** 实际送达表面数。 */
  readonly delivered: number;
  /** 送达表面 id 清单（前缀态：`<namespace>:<connId>`）。 */
  readonly targets: readonly string[];
  /** 未路由原因（delivered 0 时携带——如无表面声明该动词能力）。 */
  readonly reason?: string;
}

/** 在途动作记录（receipt 未销账前）。 */
export interface PendingSurfaceAction {
  readonly seq: number;
  readonly verb: string;
  readonly targets: readonly string[];
  readonly sentAt: number;
}

/** 已销账动作记录（回执到达；滚动上限保留最近 N 条）。 */
export interface CompletedSurfaceAction extends PendingSurfaceAction {
  readonly ok: boolean;
  readonly detail?: string;
}

/** completed 滚动上限（M0 诊断面；回执主面是对账销账本身）。 */
const COMPLETED_RING_CAP = 50;

/** 单表面连接的注册簿记。 */
interface SurfaceEntry {
  readonly connId: string;
  descriptor: SurfaceDescriptor;
}

export class SurfaceRegistry {
  private readonly entries = new Map<unknown, SurfaceEntry>();
  private connSeq = 0;
  private actionSeq = 0;
  private readonly pending = new Map<number, PendingSurfaceAction>();
  private readonly completed: CompletedSurfaceAction[] = [];
  private readonly observers = new Set<SurfaceEventObserver>();

  constructor(private readonly deps: SurfaceRegistryDeps) {}

  /**
   * 表面注册（surface.register）：幂等——同 key 重注册覆盖 descriptor（能力
   * 面收窄/扩宽即时生效），connId 身份保持。key = 连接发送端身份（ws 层
   * sender 引用；断连 unregister 对称清账）。
   */
  register(key: unknown, descriptor: SurfaceDescriptor): RegisteredSurface {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      existing.descriptor = descriptor;
      return { connId: existing.connId, descriptor, namespace: descriptor.kind };
    }
    this.connSeq += 1;
    const connId = `c${this.connSeq}`;
    this.entries.set(key, { connId, descriptor });
    return { connId, descriptor, namespace: descriptor.kind };
  }

  /** 表面注销（surface.unregister / 断连自动等效；幂等）。 */
  unregister(key: unknown): void {
    this.entries.delete(key);
  }

  /**
   * observe 归一入口（surface.event 上行）：词汇表校验 + surfaceId 盖章
   * （`<namespace>:<connId>:<page>`）+ at 盖章 → 投递观察者。拒收面（返回
   * null）：未注册连接 / kind 或 origin 词汇表外 / page 非法——上行是遥测
   * 流量，拒收不回执（handler 层结构性错误才回 command.invalid_payload）。
   */
  observe(key: unknown, uplink: SurfaceEventUplinkPayload): SurfaceEvent | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (!isSurfaceEventKind(uplink.kind) || !isSurfaceEventOrigin(uplink.origin)) return null;
    if (typeof uplink.page !== "string" || uplink.page === "") return null;
    const event: SurfaceEvent = {
      kind: uplink.kind,
      origin: uplink.origin,
      surfaceId: surfaceIdOf(entry.descriptor.kind, entry.connId, uplink.page),
      at: this.deps.now?.() ?? Date.now(),
      ...(uplink.detail !== undefined ? { detail: uplink.detail } : {}),
    };
    for (const o of this.observers) o(event);
    return event;
  }

  /**
   * daemon 内 adapter 直出归一口（M1 browser adapter）：browser 表面寻址是
   * 两段 `browser:<targetId>`（设计 §1：tab 即表面，无 page 维度）——与连接
   * 型表面三段 `<ns>:<connId>:<page>` 盖章不同，surfaceId 由 daemon 内
   * adapter 盖章（「表面不自报身份」纪律面向外部表面连接；browser adapter
   * 与 Registry 同进程同信任域）。Registry 仍单点收口 D2 词汇表守卫 +
   * surfaceId 命名空间形状守卫 + at 盖章 + 观察者分发。
   *
   * 拒收面（返 null）：kind/origin 词汇表外 / surfaceId 不是
   * `<命名空间>:<非空尾段>`——遥测流量拒收不回执。
   */
  observeDirect(ingress: {
    kind: unknown;
    origin: unknown;
    surfaceId: string;
    detail?: Record<string, unknown>;
  }): SurfaceEvent | null {
    if (!isSurfaceEventKind(ingress.kind) || !isSurfaceEventOrigin(ingress.origin)) return null;
    const sep = ingress.surfaceId.indexOf(":");
    const ns = sep > 0 ? ingress.surfaceId.slice(0, sep) : "";
    if (!isSurfaceNamespaceKind(ns) || sep === ingress.surfaceId.length - 1) return null;
    const event: SurfaceEvent = {
      kind: ingress.kind,
      origin: ingress.origin,
      surfaceId: ingress.surfaceId,
      at: this.deps.now?.() ?? Date.now(),
      ...(ingress.detail !== undefined ? { detail: ingress.detail } : {}),
    };
    for (const o of this.observers) o(event);
    return event;
  }

  /**
   * 动作路由（act——编排/接线层入口，navigate 收编后 StewardService 的
   * emitNavigate 出口）：按 capabilities 精确匹配 verb 分发 surface.action
   * 帧（seq 单调；origin 恒 "steward"——D7-2 预备）。未声明动词零目标拒绝
   * （动词注册校验面 M2）。兼容期 verb=navigate 镜像旧帧（M1 删除点）。
   */
  act(verb: string, args: Record<string, unknown>, opts: { risk: SurfaceRisk }): SurfaceActOutcome {
    this.actionSeq += 1;
    const seq = this.actionSeq;
    const targets: string[] = [];
    for (const [key, entry] of this.entries) {
      if (!entry.descriptor.capabilities.includes(verb)) continue;
      // 前缀态 surfaceId（`ns:connId`）——页面级寻址由表面侧消费帧时自定
      const surfaceId = `${entry.descriptor.kind}:${entry.connId}`;
      targets.push(surfaceId);
      this.deps.sendAction(key, { verb, args, risk: opts.risk, seq, origin: "steward", surfaceIds: [surfaceId] });
    }
    // D8 兼容期双发：navigate 镜像旧 steward.navigate（广播面与路由面正交——
    // 零注册表面时旧 shell 仍可收旧帧；M1 前检查点删除）
    if (verb === "navigate" && this.deps.emitLegacyNavigate !== undefined) {
      const sessionId = args.sessionId;
      if (typeof sessionId === "string") this.deps.emitLegacyNavigate({ sessionId });
    }
    if (targets.length === 0) {
      return {
        verb,
        seq,
        delivered: 0,
        targets: [],
        reason: `无已注册表面声明动词能力（verb=${verb}）——能力经 surface.register capabilities 协商`,
      };
    }
    this.pending.set(seq, { seq, verb, targets, sentAt: this.deps.now?.() ?? Date.now() });
    return { verb, seq, delivered: targets.length, targets };
  }

  /**
   * 执行回执销账（surface.action.result 上行）：seq 对账 pending → completed
   * 滚动环（D7-1）。未知/已销账 seq 返 false（迟到回执无害）。
   */
  receipt(_key: unknown, seq: number, ok: boolean, detail?: string): boolean {
    void _key; // 回执按 seq 对账（连接身份不参与——帧已定向送达）
    const entry = this.pending.get(seq);
    if (entry === undefined) return false;
    this.pending.delete(seq);
    this.completed.push({ ...entry, ok, ...(detail !== undefined ? { detail } : {}) });
    if (this.completed.length > COMPLETED_RING_CAP) this.completed.shift();
    return true;
  }

  /** 观察者登记（M0 测试/诊断面；L2 归一层 M3 接线）。 */
  addObserver(observer: SurfaceEventObserver): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  /** 在途动作读面（诊断/测试）。 */
  pendingActions(): readonly PendingSurfaceAction[] {
    return [...this.pending.values()];
  }

  /** 已销账动作读面（滚动环；诊断/测试）。 */
  completedActions(): readonly CompletedSurfaceAction[] {
    return [...this.completed];
  }
}
