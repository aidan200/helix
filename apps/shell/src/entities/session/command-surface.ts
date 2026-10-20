/**
 * entities/session —— SessionContext 命令/订阅面注册表（M38 注册表化）。
 *
 * 原「接口声明 + useCallback + value 对象 + deps 数组」四点联动收敛为单一
 * 登记点：COMMAND_SURFACE（命令面，键 = SessionContextValue 方法名，值 =
 * deps → 方法实现 的工厂）与 LISTEN_SURFACE（订阅面，键 = subscribe* 方法名，
 * 值 = 帧匹配谓词）。SessionContextValue 的命令/订阅面类型由注册表键派生，
 * provider 侧一次性构建整个面后摊入 context value——新增域命令 = 本文件追加
 * 一条注册表项，不再存在漏登 value 对象 / 漏登 deps 数组的结构性缺陷面。
 *
 * 纪律：纯工厂模块——无 React / 无 IO（IO 全部经 deps 注入）；命令帧形状
 * 一律走 shared/api/commands 构造器（E-84 契约不改形状）；FSD 归属
 * entities/session（TR-23）。
 */
import type { CommandEnvelope, EventEnvelope } from "@helix/protocol";
import type { SessionAction, TopologyState } from "./model/state";
import type { SubscriptionLedger } from "./model/subscription-ledger";
/** 命令面注册表（内容）拆分至 command-surface-commands.ts（P2 体量门 ④ 轻拆批：
 *  机械迁出零逻辑改动）；此处 re-export 保公共 API 面不变（消费方零感知）。 */
export { COMMAND_SURFACE } from "./command-surface-commands";
import { COMMAND_SURFACE } from "./command-surface-commands";

/**
 * 命令面工厂依赖面（provider 注入的全部 IO/读取缝；全部经 ref 间接取值，
 * 工厂产物天然稳定——原实现所有 useCallback 均为零 deps 即证）。
 */
export interface CommandSurfaceDeps {
  /** 出站命令帧发送（client.send；返回 false = 未连接发送失败）。 */
  readonly send: (cmd: CommandEnvelope) => boolean;
  /** 拓扑根 reducer action 派发（ui/* / session/* / model/* / conn/* 族）。 */
  readonly dispatch: (action: SessionAction) => void;
  /** 读当前拓扑（命令构造读点：活跃会话 id / 分页游标 / modelConfig 态）。 */
  readonly getTopology: () => TopologyState;
  /** 读 v0.3 订阅图簿记（订阅生命周期唯一权威；监控窗口模型见
   *  model/subscription-ledger / E-192）。 */
  readonly getLedger: () => SubscriptionLedger;
  /** 读当前生成态（submit 发送语义分流：空闲 turn / 生成中 steer）。 */
  readonly isGenerating: () => boolean;
  /** 手动重试连接（SM-2；client.retry 透传）。 */
  readonly retryConnection: () => void;
}


/** 命令面类型（SessionContextValue 方法面由注册表键派生——注册表项即唯一登记点）。 */
export type CommandSurface = {
  readonly [K in keyof typeof COMMAND_SURFACE]: ReturnType<(typeof COMMAND_SURFACE)[K]>;
};

/** 一次性构建整个命令面（deps 全经 ref 间接取值，产物引用天然稳定）。 */
export function buildCommandSurface(deps: CommandSurfaceDeps): CommandSurface {
  const out: Record<string, unknown> = {};
  for (const [key, factory] of Object.entries(COMMAND_SURFACE)) {
    out[key] = factory(deps);
  }
  return out as CommandSurface;
}

// ── 订阅面注册表（连接私有回执/广播转发；M38）──────────────────
// 键 = subscribe* 方法名；值 = 帧匹配谓词（命中即转发本域听众集）。provider
// onFrame 按本表驱动转发（顺序 = 声明顺序），订阅方法由键统一派生——新增域
// 订阅面 = 本表追加一条，听众集/转发分支/方法登记零手工联动。

/** 帧监听器形态（页面私有 reducer 消费，会话 store 零写入）。 */
export type FrameListener = (e: EventEnvelope) => void;

/** 订阅面域声明：帧匹配谓词（按 event.type 判定）。 */
interface ListenDomainSpec {
  readonly match: (type: string) => boolean;
}

