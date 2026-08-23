/**
 * ComposerThinkingPicker —— P-1 chat composer 推理强度控件（thinking 批 T2.1；
 * features/thinking-level；挂点 = Composer.tsx .composer-foot 右侧，CSS 零改动）。
 *
 * 形态（review.md §1① 定案 + §2 必须还原 1/2）：24px trigger chip（THINKING
 * 微标 + accent 生效档大写 + chevron）+ hud-popover（向上展开，308px；
 * section-label「REASONING EFFORT」+ scope 文案「会话覆盖 · 仅本会话生效」），
 * 滑块/轻提示/禁用说明全部承载于 popover 内。
 *
 * 数据零权威（AD-2/AD-3/AD-4）：
 * - thinking 切片（override/effective）来自活跃 store——thinking.changed 广播
 *   + 快照读面驱动，UI 只消费不解析（换模重解析归 daemon 引擎侧）；
 * - 能力位（刻度数/禁用位）= CatalogModel.reasoning/thinkingLevels 防腐字段
 *   （TR-AD-42：不硬编码六档、不自判能力）；目录经 requestModelConfig 未请求
 *   态才发（ModelSwitchMenu 先例），效应依赖连接态——握手前发送被
 *   HelixWsClient 静默丢弃，conn 迁移 connected 后补拉（AgentPage 先例）；
 * - 选档 → setSessionThinking(level)（SessionContext 发 thinking.set；
 *   草稿态本地暂存，draft-model 先例）。
 *
 * 状态模型（review.md §2）：ready | disabled 互斥（reasoning 驱动）；
 * 修饰层 clamped（override≠effective → warning 轻提示）/ peak（effective =
 * 最高档 → trigger+popover 同入 .peak + 徽章）叠加于 ready；重渲染先清旧
 * 轻提示/旧 PEAK 再渲染新态（React 派生渲染天然满足）；目录未到达 = 加载
 * 提示位（与滑块/禁用说明互斥）。
 */
import { useEffect, useState } from "react";
import { useI18n } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";
import { cn } from "@/shared/lib/cn";
import { isClamped, isPeakLevel, resolveThinkingCapability } from "../model/thinking-capability";
import ThinkingLevelSlider from "./ThinkingLevelSlider";

const ComposerThinkingPicker = function ComposerThinkingPicker() {
  const { t } = useI18n();
  const { state, topology, setSessionThinking, requestModelConfig } = useSession();
  const [open, setOpen] = useState(false);
  const mc = topology.modelConfig;
  const conn = state.conn;

  // 能力位数据源：目录未请求态才发（requestModelConfig 先例——重复打开零重发）。
  // 效应依赖连接态（AgentPage 先例）：app 首渲染早于 WS 握手，握手前发送被
  // HelixWsClient 静默拒绝且无重试——conn 迁移 connected 后效应重发补拉，
  // fresh load/刷新后目录帧必达（catalog null 门控幂等，重连零重发）。
  useEffect(() => {
    if (conn === "connected") requestModelConfig();
  }, [conn, requestModelConfig]);

  // 点外 pointerdown / Escape 关闭（open 态才挂监听；trigger 点击开合归自身）
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: Event) => {
      const target = e.target as Element | null;
      if (target && typeof target.closest === "function" && target.closest(".thinking-picker")) return;
      setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 草稿态模型回退解析（draft-model 先例，ModelSwitchMenu 同口径）：
  // state.model（本地暂存所选）空 → 全局默认；非草稿不变
  const currentModel =
    state.sessionId === null ? state.model || mc.defaultModel : state.model;
  const capability = resolveThinkingCapability(currentModel, mc.catalog?.models);
  const capabilityKnown = capability !== undefined;
  const reasoningOff = capabilityKnown && !capability.reasoning;
  const levels = capability?.thinkingLevels ?? [];

  const { override, effective } = state.thinking;
  const peak = !reasoningOff && isPeakLevel(levels, effective);
  const clamped = isClamped(override, effective);

  // trigger 档位显示：禁用（reasoning=false 判明）→ OFF；生效档 → 大写；
  // 无生效档（无覆盖，provider 默认）→ AUTO
  const levelText = reasoningOff
    ? t("chat.thinking.off")
    : (effective ?? t("chat.thinking.auto")).toUpperCase();

  return (
    <div className="thinking-picker">
      <button
        type="button"
        className={cn("tp-trigger", peak && "peak", reasoningOff && "disabled")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-disabled={reasoningOff}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="beam" aria-hidden="true">
          <i />
        </span>
        <span className="tp-label">{t("chat.thinking.label")}</span>
        <span className="tp-level">{levelText}</span>
        <span className="tp-chev">▴</span>
      </button>
      {open && (
        <div
          className={cn("tp-popover", peak && "peak")}
          role="dialog"
          aria-label={t("chat.thinking.popoverLabel")}
        >
          <span className="beam" aria-hidden="true">
            <i />
          </span>
          <div className="tp-head">
            <span className="tp-title">{t("chat.thinking.title")}</span>
            <span className="tp-peak-badge">{t("chat.thinking.peakBadge")}</span>
            <span className="tp-scope">{t("chat.thinking.scope")}</span>
          </div>
          {/* F1.2：reasoning=false → 说明取代滑块位（滑块不渲染，两态不叠加）；
              目录未到达 → 加载提示位（互斥）；就绪 → 滑块 */}
          {reasoningOff ? (
            <div className="tp-disabled-note">{t("chat.thinking.disabledNote")}</div>
          ) : capabilityKnown ? (
            <ThinkingLevelSlider
              levels={levels}
              value={effective}
              peak={peak}
              onSelect={setSessionThinking}
              ariaLabel={t("chat.thinking.sliderLabel")}
            />
          ) : (
            <div className="tp-cap-loading">{t("chat.thinking.capabilityLoading")}</div>
          )}
          {clamped && (
            <div className="tp-hint">
              {t("chat.thinking.clampedHint", { override: override!, effective: effective! })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ComposerThinkingPicker;
