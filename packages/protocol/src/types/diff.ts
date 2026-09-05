import type { EventFrame } from "../envelope";

/**
 * diff 域 DTO（T3+T4 轮次 diff 协议与 UI 闭环批；PROTOCOL-CHANGELOG.md §26）。
 *
 * 数据源 = daemon TurnDiffService（轮次级内存态 diff 纯操作面——轮为单位
 * 累积、冻结环形 3 轮、全内存零持久化）。统计口径只有 +N（新增行）/ −N
 * （删除行）两维——无第三统计（口径已裁）；文件级 status 四值保留。
 *
 * diff.changed 走 publishDelta 瞬态通道（流式中间态语义：不落盘、不投影、
 * EventStream 直推——chat.stream.delta / thinking.stream.delta 先例）；
 * diff.get 结果帧为点对点回执（窄化接口不入 EVENT_TYPES 目录——task 族
 * 先例口径，契约 §0 计数纪律）。
 */

// ── payload ──────────────────────────────────────────────────

/**
 * diff.changed：轮次 diff 状态瞬态推送（T3）。
 * phase 三态语义：cleared = 开轮清零（新轮 beginTurn）；active = 轮内累计
 * （写记账后即时视图——条目级即时终读 + patch 精确 / size 差粗估）；frozen
 * = 收轮冻结终值（精确统计）。adds/dels = 当前累计 ±行数。
 */
export interface DiffChangedPayload {
  /** 归属轮次 id（与 chat.turn.started 的 turnId 同源）。 */
  turnId: string;
  /** 轮次态：cleared（清零）/ active（累计中）/ frozen（冻结终值）。 */
  phase: "active" | "frozen" | "cleared";
  /** 累计新增行数（+N 维）。 */
  adds: number;
  /** 累计删除行数（−N 维）。 */
  dels: number;
  /** 本轮已记账文件数。 */
  fileCount: number;
}

/** diff.get 载荷：轮次 diff 详情查询（session 作用域——信封 sessionId 必填）。 */
export interface DiffGetPayload {
  /**
   * 目标冻结轮 id（缺省 = 最近冻结轮）；与 live 互斥优先级：live=true 时
   * 本字段忽略（live 查的是进行中轮）。
   */
  turnId?: string;
  /** true = 进行中轮实时视图（active 条目即时终读统计）；缺省 = 冻结视图。 */
  live?: boolean;
}

/** diff.get.result 文件行（frozen 与 live 视图共形）。 */
export interface DiffFileDto {
  /** 文件路径（daemon 侧绝对路径原样透传）。 */
  path: string;
  /** 文件级状态四值（added/deleted/modified/external）。 */
  status: "added" | "deleted" | "modified" | "external";
  /** 该文件新增行数。 */
  adds: number;
  /** 该文件删除行数。 */
  dels: number;
  /** unified diff 文本（daemon 已算好——前端纯渲染着色）；降级/external 条目缺省。 */
  diff?: string;
  /** external 条目备注（±粗估行说明——外部进程变更无精确原文）；内容条目缺省。 */
  note?: string;
  /** 归属 agent 集（多值：主实例 "main" / SubAgent 短 id / external 无归属空数组）。 */
  agents: readonly string[];
}

/** diff.get.result 载荷。 */
export interface DiffGetResultPayload {
  /** 文件行清单（路径升序）。 */
  files: readonly DiffFileDto[];
  /** 轮级统计汇总。 */
  summary: { adds: number; dels: number };
  /** 回执归属轮次 id（v0.3.1 §27：rehydrate 面消费——轮次守卫防降级覆盖）。 */
  turnId: string;
  /** 回执轮相位（v0.3.1 §27：active=进行中轮实时 / frozen=冻结轮；chip 灰态判定）。 */
  phase: "active" | "frozen";
}

// ── 信封（点对点回执窄化接口——不入 EVENT_TYPES 目录，task 族先例） ──

/**
 * diff.get.result：轮次 diff 详情点对点回执（session 作用域；信封 sessionId
 * = 目标会话、channel = session；仅发发起命令的连接）。
 */
export interface DiffGetResultEvent extends EventFrame<DiffGetResultPayload> {
  channel?: "session";
  type: "diff.get.result";
}
