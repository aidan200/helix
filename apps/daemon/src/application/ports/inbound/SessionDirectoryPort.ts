import type { SessionStateView } from "./SessionPort";
import type { SendOutcome } from "./ChatPort";

/**
 * 会话目录入口端口（inbound，architecture.md §3.4；T2.2 AD-4）。
 *
 * session 族命令（list / loadHistory / delete / subscribe 目标解析）与草稿
 * 建会话链的统一入口：多会话容器（SessionRegistry）的 driving 侧取数面。
 * 本文件只有接口定义（port 铁律 AG-01：零实现）。
 */

/** 会话运行态（协议 SessionMeta.runState 的 domain 侧词汇）。 */
export type SessionRunState = "idle" | "streaming" | "subagent_running";

/**
 * 会话清单条目（session.list / session.list_changed 元素；协议 SessionMeta
 * 的 domain 侧镜像——DTO 映射在 DtoMapper）。
 */
export interface SessionMetaView {
  readonly sessionId: string;
  /** 自动命名（首条用户消息截 20 码点）；未落草稿会话为空串。 */
  readonly title: string;
  /** epoch ms；list 按此降序。 */
  readonly lastActivityAt: number;
  readonly runState: SessionRunState;
  /** 注册表内（热）与否（冷）。 */
  readonly loaded: boolean;
}

/** session.list_changed 载荷（契约 B §2.1）。 */
export interface SessionListChange {
  readonly kind: "created" | "deleted" | "state_changed";
  readonly sessionId?: string;
  readonly session?: SessionMetaView;
}

export interface SessionDirectoryPort {
  /** 会话清单元数据（按 lastActivityAt 降序；含热未落库草稿会话）。 */
  listSessions(): Promise<readonly SessionMetaView[]>;
  /** 会话存在性（注册表热会话或已持久化冷会话）。 */
  sessionExists(sessionId: string): Promise<boolean>;
  /**
   * 目标会话解析（会话作用域命令路由位）：缺省 = 当前会话；不存在抛
   * SessionNotFoundError。存在即热加载（懒加载入口）。
   */
  resolveTarget(sessionId: string | undefined): Promise<string>;
  /** 会话快照视图（懒加载目标会话；缺省当前会话）。 */
  getSessionView(sessionId?: string): Promise<SessionStateView>;
  /**
   * 草稿建会话链（契约 B §1.5 定稿）：新建聚合（未落库——首条消息的事件
   * write-through 才 INSERT）+ 广播 list_changed{created} + 首条消息发送
   * （fire-and-forget，事件流可观测）。返回新会话 id。
   */
  startDraftSession(text: string): Promise<{ sessionId: string }>;
  /**
   * 会话删除（顺序硬约束，契约 B §1.4）：取消该会话全部执行（主线 abort +
   * SubAgent queued→cancelled / running→kill）**完成** → 删库 → 注册表移除
   * → 广播 list_changed{deleted}。不存在抛 SessionNotFoundError；重复请求
   * 抛 SessionDeleteInProgressError。
   */
  deleteSession(sessionId: string): Promise<void>;
  /** 当前会话 id（最近活跃；daemon 存续期恒有值）。 */
  currentSessionId(): string;
}
