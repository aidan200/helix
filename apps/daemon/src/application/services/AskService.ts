import type { DomainEvent } from "../../domain/events/DomainEvent";
import type { RuntimeConfigPort } from "../ports/outbound/RuntimeConfigPort";

/**
 * AskService —— agent ↔ 用户提权执行申请的仲裁服务（permission_request 批）。
 *
 * 生命周期：request（agent 工具发起）→ 发 ask.started 事件 + KV 落 pending
 * + 60s 计时器 → 三终态收口（answer 批准/拒绝、超时自动拒绝、重启恢复）→
 * 发 ask.resolved 事件 + KV 清行 → Promise 裁决回工具。
 *
 * 设计要点：
 * - **单 pending 不变式**：同会话同时最多一个挂起申请——第二个 request 在
 *   有 pending 时直接拒绝（工具结果引导重试）；enforce 在内存 Map + KV 双写序
 *   （先写 KV 后记账，崩溃恢复以 KV 为准）；
 * - **重启恢复**：构造时扫 KV pending 行——未过期重挂计时器（按剩余量），
 *   已过期立即 timeout 收口（补发 resolved，防悬卡）；
 * - **一次性语义**：批准仅放行本次执行，不记任何 always-allow 清单；
 * - **超时机械**：60s（ASK_TIMEOUT_MS 单点），计时器到点即 denied(timeout)；
 * - **提权自动通过**（autoApprove 配置，运行期即热）：kind=permission_request
 *   且配置开 → 免卡片直接裁 auto_approved（不发 ask.started/不落 pending/
 *   不计时——单 pending 不变式不受影响）；仅该 kind 享受（未来危险确认类
 *   消费者不跟随）。留痕 = 工具结果注记行（A① 完全静默裁决）。
 *
 * KV 布局：`ask_pending:<sessionId>` 单键 JSON（AskPendingRecord）——会话
 * 单 pending 不变式的存储载体；快照 pendingAsk 读面同源。
 */
export const ASK_TIMEOUT_MS = 60_000;

/** 申请类别判别位（与 @helix/protocol AskKind 同值镜像——domain 不依赖协议包，字面联合单源在协议侧）。 */
export type AskKind = "permission_request";

/** 挂起申请记录（KV 落盘行 + 快照 pendingAsk 同源形状）。 */
export interface AskPendingRecord {
  readonly askId: string;
  /** 申请类别（消费者分发键；additive——旧 KV 行缺省按 permission_request 兼容） */
  readonly kind?: AskKind;
  readonly command: string;
  readonly reason: string;
  readonly instanceId: string;
  /** 超时时刻（epoch ms） */
  readonly expiresAt: number;
}

/** request 裁决结果（回工具层：批准=放行裸跑；拒绝/超时=引导文案；auto_approved=配置自动通过的批准，工具结果携注记留痕）。 */
export type AskOutcome = "approved" | "denied" | "timeout" | "auto_approved";

export interface AskServiceDeps {
  /** 领域事件发布面（会话归属路由由 EventStream 按 sessionId 分发）。 */
  readonly publish: (event: DomainEvent) => void;
  /** KV 底座（pending 行持久化；WriteQueue 单写通道）。 */
  readonly kv: RuntimeConfigPort;
  /** 时钟（测试可控）。 */
  readonly now: () => number;
  /** askId 生成（测试可控）。 */
  readonly newId: () => string;
  /**
   * 提权申请自动通过判定（autoApprove 配置；可选——缺省恒 false 不自动通过）。
   * 每次 request 现值读取（运行期即热，装配面接 SandboxConfigPort.current()）；
   * 仅 kind=permission_request 消费。
   */
  readonly autoApprove?: () => boolean;
}

interface PendingEntry {
  readonly record: AskPendingRecord;
  readonly sessionId: string;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (outcome: AskOutcome) => void;
}

const kvKey = (sessionId: string): string => `ask_pending:${sessionId}`;

export class AskService {
  /** 会话 → 挂起申请（单 pending 不变式的内存面）。 */
  private readonly pending = new Map<string, PendingEntry>();

  constructor(private readonly deps: AskServiceDeps) {}

