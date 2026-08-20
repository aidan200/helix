/**
 * P-3 模型切换弹出菜单（F(3.3).1-F(3.3).3；features/model-switch；T3.3）。
 *
 * 380px hud-popover（.app 直系子元素 + absolute，载体同 stats-pop——
 * backdrop-filter 包含块约束）。数据零权威：目录/默认来自 topology.
 * modelConfig（model.catalog / model.get_default 结果帧驱动）；当前模型
 * 来自活跃 store（welcome / model.changed）。选中即发 model.set（信封
 * sessionId，下一 turn 生效）——徽标/选中态由 model.changed 广播回流驱动
 * （前端不本地写 store，review.md mock 载体替换约定）。
 *
 * 行为规则：
 * - F(3.3).1 分组渲染（provider 序沿目录）+ 当前高亮 + 搜索过滤（命中
 *   模型名/provider 名；零命中空态与列表互斥；清空恢复）；
 * - F(3.3).2 选中即切 + 不关菜单（连续比对）+ in-flight 提示文案；
 * - F(3.3).3 重置为默认：会话模型 ≠ 全局默认时显示（相等隐藏）；
 * - T5.3 可用性口径（用户裁决，覆盖原型“全目录”）：打开补发 auth.list；
 *   仅显示 provider configured 的模型（verifyStatus 不参与）；当前会话
 *   模型兑底（无论 provider 是否 configured 都保留）；未配置分组整体
 *   隐藏；零可用（无 configured 且当前模型不在目录）给配置引导空态。
 * 状态模型：菜单 open|closed（点外/Esc 关闭；开合归 TopBar 徽标）；
 * 搜索 results|empty 互斥（切空态先清列表渲染）；零可用空态与搜索空态
 * 互斥（搜索词为空才可能出现零可用）。
 */
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, RotateCcw, Search } from "lucide-react";
import type { CatalogModel } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { useSession } from "@/entities/session/SessionContext";
import { cn } from "@/shared/lib/cn";
import { filterAvailableModels, resolveCatalogMatch, sameModel } from "../model/available-models";

/** ctx chip 档位（200k / 400k / 1M…）。 */
function fmtContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  return `${Math.round(tokens / 1_000)}k`;
}

export interface ModelSwitchMenuProps {
  onClose: () => void;
  /** P-3 → P-4 流转入口（顶栏注入 navigate(ROUTE_MODELS)；T3.4 迁移后路由位） */
  onOpenSettings: () => void;
}

