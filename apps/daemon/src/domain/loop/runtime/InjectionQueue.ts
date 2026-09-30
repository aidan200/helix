/**
 * runtime/InjectionQueue —— loop 域 steer/followUp 双队列（helix-loop
 * Phase 2 落位；设计 §2.4 + 语义定稿 R2/R3/D4）。
 *
 * 执行真相（会话作用域，归 runtime 层）——与 domain/agent/SteerQueue（投影
 * 真相：携 entryId、SQLite 持久化）经 ChatService 双写，不互相 import
 * （设计 §1.1 三限界上下文分界）。
 *
 * 语义锚（docs/temp/loop-interleaving-semantics.md）：
 * - one-at-a-time（R2.3）：drain 取最老一条——多条排队逐轮各投一条；
 * - followUp 深度上限（D4 推荐口径：起新 run + rounds 重置 + 深度上限
 *   =现役管家 pending 上限 3 同族 E-197）；steer 无上限（pi PendingMessageQueue
 *   同族）；
 * - 队列不因任何收口丢失（G-G）：abort/terminate/roundLimit/error 均不清空，
 *   只有 reset() 清队列（pi agent.js:216-218/228-240 判例同构）。
 */
import type { LoopImage, LoopMessage } from "../contracts";

/** 注入消息（steer/followUp 共形：user 载荷 + images 上行 + source 来源标注
 *  ——R3.4）。泛型参数化由 LoopAgent 承载（应用可扩展自己的元素类型，
 *  domain 不持应用载荷）。 */
export interface LoopInjection {
  readonly text: string;
  readonly images?: readonly LoopImage[];
  /** 来源标注（R3.4 source 面——应用层溯源，引擎不解释）。 */
  readonly source?: string;
}

/** 注入消息 → user 消息（注入位统一形态——start/followUp 接管输入与轮边界
 *  注入同形，R2.4：注入位恒在批 toolResult 之后，尾消息合法 user）。 */
export function injectionToMessage(injection: LoopInjection): LoopMessage {
  return {
    role: "user",
    text: injection.text,
    ...(injection.images !== undefined && injection.images.length > 0 ? { images: injection.images } : {}),
  };
}

/** 入队结果：ok=false = 队列满（应用层据此回执错误——E-197 上限拒绝语义）。 */
export type LoopInjectionPush =
  | { readonly ok: true; readonly position: number }
  | { readonly ok: false; readonly reason: "queueFull"; readonly limit: number };

/** followUp 深度上限缺省（D4 推荐口径——现役管家 pending 上限同值族）。 */
export const DEFAULT_FOLLOW_UP_LIMIT = 3;

export class InjectionQueue<TInjection extends LoopInjection = LoopInjection> {
  private readonly steer: TInjection[] = [];
  private readonly followUps: TInjection[] = [];
  private readonly steerLimit: number | undefined;
  private readonly followUpLimit: number;

  constructor(opts: { readonly steerLimit?: number; readonly followUpLimit?: number } = {}) {
    this.steerLimit = opts.steerLimit;
    this.followUpLimit = opts.followUpLimit ?? DEFAULT_FOLLOW_UP_LIMIT;
  }

  /** steer 入队（缺省无上限——pi 同族；one-at-a-time 消费见 drainSteer）。 */
  pushSteer(msg: TInjection): LoopInjectionPush {
    if (this.steerLimit !== undefined && this.steer.length >= this.steerLimit) {
      return { ok: false, reason: "queueFull", limit: this.steerLimit };
    }
    this.steer.push(msg);
    return { ok: true, position: this.steer.length };
  }

  /** followUp 入队（深度上限 D4：超限拒绝，不静默丢弃）。 */
  pushFollowUp(msg: TInjection): LoopInjectionPush {
    if (this.followUps.length >= this.followUpLimit) {
      return { ok: false, reason: "queueFull", limit: this.followUpLimit };
    }
    this.followUps.push(msg);
    return { ok: true, position: this.followUps.length };
  }

  /** 取最老一条 steer（one-at-a-time R2.3——不投递不移位，取走即消费）。 */
  drainSteer(): TInjection | undefined {
    return this.steer.shift();
  }

  /** 取最老一条 followUp（R3.1「本要停」判定接管 / R3.5 continueRun P3 序）。 */
  drainFollowUp(): TInjection | undefined {
    return this.followUps.shift();
  }

  /** 观测面（测试/应用层队列深度断言——G-G 零吞验证锚）。 */
  pendingCounts(): { steer: number; followUp: number } {
    return { steer: this.steer.length, followUp: this.followUps.length };
  }

  /** 清空双队列（reset 专用——G-G：唯一清队列路径）。 */
  clear(): void {
    this.steer.length = 0;
    this.followUps.length = 0;
  }
}