  /**
   * 发起提权申请：发 ask.started 事件 + KV 落 pending + 60s 计时器，
   * Promise 挂起至三终态之一收口。
   * @returns 裁决结果（approved=用户批准；denied=用户拒绝；timeout=60s 超时）
   * @throws 同会话已有挂起申请时拒绝（工具层转引导文案）
   */
  request(input: {
    readonly sessionId: string;
    readonly instanceId: string;
    readonly command: string;
    readonly reason: string;
    /** 申请类别（缺省 = permission_request——本族首个消费者） */
    readonly kind?: AskKind;
    /** 超时时长（缺省 60s——不同消费者对时延容忍不同，按类可携） */
    readonly timeoutMs?: number;
  }): Promise<AskOutcome> {
    // 提权自动通过（autoApprove 配置）：免卡片直接裁决——不发 ask.started/
    // 不落 pending/不计时，UI 零弹卡；仅 permission_request（kind 判别位）。
    if ((input.kind ?? "permission_request") === "permission_request" && this.deps.autoApprove?.() === true) {
      return Promise.resolve("auto_approved");
    }
    if (this.pending.has(input.sessionId)) {
      throw new Error(`会话已有挂起的提权申请（${this.pending.get(input.sessionId)!.record.askId}），待其收口后再发起`);
    }
    const timeoutMs = input.timeoutMs ?? ASK_TIMEOUT_MS;
    const now = this.deps.now();
    const record: AskPendingRecord = {
      askId: this.deps.newId(),
      kind: input.kind ?? "permission_request",
      command: input.command,
      reason: input.reason,
      instanceId: input.instanceId,
      expiresAt: now + timeoutMs,
    };
    this.deps.publish({
      type: "ask.started",
      sessionId: input.sessionId,
      instanceId: input.instanceId,
      payload: { ...record },
      occurredAt: new Date(now).toISOString(),
    });
    // KV 落盘先行（崩溃恢复以 KV 为准）；写失败吞咽不阻断挂起（内存面仍在）
    void this.deps.kv.set(kvKey(input.sessionId), JSON.stringify(record)).catch(() => {});
    return new Promise<AskOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(input.sessionId, "timeout");
      }, timeoutMs);
      this.pending.set(input.sessionId, { record, sessionId: input.sessionId, timer, resolve });
    });
  }

  /**
   * 用户裁决（ask.answer 命令路由入口）：批准/拒绝收口挂起申请。
   * @returns false = 无此挂起申请（重复应答/已超时/已重启清除——幂等容忍）
   */
  answer(sessionId: string, askId: string, approved: boolean): boolean {
    const entry = this.pending.get(sessionId);
    if (entry === undefined || entry.record.askId !== askId) return false;
    this.settle(sessionId, approved ? "approved" : "denied");
    return true;
  }

  /** 当前挂起申请（快照 pendingAsk 投影读面；无 → null）。 */
  pendingOf(sessionId: string): AskPendingRecord | null {
    return this.pending.get(sessionId)?.record ?? null;
  }

  /**
   * 重启恢复：构造后由组合根调用——扫 KV pending 行（调用方提供全量
   * sessionId 清单），未过期重挂计时器，已过期立即 timeout 收口。
   * 恢复的申请无 Promise 消费方（工具进程已死）——resolve 落空操作。
   */
  restoreFromKv(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      const raw = this.deps.kv.get(kvKey(sessionId));
      if (raw === undefined) continue;
      let record: AskPendingRecord;
      try {
        record = JSON.parse(raw) as AskPendingRecord;
      } catch {
        void this.deps.kv.set(kvKey(sessionId), "").catch(() => {});
        continue;
      }
      if (this.pending.has(sessionId)) continue;
      const remaining = record.expiresAt - this.deps.now();
      if (remaining <= 0) {
        // 已过期：立即收口（补发 resolved 防悬卡——重启间超时无人发）
        this.pending.set(sessionId, {
          record,
          sessionId,
          timer: setTimeout(() => {}, 0),
          resolve: () => {},
        });
        this.settle(sessionId, "timeout");
        continue;
      }
      const timer = setTimeout(() => this.settle(sessionId, "timeout"), remaining);
      this.pending.set(sessionId, { record, sessionId, timer, resolve: () => {} });
    }
  }

  /** 收口唯一通道：清计时器/内存/KV + 发 resolved 事件 + Promise 裁决。 */
  private settle(sessionId: string, outcome: AskOutcome): void {
    const entry = this.pending.get(sessionId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(sessionId);
    void this.deps.kv.set(kvKey(sessionId), "").catch(() => {});
    this.deps.publish({
      type: "ask.resolved",
      sessionId,
      instanceId: entry.record.instanceId,
      payload: { askId: entry.record.askId, outcome },
      occurredAt: new Date(this.deps.now()).toISOString(),
    });
    entry.resolve(outcome);
  }
}
