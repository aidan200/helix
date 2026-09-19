/**
 * 引擎错误卡片（终验热修）：engine.error 帧 → 聊天流内联失败卡。
 *
 * - 数据源：session state.engineError（瞬态——error entry 批起：错误条目帧
 *   （error.entry）到达即清除转正为原位红条，新轮 turn.started 清除保留作兜底）；
 * - 正文 = provider 原文透传（领域数据，不 i18n——与 drawer.lc.crashed 同口径）；
 * - 视觉复用连接失败卡 ErrorCard 的红系 danger 样式（同一设计语言）；
 * - 不提供自动重试按钮：重试语义 = 重发消息（draft 已清，需用户重新输入，
 *   避免热修引入重放语义的边界问题）。
 *
 * 引擎错误体验批（2026-09-19）：落盘错误条目不再时间线原位平铺，改按轮次
 * 折叠归组（TurnErrorGroup）——历史轮折叠成一行徽标，当前轮（最后一轮）
 * 默认展开全量，同轮多条合并计数；落盘/快照协议零改动（纯渲染层）。
 */
import { useI18n } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";
import type { ErrorEntryDto } from "@helix/protocol";

/** 内部展示子组件（code-review 低危组9：两消费面 head/body/hint 同构结构
 *  收拢）——瞬态卡与落盘红条共享红系 danger 视觉（ee-* 族单一实现）。 */
function ErrorShell({ title, body, hint }: { title: string; body: string; hint: string }) {
  return (
    <div className="msg engine-error-card" role="alert">
      <div className="ee-head">
        <span className="ee-dot" aria-hidden />
        {title}
      </div>
      <div className="ee-body">{body}</div>
      <div className="ee-hint">{hint}</div>
    </div>
  );
}

const EngineErrorCard = function EngineErrorCard() {
  const { t } = useI18n();
  const { state } = useSession();
  if (state.engineError === null) return null;
  return (
    <ErrorShell
      title={t("chat.engineError.title")}
      body={state.engineError.message}
      hint={t("chat.engineError.hint")}
    />
  );
};

/**
 * 错误条目原位红条（error entry 批）：EntryDto kind="error" 变体的 EntryView
 * 分支——视觉复用本卡红系 danger 样式（ee-head/ee-body 族，ErrorShell 单一
 * 实现）。数据源 = entries 序列（落盘条目）：刷新/切换后经快照原位可见；与瞬态卡
 * 互斥（error.entry 帧到达即清瞬态卡，同一错误不双显）。
 *
 * 引擎错误体验批起：本组件不再由 MessageFlow 逐条直渲，改经 TurnErrorGroup
 * 归组消费（历史轮折叠/当前轮展开/同轮合并计数）；保留导出供组内展开态全量渲染。
 */
export const ErrorEntryBar = function ErrorEntryBar({ entry }: { entry: ErrorEntryDto }) {
  const { t } = useI18n();
  return (
    <ErrorShell
      title={t("chat.engineError.title")}
      body={entry.message}
      hint={t("chat.engineError.hint")}
    />
  );
};

/** 历史轮徽标摘要截断长度（字符；引擎错误体验批规格值）。 */
const BADGE_MESSAGE_MAX = 40;

/** 徽标摘要：首条错误消息截断 40 字符（展开后全量原文不截断）。 */
function badgeSummary(message: string): string {
  return message.length > BADGE_MESSAGE_MAX ? `${message.slice(0, BADGE_MESSAGE_MAX)}…` : message;
}

/**
 * 轮次错误组（引擎错误体验批）：同 turnId 错误条目归组挂轮末——
 * - 折叠态 = 一行徽标（⚠ + 首条消息截断 40 字符 + 多条时 ×N 计数）；
 * - 展开态 = 徽标行（兼作切换钮）+ 逐条 ErrorEntryBar 全量红条；
 * - 展开态由 MessageFlow 决定（当前轮/最后一轮默认展开，历史轮默认折叠，
 *   用户点击可覆盖）；本组件无自身状态（受控组件）。
 */
export const TurnErrorGroup = function TurnErrorGroup({
  turnId,
  errors,
  expanded,
  onToggle,
}: {
  turnId: string;
  errors: readonly ErrorEntryDto[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const summary = badgeSummary(errors[0]!.message);
  return (
    <div className="ee-group" data-turn-id={turnId}>
      <button
        type="button"
        className="ee-badge"
        data-turn-id={turnId}
        data-count={errors.length}
        aria-expanded={expanded}
        title={t("chat.engineError.toggle")}
        onClick={onToggle}
      >
        <span className="ee-warn" aria-hidden>⚠</span>
        <span className="ee-badge-text">
          {summary}
          {errors.length > 1 ? ` ×${errors.length}` : ""}
        </span>
        <span className="ee-caret" aria-hidden>{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && errors.map((entry) => <ErrorEntryBar key={entry.id} entry={entry} />)}
    </div>
  );
};

export default EngineErrorCard;
