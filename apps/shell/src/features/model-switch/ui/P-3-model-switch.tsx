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
 * - F(3.3).3 重置为默认：会话模型 ≠ 全局默认时显示（相等隐藏）。
 * 状态模型：菜单 open|closed（点外/Esc 关闭；开合归 TopBar 徽标）；
 * 搜索 results|empty 互斥（切空态先清列表渲染）。
 */
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, RotateCcw, Search } from "lucide-react";
import type { CatalogModel } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { useSession } from "@/entities/session/SessionContext";
import { cn } from "@/shared/lib/cn";

/** ctx chip 档位（200k / 400k / 1M…）。 */
function fmtContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  return `${Math.round(tokens / 1_000)}k`;
}

/** 模型 id 双形态匹配（welcome 短 id / model.changed 完整 id 兼容）。 */
function sameModel(a: string, b: string): boolean {
  if (a === b) return true;
  const sa = a.split("/").pop() ?? a;
  const sb = b.split("/").pop() ?? b;
  return sa !== "" && sa === sb;
}

export interface ModelSwitchMenuProps {
  onClose: () => void;
  /** P-3 → P-4 流转入口（顶栏注入 navigate(ROUTE_SETTINGS_MODELS)） */
  onOpenSettings: () => void;
}

const ModelSwitchMenu = function ModelSwitchMenu({ onClose, onOpenSettings }: ModelSwitchMenuProps) {
  const { t } = useI18n();
  const toast = useToast();
  const { state, topology, setSessionModel, requestModelConfig } = useSession();
  const [query, setQuery] = useState("");
  const mc = topology.modelConfig;

  // 打开即拉目录 + 全局默认（requestModelConfig 未请求态才发——重复打开零重发）
  useEffect(() => {
    requestModelConfig();
  }, [requestModelConfig]);

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

  /** 搜索过滤 + provider 分组（组内序与组间序保持目录顺序）。 */
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byProvider = new Map<string, CatalogModel[]>();
    for (const m of mc.catalog?.models ?? []) {
      if (q && !m.id.toLowerCase().includes(q) && !m.providerId.toLowerCase().includes(q)) continue;
      const list = byProvider.get(m.providerId);
      if (list) list.push(m);
      else byProvider.set(m.providerId, [m]);
    }
    return [...byProvider.entries()];
  }, [mc.catalog, query]);

  const hasResults = groups.length > 0;
  const empty = query.trim() !== "" && !hasResults; // 搜索零命中空态（与列表互斥）
  // F(3.3).3：会话模型 ≠ 全局默认才显示重置入口（相等隐藏）
  const showReset = mc.defaultModel !== "" && !sameModel(state.model ?? "", mc.defaultModel);

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
                const sel = state.model !== undefined && sameModel(state.model, m.id);
                const isDefault = mc.defaultModel !== "" && sameModel(mc.defaultModel, m.id);
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
