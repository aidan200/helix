/**
 * P-2 profile 推理级别字段（pages/skills/ui；挂点 = AgentPage ProfileCard
 * 模型槽位正下方，双 kind 卡各一实例）。thinking 批 T3 重构为 on/off 开关
 * 形态（用户决策：「think 等级是有 on/off 的开关的，on 的时候获取当前模型
 * 最新的支持的档位列表，然后再渲染滑块组件」）：
 *
 * 形态：head 行 = label「推理级别 · THINKING LEVEL」（hud-label 族）+ 档位
 * 徽标（on → 档位名；off 不渲染）+ on/off 开关（AgentPage AgentSwitch 同
 * 形态局部组件——.ag-switch 族复用，不强行抽公共件）；body = 开 on 且能力
 * 就绪时渲染 ThinkingLevelSlider（T2.1 共用原子，props 契约原样消费，零
 * 改造；P-2 滑块无 OFF 刻度——off 语义由开关承担，与 P-1 不同）。
 *
 * 开关语义（与 daemon thinking 默认关对齐）：
 * - off = thinking 槽位空（block?.thinkingLevel == null）= 该 profile 默认
 *   不思考；off 态无滑块（ghost 预览位随之退役）；
 * - off → on 且槽位空：立即写入当前模型档位列表的中位档
 *   （defaultLevelFor(levels)，用户决策：「所有模型的推理强度默认都取中间
 *   档位，如果只有两个档位则取第一档位，最高档位默认都不选」）使槽位已
 *   配置，随后滑块可选档；
 * - on → off：既有 onClear 清槽位（清除钮 .tl-clear 随开关承担 off 后移除）。
 *
 * 边界态（沿用既有判据，不新增逻辑）：
 * - reasoning=false（槽位模型不支持推理）：开关 disabled + disabledNote
 *   说明行保留（唯一存留 note；noteUnset 与 noteConfigured 两族四条
 *   说明文案已按用户决策删除）；已有配置保留不可改（徽标仍示配置档）；
 * - 能力位未判明（目录未到达/模型不在目录）：开关 disabled + capabilityLoading
 *   加载提示位（与滑块互斥）；
 * - 修饰层 clamped：已配档超出槽位模型能力 → 「xhigh → high（模型能力所限；
 *   spawn 解析时按能力过滤，配置值不丢）」轻提示（配置值本体不改写——spawn
 *   解析权威在 daemon）；
 * - 修饰层 peak：configured 且生效档 = 最高支持档 → 字段框体 .peak + .beam
 *   环绕光束复用；仅 configured 可触发。
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
import { defaultLevelFor, isPeakLevel } from "@/features/thinking-level/model/thinking-capability";
import { resolveEffectiveLevel } from "@/features/thinking-level/model/thinking-resolution";
import type { AgentKind, SystemAgentKind } from "../model/agent-config-model";

export interface P2ThinkingFieldProps {
  kind: AgentKind | SystemAgentKind; // R7：system 卡槽位同构复用
  /** AgentProfile 配置资源 thinking 槽位现值（null = 未配置 = 开关 off）。 */
  thinkingLevel: string | null;
  /** 槽位模型能力位（undefined = 目录未到达或模型不在目录）。 */
  capability: CatalogModel | undefined;
  /** 写面在途 / 宿主 skeleton 禁用叠加。 */
  disabled: boolean;
  onSelect: (level: string) => void;
  onClear: () => void;
}

/** on/off 开关（AgentPage AgentSwitch 同形态：语义化 role=switch +
 *  aria-checked；track + thumb + 状态词——.ag-switch 样式族复用）。 */
function ThinkingSwitch({
  checked,
  disabled,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={cn("ag-switch", checked && "on")}
      role="switch"
      aria-checked={checked}
      aria-label={t("agents.thinking.switchLabel")}
      data-switch="thinking"
      disabled={disabled}
      onClick={onToggle}
    >
      <span className="ag-switch-track" aria-hidden="true">
        <span className="ag-switch-thumb" />
      </span>
      <span className="ag-switch-state">{checked ? t("agents.switchOn") : t("agents.switchOff")}</span>
    </button>
  );
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

  // 生效展示位：配置档按槽位模型能力向下钳制（仅展示位——配置值本体不改写，
  // spawn 解析权威在 daemon）
  const effective = configured ? resolveEffectiveLevel(levels, thinkingLevel!) : null;
  const clamped = configured && effective !== null && effective !== thinkingLevel;
  const peak = !reasoningOff && configured && isPeakLevel(levels, effective);

  /** 开关翻转：on → off 走既有 onClear 清槽位；off → on 且槽位空 → 立即写
   *  入当前模型档位中位档（defaultLevelFor；levels 空 → undefined 不写）。 */
  const onSwitchToggle = () => {
    if (configured) {
      onClear();
      return;
    }
    const level = defaultLevelFor(levels);
    if (level !== undefined) onSelect(level);
  };

  return (
    <div className={cn("tl-field", reasoningOff && "disabled")} data-thinking-field={kind}>
      <div className="tl-field-head">
        <span className="hud-label">{t("agents.thinking.label")}</span>
        {configured && (
          <span className="tl-state set" data-tl-state>
            {thinkingLevel}
          </span>
        )}
        <ThinkingSwitch
          checked={configured}
          disabled={disabled || !capabilityKnown || reasoningOff}
          onToggle={onSwitchToggle}
        />
      </div>
      {/* F2.2 + 开关形态：滑块仅 on（槽位已设）且能力就绪且非 reasoningOff
          时渲染——off 由开关承担，无 OFF 刻度、无 ghost 预览位 */}
      {configured && capabilityKnown && !reasoningOff && (
        <div className={cn("tl-box", peak && "peak")}>
          <span className="beam" aria-hidden="true">
            <i />
          </span>
          <ThinkingLevelSlider
            levels={levels}
            value={effective}
            disabled={disabled}
            peak={peak}
            onSelect={onSelect}
            ariaLabel={t("agents.thinking.sliderLabel")}
          />
          {clamped && (
            <div className="tl-hint">
              {t("agents.thinking.clampedHint", { configured: thinkingLevel!, effective: effective! })}
            </div>
          )}
        </div>
      )}
      {/* 能力位未判明（目录未到达/模型不在目录）→ 开关 disabled + 加载提示位
          （与滑块互斥） */}
      {!capabilityKnown && (
        <div className="tl-box">
          <div className="tl-cap-loading">{t("agents.thinking.capabilityLoading")}</div>
        </div>
      )}
      {/* 说明行仅存 disabledNote（reasoning=false 分支；noteUnset 与
          noteConfigured 四条文案已按用户决策删除） */}
      {reasoningOff && <p className="ag-note tl-note">{t("agents.thinking.disabledNote")}</p>}
    </div>
  );
};

export default P2ThinkingField;
