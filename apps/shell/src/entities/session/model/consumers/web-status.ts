/**
 * web-status 拓扑级消费者（T4 联网状态图标；契约 v0.7 web 族）。
 *
 * 拓扑级消费（操作 TopologyState，与 agent-config 同构）：CDP 连接状态是
 * daemon 级全局数据（信封 sessionId = SYSTEM_SESSION_ID，订阅无关全连接），
 * 不入活跃会话 store 注册表（dispatcher/index.ts），经 dispatcher/frame.ts
 * 前置门路由（isWebEventType，参照 model/agent-config 族两层拓扑）。
 *
 * 三 type 分工（v0.9 +1：四 type）：
 * - web.status.result（app 启动查询回执，SessionProvider 连接就绪发一次）
 *   / web.status.changed（连接成功/断开/tab 增减/error 四时机广播）→
 *   真消费：payload 写入 topology.webStatus（IconRail 联网钮三态 + popover
 *   数据源；app 层 props 注入，IconRail 纯展示不读本 store）；
 * - web.stop.result（停止写面回执）/ web.start.result（启动写面回执，v0.9
 *   T7 显式启动通路）→ 拓扑原引用直通（状态回流经 web.status.changed
 *   广播；applied/skipped 语义无 UI 消费面）。
 * 纯函数纪律（AG-14）：无 React / 无 IO / 无 Date.now。
 */
import type { EventEnvelope } from "@helix/protocol";
import type { TopologyState } from "../state";

/** 本块承接的帧事件 type（拓扑级注册面；dispatcher/frame.ts 消费）。 */
export const WEB_EVENT_TYPES = [
  "web.status.changed",
  "web.status.result",
  "web.stop.result",
  "web.start.result",
] as const;

/** 是否 web 族事件（dispatcher 路由前置判定）。 */
export function isWebEventType(type: string): type is (typeof WEB_EVENT_TYPES)[number] {
  return (WEB_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * 帧消费（dispatcher/frame.ts 前置路由）。result/changed → webStatus 写入
 * （两帧 payload 同形状，契约 §16.8）；stop.result / start.result → 拓扑
 * 原引用直通（状态回流经广播，见文件头注）。
 */
export function applyWebEvent(topo: TopologyState, frame: EventEnvelope): TopologyState {
  if (frame.type === "web.status.changed" || frame.type === "web.status.result") {
    return { ...topo, webStatus: frame.payload };
  }
  return topo; // web.stop.result / web.start.result：直通（状态回流经 web.status.changed 广播）
}
