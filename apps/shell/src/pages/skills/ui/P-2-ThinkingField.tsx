/**
 * P-2 profile 推理级别字段（thinking 批 T2.2；pages/skills/ui，review.md §5
 * 命名契约带 P-2 路径；挂点 = AgentPage ProfileCard 模型槽位正下方，双 kind
 * 卡各一实例）。
 *
 * 形态（review.md §3 必须还原 1/2 + prototype/P-2-profile-thinking-field.html
 * 同源）：label「推理级别 · THINKING LEVEL」（hud-label 族，与模型槽位视觉
 * 并列）+ dashed-able 字段框（.tl-box：void 0.35 底 + 8px 圆角）内嵌
 * ThinkingLevelSlider（T2.1 共用原子，props 契约原样消费，零改造）。
 *
 * 状态模型（review.md §3，互斥 + 叠加层）：
 * - unset（留空 = 未配置，AD-6）：ghost 滑块（.unset → dashed 框 + 空心
 *   thumb 停兜底 medium 位 + 刻度去强调）+「未配置」中性徽标 + 回落说明；
 *   ghost 位仅预览不可提交（无交互零写命令）；
 * - configured：实滑块 + accent 档位徽标 + × 清除钮 + spawn 快照说明；
 *   两态视觉与徽标同步切换不叠加（class/ghost/徽标均由 configured 单源派生）；
 * - disabled 叠加（F2.2：槽位模型 reasoning=false）→ 滑块不渲染、说明取代、
 *   已有配置保留不可改（徽标仍示配置档、× 隐藏）；
 * - 修饰层 clamped：已配档超出槽位模型能力 → 「xhigh → high（模型能力所限；
 *   spawn 解析时按能力过滤，配置值不丢）」warning 轻提示（配置值本体不改写
 *   ——spawn 解析权威在 daemon，UI 只做展示提示，对比 P-1 的引擎侧广播）；
 * - 修饰层 peak：configured 且生效档 = 最高支持档 → 字段框体 .peak（与 P-1
 *   同一 class 驱动 + .beam 环绕光束复用）；仅 configured 可触发；
 * - 能力位未判明（目录未到达/模型不在目录）→ 加载提示位，与滑块互斥；
 *   宿主 skeleton / writePending 沿用（disabled 透传滑块 + × 钮）。
 *
 * 数据零权威（AD-2/AD-6）：读写全由 AgentPage 走 agent.config.set_enabled
 * thinking 槽位 + changed 广播重拉收口（本组件零 SessionContext 依赖，
 * onSelect/onClear 回调上行）；刻度数 = CatalogModel.thinkingLevels.length
 * （TR-AD-42：不硬编码六档、不自判能力）；展示位钳制经
 * features/thinking-level/model/thinking-resolution（UI 不 import pi-ai）。
 */
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import type { CatalogModel } from "@helix/protocol";
import ThinkingLevelSlider from "@/features/thinking-level/ui/ThinkingLevelSlider";
import { isPeakLevel } from "@/features/thinking-level/model/thinking-capability";
import { resolveEffectiveLevel } from "@/features/thinking-level/model/thinking-resolution";
import type { AgentKind } from "../model/agent-config-model";

export interface P2ThinkingFieldProps {
  kind: AgentKind;
  /** AgentProfile 配置资源 thinking 槽位现值（null = 未配置 = 留空）。 */
  thinkingLevel: string | null;
  /** 槽位模型能力位（undefined = 目录未到达或模型不在目录）。 */
  capability: CatalogModel | undefined;
  /** 写面在途 / 宿主 skeleton 禁用叠加。 */
  disabled: boolean;
  onSelect: (level: string) => void;
  onClear: () => void;
}

const P2ThinkingField = function P2ThinkingField({
  kind,
  thinkingLevel,
  capability,
  disabled,
  onSelect,
  onClear,
}: P2ThinkingFieldProps) {
  const { t } = useI18n();
  const configured = thinkingLevel !== null;
  const capabilityKnown = capability !== undefined;
  const reasoningOff = capabilityKnown && !capability.reasoning;
  const levels = capability?.thinkingLevels ?? [];

  // 生效展示位：configured → 配置档按槽位模型能力向下钳制（仅展示位——配置
  // 值本体不改写，spawn 解析权威在 daemon）；unset → ghost 兜底 medium 预览位
  const effective = configured ? resolveEffectiveLevel(levels, thinkingLevel!) : null;
  const ghost =
    !configured && levels.length > 0
      ? (resolveEffectiveLevel(levels, "medium") ?? undefined)
      : undefined;
  const clamped = configured && effective !== null && effective !== thinkingLevel;
  const peak = !reasoningOff && configured && isPeakLevel(levels, effective);

  return (
    <div
      className={cn("tl-field", !configured && "unset", reasoningOff && "disabled")}
      data-thinking-field={kind}
    >
      <div className="tl-field-head">
        <span className="hud-label">{t("agents.thinking.label")}</span>
        <span className={cn("tl-state", configured && "set")} data-tl-state>
          {configured ? thinkingLevel : t("agents.thinking.unsetBadge")}
        </span>
      </div>
      <div className={cn("tl-box", peak && "peak")}>
        <span className="beam" aria-hidden="true">
          <i />
        </span>
        {/* × 清除钮：configured 且可交互时在场（reasoning=false → 配置保留
            不可改，钮隐藏；writePending 时禁用不隐藏） */}
        {configured && !reasoningOff && capabilityKnown && (
          <button
            type="button"
            className="tl-clear"
            title={t("agents.thinking.clearTitle")}
            aria-label={t("agents.thinking.clearTitle")}
            disabled={disabled}
            onClick={onClear}
          >
            ×
          </button>
        )}
        {/* F2.2：reasoning=false → 滑块不渲染（禁用说明落在下方 note，两态不
            叠加）；能力位未判明 → 加载提示位（互斥）；就绪 → 滑块 */}
        {!reasoningOff &&
          (capabilityKnown ? (
            <ThinkingLevelSlider
              levels={levels}
              value={effective}
              ghostValue={ghost}
              disabled={disabled}
              peak={peak}
              onSelect={onSelect}
              ariaLabel={t("agents.thinking.sliderLabel")}
            />
          ) : (
            <div className="tl-cap-loading">{t("agents.thinking.capabilityLoading")}</div>
          ))}
        {clamped && !reasoningOff && (
          <div className="tl-hint">
            {t("agents.thinking.clampedHint", { configured: thinkingLevel!, effective: effective! })}
          </div>
        )}
      </div>
      <p className="ag-note tl-note">
        {reasoningOff
          ? t("agents.thinking.disabledNote")
          : configured
            ? t(kind === "main-session" ? "agents.thinking.noteConfiguredMain" : "agents.thinking.noteConfiguredSub")
            : t(kind === "main-session" ? "agents.thinking.noteUnsetMain" : "agents.thinking.noteUnsetSub")}
      </p>
    </div>
  );
};

export default P2ThinkingField;
