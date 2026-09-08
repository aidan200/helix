/** 会话域命令族：chat.* / session 订阅与目录 / agent.*（v0.1 手动终止权）。 */
import type { CommandFrame } from "../envelope";
import type { SessionListResultPayload } from "../events";
import type { SessionLoadHistoryResultEventPayload } from "../events/session";
import type { EntryDto } from "../types/session";

export interface ChatSendPayload {
  text: string;
  /**
   * 草稿建会话标记（v0.2 新增，契约 B §1.5 定稿）：draft=true 且信封 sessionId
   * 省略 → daemon 新建会话聚合落库（首条用户消息即建会话）；sessionId 携带
   * 时忽略本标记（既有会话内发送）。
   */
  draft?: boolean;
  /**
   * 建会话模型（T4，additive）：仅 draft:true 建会话链消费——用户建会话前
   * 选定的模型；缺省 = 全局默认（不换模）。
   */
  model?: string;
  /**
   * 建会话模式（P1 会话模式框架 T2，additive；PROTOCOL-CHANGELOG.md §18）：仅
   * draft:true 建会话链消费——草稿态选定的会话模式（唯一设置入口；建会话
   * 定格锁定，无 mode.set 命令——锁定 = 结构不可能，非校验拒绝）；缺省 =
   * "default"（旧客户端兼容）。字符串透传：未知 mode 由 daemon 模式注册表
   * fallback "default"（T3），协议面不校验注册表成员资格（AD-2 同构）。
   */
  mode?: string;
  /**
   * 图片附件（v0.10 新增，T9 图片上行）：base64 data URL 数组
   * （`data:image/png;base64,…`，≤4 张、单张解码后 ≤2MB——超限 daemon
   * 回中文错误不落消息）；缺省 = 纯文本发送（additive 纪律）。daemon 解码
   * 后转 ImageContent[] 交引擎（agent.prompt(input, images)）。
   */
  images?: readonly string[];
}

/** chat.steer 载荷：生成中注入消息（ChatPort.steer → SteerQueue.enqueue） */
export interface ChatSteerPayload {
  text: string;
  /** 目标实例（v0.3 新增，契约 v0.3 §3）：缺省 = 主实例（既有语义不变）；携带时路由归 ChatService（TR-AD-9） */
  instanceId?: string;
}

/** 无载荷命令的空 payload */
export type EmptyPayload = Record<string, never>;

export interface ChatSendCommand extends CommandFrame<ChatSendPayload> {
  type: "chat.send";
}
export interface ChatSteerCommand extends CommandFrame<ChatSteerPayload> {
  type: "chat.steer";
}
/** 中断当前生成（ChatPort.abort） */
export interface ChatAbortCommand extends CommandFrame<EmptyPayload> {
  type: "chat.abort";
}
/**
 * session.subscribe 载荷（v0.3 新增，契约 v0.3 §2，Q-2b②）：订阅档位。
 * 缺省 full（既有语义不变）；monitor 档白名单过滤归 daemon 事件分发层
 * 一处（T2.2 落地，协议面仅类型）。同连接同会话重复 subscribe 换 tier =
 * 幂等更新，不新增命令对（TR-AD-23①）。
 */
export interface SessionSubscribePayload {
  /** 订阅档位：full = 全量（缺省）；monitor = 3 事件白名单（Q-2a 消息档） */
  tier?: "full" | "monitor";
}

/**
 * 订阅会话事件流。v0.2 升级语义（契约 B §1.2，AD-4）：从「连接级全量广播
 * 开关」升级为「按会话订阅」——**信封 sessionId 必填**，连接订阅某会话后
 * 只收该会话（+系统级）事件帧；v0.3 起 payload 携带可选 tier 档位
 * （SessionSubscribePayload，缺省 full；原 EmptyPayload 形态仍合法）。
 */
export interface SessionSubscribeCommand extends CommandFrame<SessionSubscribePayload> {
  type: "session.subscribe";
}
/** 退订会话事件流（v0 通路语义保留；per-session 语义随 T2.1 定稿） */
export interface SessionUnsubscribeCommand extends CommandFrame<EmptyPayload> {
  type: "session.unsubscribe";
}

// ── v0.1 新增（契约 protocol-v0.1.md §4；AD-7 手动终止权在用户） ──

/** agent.kill 载荷：用户终止实例（抽屉 kill 两步确认后发送） */
export interface AgentKillPayload {
  agentId: string;
}
/** agent.subscribe 载荷：订阅实例全流（v0.1 通路语义，不做事件过滤） */
export interface AgentSubscribePayload {
  agentId: string;
}
/** agent.unsubscribe 载荷：退订实例全流（同上） */
export interface AgentUnsubscribePayload {
  agentId: string;
}

/** 用户终止实例；正常路径回执 agent.killed 事件（单一终态） */
export interface AgentKillCommand extends CommandFrame<AgentKillPayload> {
  type: "agent.kill";
}
/** 订阅实例事件流（v0.1 通路语义：订阅表 + 全广播，见 PROTOCOL-CHANGELOG.md §10.6） */
export interface AgentSubscribeCommand extends CommandFrame<AgentSubscribePayload> {
  type: "agent.subscribe";
}
/** 退订实例事件流（v0.1 通路语义） */
export interface AgentUnsubscribeCommand extends CommandFrame<AgentUnsubscribePayload> {
  type: "agent.unsubscribe";
}

// ── v0.2 新增：session 族（契约 B §1；AD-1 / AD-4） ──

/**
 * 会话清单条目响应（session.list 结果载荷；SessionMeta 同源）。
 * T4.1（CL-5 漂移合一）：与 events.ts SessionListResultPayload 同形双定义收敛为
 * 单定义——权威位 = 事件线形 SessionListResultPayload（session.list.result 实帧
 * 载荷），本名为兼容别名（协议面 additive 纪律 TR-AD-18，不删导出名）。
 */
export type SessionListResult = SessionListResultPayload;

/** session.list 载荷：全局命令（信封 sessionId 省略） */
export interface SessionListCommand extends CommandFrame<EmptyPayload> {
  type: "session.list";
}

/**
 * session.loadHistory 载荷（AD-1 分页回溯）：信封 sessionId 必填；
 * 返回 beforeEntryId 之前的更早历史（时间升序）。
 */
export interface SessionLoadHistoryPayload {
  /** 游标：当前最早 entry id；首页 = 尾窗最早 entry id（快照 DTO 下发） */
  beforeEntryId: string;
  /** 缺省 50（G-1 分页大小），上限 200（防滥用） */
  limit?: number;
}

/** session.loadHistory 结果载荷（code-review M56：收敛为 events 侧载荷的类型别名——T4.1 同规消同形双定义漂移面） */
export type SessionLoadHistoryResult = SessionLoadHistoryResultEventPayload;

export interface SessionLoadHistoryCommand
  extends CommandFrame<SessionLoadHistoryPayload> {
  type: "session.loadHistory";
}

/**
 * session.delete 载荷（Q-4④）：信封 sessionId 必填；payload 空（路由位在
 * 信封）。daemon 顺序硬约束：取消全部执行完成 → 删库 → 注册表移除 →
 * 广播 session.list_changed（T2.2 落地）。
 */
export interface SessionDeleteCommand extends CommandFrame<EmptyPayload> {
  type: "session.delete";
}

