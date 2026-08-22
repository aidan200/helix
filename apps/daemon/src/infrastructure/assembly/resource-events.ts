import type { ProfileKind } from "../../application/ports/outbound/ResourceStatePort";

/**
 * 资源生效集变更事件通道（T2.2，architecture §4.2.3——refreshAssembly 事件化）。
 *
 * 方向倒转：ResourceService 不再接收「onApplied 回调」（构造期注入引用
 * 后置定义的刷新闭包），改为发布 `resources.changed` 事件；容器订阅后
 * 调 refreshAssembly——「定义先于订阅注册」以结构保证取代注释保证
 * （循环边消灭的判据之一）。
 *
 * 通道边界（TP-2.2c 三负断言面）：本事件走**装配级总线**——不进 WS 广播
 * （EventStream）、不进 fan-out 注册表、不落盘（不是领域事件落盘通道成员）。
 * 若未来 UI 需要资源变更通知，属新协议事件，走 TR-AD-21/23 additive 链路
 * 另立决策。
 *
 * 层边界：本文件落 infrastructure（组合根装配面）——ResourceService 侧经
 * deps 函数字段（publishResourceChanged）注入，application 不 import 本
 * 文件（AG-02② 方向不破）。
 */

/** 资源生效集变更事件：toggle applied 后发布，载荷 = kind（skipped 不发布）。 */
export interface ResourceChangedEvent {
  readonly kind: ProfileKind;
}

/** 事件名（清单词汇）。 */
export const RESOURCE_CHANGED_EVENT = "resources.changed";

/**
 * 发布面（ResourceService deps 注入位）：返回 void | Promise<void>——
 * 发布方（setEnabled）await 即等待订阅侧刷新链收口，与旧 onApplied
 * await 链行为等价（TR-AD-24 既有语义）。
 */
export type PublishResourceChanged = (kind: ProfileKind) => void | Promise<void>;

/** 订阅 handler（容器侧：refreshAssembly 消费）。 */
export type ResourceChangedHandler = (event: ResourceChangedEvent) => void | Promise<void>;

/** 装配级事件总线（零依赖 pub/sub；组合根最先构造——装配序 §4.2.2 步 1）。 */
export interface ResourceEventBus {
  /** 发布事件：同步派发全部 handler 并汇聚其结果（发布方 await 即收口）。 */
  publish(event: ResourceChangedEvent): Promise<void>;
  /** 注册订阅（装配期一次；重复注册不去重——调用方自律）。 */
  subscribe(handler: ResourceChangedHandler): void;
}

export function createResourceEventBus(): ResourceEventBus {
  const handlers: ResourceChangedHandler[] = [];
  return {
    async publish(event: ResourceChangedEvent): Promise<void> {
      await Promise.all(handlers.map((handler) => handler(event)));
    },
    subscribe(handler: ResourceChangedHandler): void {
      handlers.push(handler);
    },
  };
}
