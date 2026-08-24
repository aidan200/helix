/**
 * 聊天消息 DTO（契约 §6；review.md mock 载体字段结构对齐：role/content/ts）。
 */

/** 消息角色 */
export type ChatRole = "user" | "assistant";

/**
 * steer 消息状态（仅 chat.steer 产生的用户消息携带）。
 * queued = 已入 SteerQueue（steer.queued 事件）；drained = turn 边界注入完成
 * （steer.drained 事件）。对应前端徽标两态「STEER·已入队 / 已注入·本轮结束」。
 */
export type SteerState = "queued" | "drained";

/** 轮次结束原因（chat.turn.completed.reason） */
export type TurnCompletionReason = "completed" | "aborted";

/**
 * 注入来源（v0.11 批内补登，T11a closure/steer source 贯通）：helix 自有
 * 三值枚举（AD-2 字符串透传原则不适用——协议面定死）。
 * user=用户 steer；closure=SubAgent 收口注入（AD-8）；progress=周期进展
 * 报告（SchedulerService injectClosure 同通道）。可选 additive：老事件/
 * 老快照缺省 = undefined，消费侧按 user 渲染。
 */
export type SteerSource = "user" | "closure" | "progress";

/**
 * 消息条目（EntryDto 的 message 变体）。
 * `steerState` 仅 chat.steer 产生的用户消息携带；普通消息不携带。
 */
export interface MessageEntryDto {
  kind: "message";
  id: string;
  role: ChatRole;
  /** 最终内容（流式中间态走 chat.stream.delta，不落盘，AD-16） */
  content: string;
  /** 创建时间（epoch 毫秒）——T1.2 定稿：线格式为 number（回填契约 §9） */
  ts: number;
  steerState?: SteerState;
  /** 实例归属（v0.1 新增，AD-3）：可选；缺省 = 主实例（"main"） */
  instanceId?: string;
  /** 注入来源（v0.11 批内补登 T11a）：仅注入类 user 消息携带；缺省 = 用户输入 */
  source?: SteerSource;
  /**
   * 图片附件（v0.10 新增，T9 图片上下行）：base64 data URL 数组
   * （`data:image/png;base64,…`，自包含免文件服务）；仅 user 消息携带
   * （chat.send.images 透传；assistant 不产图不带）。缺省 = 纯文本旧形态
   * （additive 纪律，旧客户端零破坏）。数量 ≤4、单张 ≤2MB（daemon
   * ChatService 校验，协议面仅形状）。
   */
  images?: readonly string[];
}