export const LISTEN_SURFACE = {
  /** 订阅 trace 族点对点回执（trace.query.result；另转发 connection.error
   *  供在途查询错误态判定——关联靠页面单飞：仅在 pending 非空时消费）。 */
  subscribeTraceFrames: {
    match: (type) => type === "trace.query.result" || type === "connection.error",
  },
  /** 订阅 diff 族点对点回执（diff.get.result；connection.error 一并转发
   *  供 DiffOverlay 在途错误态判定——trace 族先例同构。diff.changed 广播
   *  走 consumers/diff 真消费，不经此转发）。 */
  subscribeDiffFrames: {
    match: (type) => type === "diff.get.result" || type === "connection.error",
  },
  /** 订阅 agent.config 族点对点回执（list.result / set_enabled.result /
   *  base_prompt.get.result / skill_content.get.result；changed 广播走拓扑级
   *  消费，不在此转发）。connection.error 一并转发——set_enabled 写面 daemon
   *  失败回执清在途（F5 批 #2；单飞门控消费，trace 族先例）。 */
  subscribeAgentConfigFrames: {
    match: (type) =>
      type === "agent.config.list.result" ||
      type === "agent.config.set_enabled.result" ||
      type === "agent.base_prompt.get.result" ||
      type === "agent.skill_content.get.result" ||
      type === "agent.skill.create.result" ||
      type === "agent.steward_profile.get.result" ||
      type === "connection.error",
  },
  /** 订阅 kg 族点对点回执（kg.*.result + code.review.create.result——评审回执
   *  挂既有 kg 通道，E-99；F5 批 #5 补登，TR-89 双登记纪律；O-6 零推送事件，
   *  回执全走此处；connection.error 一并转发——bootstrap 入口/写面在途错误
   *  判定靠页面单飞门控，task 族先例）。 */
  subscribeKgFrames: {
    match: (type) =>
      type === "connection.error" ||
      type === "code.review.create.result" ||
      (type.startsWith("kg.") && type.endsWith(".result")),
  },
  /** 订阅 coord 族帧（coord.changed 占用协调轻通知，U5——daemon 级全局
   *  广播不按会话订阅路由；活动窗口轻条目消费 + connection.error）。 */
  subscribeCoordFrames: {
    match: (type) => type === "coord.changed" || type === "connection.error",
  },
  /** 订阅 task 族帧（task.*.result 点对点回执 + task.changed 广播 +
   *  connection.error——生命周期在途错误判定，页面单飞门控消费）。 */
  subscribeTaskFrames: {
    match: (type) =>
      type === "task.changed" ||
      type === "connection.error" ||
      (type.startsWith("task.") && type.endsWith(".result")),
  },
  /** 订阅 workspace 族帧（get/open 两结果帧 + workspace_changed 广播 +
   *  connection.error——open 在途时才消费，trace 单飞先例）。 */
  subscribeWorkspaceFrames: {
    match: (type) =>
      type === "workspace.get.result" ||
      type === "workspace.open.result" ||
      type === "workspace_changed" ||
      type === "connection.error",
  },
  /** 订阅 config 族在途错误回执（仅 connection.error——config.set_* daemon
   *  失败无结果帧，设置页三卡单飞门控消费清 pending；结果帧走 topology
   *  消费者（model-config.ts），不在此转发）。 */
  subscribeConfigFrames: {
    match: (type) => type === "connection.error",
  },
  /** 订阅 mcp 族帧（mcp.*.result 点对点回执 + mcp.status.changed 全局
   *  广播 + connection.error——写面在途错误判定，页面单飞门控消费）。 */
  subscribeMcpFrames: {
    match: (type) =>
      type === "mcp.status.changed" ||
      type === "connection.error" ||
      (type.startsWith("mcp.") && type.endsWith(".result")),
  },
  /** 订阅 stt 族帧（语音输入批 V1：stt.transcribe.result 点对点回执 +
   *  connection.error——Composer 转写在途态判定，单飞门控消费；V3b-1 扩
   *  stt.stream 三帧——started/interim/final（useStewardVoice 流式面消费，
   *  Composer 对流式帧零感知）。 */
  subscribeSttFrames: {
    match: (type) =>
      type === "stt.transcribe.result" ||
      type === "stt.stream.started" ||
      type === "stt.stream.interim" ||
      type === "stt.stream.final" ||
      type === "connection.error",
  },
  /** 订阅 voice 族帧（语音播报批 V2 TTS：voice.broadcast 广播 +
   *  voice.synthesize.result 点对点回执 + connection.error——useVoiceBroadcast
   *  播放与设置页试听两消费面；TR-89 双登记纪律；V3b-2 流式批补
   *  chunk/done/error 三帧——管家朗读流式回推面（漏登即播放器零帧）。 */
  subscribeVoiceFrames: {
    match: (type) =>
      type === "voice.broadcast" ||
      type === "voice.synthesize.result" ||
      type === "voice.synthesize.chunk" ||
      type === "voice.synthesize.done" ||
      type === "voice.synthesize.error" ||
      type === "connection.error",
  },
  /** 订阅 steward 族帧（V2.5 文本管家：ask/confirm/config 三点对点回执 +
   *  ask.delta 流式增量帧（体验批）+ feed 广播 + A1 工作记忆批三帧
   *  （history.result 回放 / tool 两相 / thinking 段级）+ 驾驶舱批页面切换
   *  指令帧（steward.navigate——useStewardNavigate 切页钩子消费）+
   *  管家感知批 M0.5 主动通知帧（steward.notify——StewardNotifyToast
   *  全局 toast 消费）+ 确认链路修复批在途确认卡快照（steward.pending.
   *  snapshot——useStewardActions 订阅对账/清场撤旧卡）+
   *  管家活动账批 M3-d1 两帧（steward.activity.result 查询/清理回执 +
   *  steward.activity 实时条目——活动时间线页消费）+
   *  connection.error——面板/设置页/切页钩子/通知 toast/卡栈/时间线六消费面；
   *  TR-89 双登记纪律）。 */
  subscribeStewardFrames: {
    match: (type) =>
      type === "steward.ask.result" ||
      type === "steward.ask.delta" ||
      type === "steward.confirm.result" ||
      type === "steward.action.completed" ||
      type === "steward.feed" ||
      type === "steward.config.result" ||
      type === "steward.history.result" ||
      type === "steward.tool" ||
      type === "steward.thinking" ||
      type === "steward.navigate" ||
      type === "steward.notify" ||
      type === "steward.health" ||
      type === "steward.proactive" ||
      type === "steward.pending.snapshot" ||
      type === "steward.memory_written" ||
      type === "steward.memory_list.result" ||
      type === "steward.judge_stop_intent.result" ||
      type === "steward.activity.result" ||
      type === "steward.activity" ||
      type === "connection.error",
  },
  /** 订阅 surface 族帧（M0 表面协议地基批）：surface.action 动作指令帧
   *  （定向到已注册表面连接——useStewardNavigate verb=navigate 消费面）+
   *  surface.registered 注册回执（useShellSurface 身份诊断面）+
   *  connection.error；TR-89 双登记纪律（dispatcher 直通清单同步）。 */
  subscribeSurfaceFrames: {
    match: (type) =>
      type === "surface.action" ||
      type === "surface.registered" ||
      type === "connection.error",
  },
  /** 订阅 embedding 族帧（管家记忆 B2：list.result 清单回执（list/set/delete
   *  共用）+ verify.result 连通回执（两判别，id 回携）——模型页向量 tab /
   *  管家记忆区下拉两消费面）。 */
  subscribeEmbeddingFrames: {
    match: (type) =>
      type === "embedding.list.result" ||
      type === "embedding.verify.result" ||
      type === "connection.error",
  },
  /** 订阅 provider 族帧（三方平台批：list.result 清单回执（list/set/delete
   *  共用）——模型页三方平台 tab 消费面）。 */
  subscribeProviderFrames: {
    match: (type) =>
      type === "provider.list.result" ||
      type === "connection.error",
  },
} satisfies Record<string, ListenDomainSpec>;

/** 订阅面域键。 */
export type ListenDomain = keyof typeof LISTEN_SURFACE;

/** 订阅面类型（subscribe*(listener) → 退订函数；由注册表键派生）。 */
export type ListenSurface = {
  readonly [K in ListenDomain]: (listener: FrameListener) => () => void;
};