const ModelSwitchMenu = function ModelSwitchMenu({ onClose, onOpenSettings }: ModelSwitchMenuProps) {
  const { t } = useI18n();
  const toast = useToast();
  const { state, topology, setSessionModel, requestModelConfig, requestAuthList } = useSession();
  const [query, setQuery] = useState("");
  const mc = topology.modelConfig;

  // 打开即拉目录 + 全局默认（requestModelConfig 未请求态才发——重复打开零重发）
  // + auth.list（T5.3 可用性过滤数据源；每次打开都刷新凭据面）
  useEffect(() => {
    requestModelConfig();
    requestAuthList();
  }, [requestModelConfig, requestAuthList]);

  // 点外关闭 / Esc（徽标点击归 TopBar toggle，不在此误关）
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target && typeof target.closest === "function" && target.closest('[data-model-badge], .model-menu')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // 草稿态 currentModel 回退解析（T3，bug4）：state.model（本地暂存所选）
  // 空 → 全局默认——选中态/徽标同源（顶栏徽标同一回退口径）；非草稿不变。
  const currentModel =
    state.sessionId === null ? state.model || mc.defaultModel : state.model;

  /** 可用性过滤（T5.3）+ 搜索 + provider 分组（组内序与组间序保持目录顺序）。 */
  const { groups, currentHit, defaultHit } = useMemo(() => {
    const models = mc.catalog?.models ?? [];
    const visible = filterAvailableModels({
      models,
      auth: mc.auth,
      authLoaded: mc.authLoaded,
      currentModel,
      query,
    });
    const byProvider = new Map<string, CatalogModel[]>();
    for (const m of visible) {
      const list = byProvider.get(m.providerId);
      if (list) list.push(m);
      else byProvider.set(m.providerId, [m]);
    }
    return {
      groups: [...byProvider.entries()],
      // T5.4：选中态/默认徽标走目录解析（provider 维度；短 id 跨厂商歧义不标）
      currentHit: resolveCatalogMatch(currentModel, models),
      defaultHit: mc.defaultModel === "" ? undefined : resolveCatalogMatch(mc.defaultModel, models),
    };
  }, [mc.catalog, mc.auth, mc.authLoaded, mc.defaultModel, currentModel, query]);

  const hasResults = groups.length > 0;
  const empty = query.trim() !== "" && !hasResults; // 搜索零命中空态（与列表互斥）
  // 零可用空态（T5.3：目录与 auth 均已到达、无 configured provider 且当前
  // 模型不在目录；与搜索空态互斥——搜索词为空才判定）
  const noAvailable =
    query.trim() === "" && !hasResults && mc.catalog !== null && mc.authLoaded;
  // F(3.3).3：会话模型 ≠ 全局默认才显示重置入口（相等隐藏）
  const showReset = mc.defaultModel !== "" && !sameModel(currentModel, mc.defaultModel);

  /** F(3.3).2 选中即切：发 model.set + toast 交代；不关菜单（连续比对）。 */
  const pick = (model: string, label: string) => {
    setSessionModel(model);
    toast.push("ok", t("chat.modelSwitch.switchedToast", { model: label }));
  };

  return (
    <div className="model-menu open" role="menu" aria-label={t("chat.topbar.modelTitle")} data-model-menu>
      <div className="mm-search">
        <Search size={14} strokeWidth={1.75} aria-hidden="true" />
        <input
          type="text"
          placeholder={t("chat.modelSwitch.searchPlaceholder")}
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-mm-search
        />
      </div>
      {hasResults && (
        <div className="mm-list" data-mm-list>
          {groups.map(([providerId, models]) => (
            <div className="mm-group" data-group={providerId} key={providerId}>
              <div className="mm-glabel">{providerId}</div>
              {models.map((m) => {
                const sel = currentHit === m;
                const isDefault = defaultHit === m;
                return (
                  <button
                    className={cn("mm-item", sel && "sel")}
                    type="button"
                    role="menuitemradio"
                    aria-checked={sel}
                    data-model-item={m.id}
                    key={m.id}
                    onClick={() => pick(m.id, m.id)}
                  >
                    <span className="mm-name">{m.id}</span>
                    {isDefault && (
                      <span className="hud-badge mm-def">{t("chat.modelSwitch.defaultBadge")}</span>
                    )}
                    <span className="hud-chip">{fmtContext(m.contextWindow)}</span>
                    <span className="mm-check">
                      <Check size={14} strokeWidth={1.75} aria-hidden="true" />
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {empty && (
        <div className="mm-empty show" data-mm-empty>
          <span>{t("chat.modelSwitch.emptyTitle")}</span>
          <span className="me-sub">{t("chat.modelSwitch.emptySub")}</span>
        </div>
      )}
      {noAvailable && (
        <div className="mm-empty show" data-mm-empty data-mm-no-available>
          <span>{t("chat.modelSwitch.noProviderTitle")}</span>
          <span className="me-sub">{t("chat.modelSwitch.noProviderSub")}</span>
        </div>
      )}
      <div className="mm-foot">
        {showReset && (
          <button
            className="hud-btn hud-btn-ghost sm"
            id="btn-model-reset"
            type="button"
            onClick={() => pick(mc.defaultModel, mc.defaultModel)}
          >
            <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
            {t("chat.modelSwitch.resetToDefault")}
          </button>
        )}
        {/* F(3.3).2 生效语义提示（in-flight 不变——用户需知） */}
        <span className="mm-hint">{t("chat.modelSwitch.effectiveHint")}</span>
      </div>
      {/* P-3 → P-4 流转入口 */}
      <div className="mm-more">
        <button
          type="button"
          data-mm-more
          onClick={() => {
            onClose();
            onOpenSettings();
          }}
        >
          {t("chat.modelSwitch.configEntry")}
          <span className="ar">
            <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
          </span>
        </button>
      </div>
    </div>
  );
};

export default ModelSwitchMenu;
