import type { EventFrame } from "../envelope";

// ── payload ──────────────────────────────────────────────────

/**
 * ask.started：agent 发起越权执行申请（sandbox_request 工具触发）。
 * 落盘为时间轴原位条目（pending 态），前端渲染问答卡片。
 */
export interface AskStartedPayload {
  /** 申请 id（`ask-<唯一串>`，answer 命令回指键） */
  askId: string;
  /** 申请执行的命令原文 */
  command: string;
  /** agent 自述申请理由（LLM 生成，领域数据不 i18n） */
  reason: string;
  /** 发起实例 id（main/SubAgent 同空间；前端卡片署名） */
  instanceId: string;
  /** 超时时刻（epoch ms，缺省 = 发起后 60s；前端倒计时数据源） */
  expiresAt: number;
}

/** ask.resolved：申请收口（批准/拒绝/超时三终态，单一收口帧） */
export interface AskResolvedPayload {
  askId: string;
  outcome: "approved" | "denied" | "timeout";
}

// ── 信封（判别式联合成员） ──

export interface AskStartedEvent extends EventFrame<AskStartedPayload> {
  /** interaction：agent ↔ 用户双向问答族（原占位族启用） */
  channel?: "interaction";
  type: "ask.started";
}
export interface AskResolvedEvent extends EventFrame<AskResolvedPayload> {
  channel?: "interaction";
  type: "ask.resolved";
}
