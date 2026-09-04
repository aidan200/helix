import type { EventFrame } from "../envelope";

// ── v0.11 新增：thinking 族（thinking 批 ①，iter-20260823-6ps5 T1.1；AD-2/AD-4，契约 = PROTOCOL-CHANGELOG.md §17.11） ──

/**
 * thinking.changed：会话 thinking 档覆盖生效广播（v0.11 新增，thinking 批 ①；
 * 仿 model.changed 广播链——daemon 处理 thinking.set 后经 domain_events 单写
 * 队列落盘（TR-AD-5）并广播；换模后生效档变化时再发一帧或随下一快照携带）。
 *
 * 前端语义（契约 ①）：滑块位置/强调 = `effective`；`override ≠ effective`
 * 时显示「xhigh → high（模型能力所限）」轻提示（F1.3）。
 * 字符串透传（AD-2）：档位全链 `string`，helix 不维护第二份枚举（SoT 在 pi-ai）。
 */
export interface ThinkingChangedPayload {
  /** 会话覆盖意图（用户拖到的档）；null = 无覆盖 */
  override: string | null;
  /** 引擎按当前模型能力解析的生效档；null = 全链不支持（不传参，provider 默认） */
  effective: string | null;
}

/**
 * thinking.changed 信封：挂 thinking 族（type 前缀 == channel 不变量；
 * auth.*.result 挂 model 族为 §16.6 登记的显式例外先例之外的默认口径）。
 */
export interface ThinkingChangedEvent extends EventFrame<ThinkingChangedPayload> {
  channel?: "thinking";
  type: "thinking.changed";
}
