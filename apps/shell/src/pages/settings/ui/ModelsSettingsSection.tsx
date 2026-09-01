/**
 * 模型设置分区（S2：P-4 模型与厂商配置自独立路由页迁入设置页；T3.3 原稿）。
 *
 * 数据零权威：目录/默认/provider 凭据全部来自 topology.modelConfig
 * （model.catalog / get_default / auth.list 结果帧驱动）；进入分区时拉取
 * （requestModelConfig + requestAuthList）。命令发送经 SessionContext
 * model/auth 面板（auth.set_key / delete_key / verify / model.set_default /
 * catalog_refresh——信封语义见契约 C）。
 *
 * 六功能点（review.md §6 必须还原）：
 * - F(3.4).1 provider 字母分组：已配高亮（accent 边框）+ key 尾 4 位脱敏
 *   （尾 4 位 accent）；未配弱化「未配置」；
 * - F(3.4).2 key 弹层：hud-modal（backdrop + 缩放淡入）；非空校验（空值
 *   红边 + 内联错误 + 聚焦；输入转 clean）；两段式行内删除确认（armed
 *   2.5s 超时复原，二击生效）；
 * - F(3.4).3 连通四态互斥（unverified|verifying|ok 含延迟|fail 含原因）；
 *   重测先清旧态（store 层 started action 已处理）；
 * - F(3.4).4 展开 provider 模型表：id / 上下文 / 四费率（$ / 1M tokens，
 *   tabular-nums）；默认行高亮 + DEFAULT chip；
 * - F(3.4).5 刷新目录：catalog_refresh 强制拉（图标转动 → 结果帧清
 *   in-flight → 时间戳更新）；
 * - F(3.4).6 全局默认选择器：写 SQLite（model.set_default 乐观更新）。
 * S2 迁移口径：剥离原 .p4-page/.p4-head 页壳与返回钮（onBack 删除），
 * .pg 版心 + 全部功能逻辑零行为变更；分区标题 = 原 chat.settings.title。
 * 状态模型：连通徽标四态互斥；弹层 open|closed；校验 clean|error；删除
 * normal|armed（单值，超时复原）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import ThinkingLevelSlider from "@/features/thinking-level/ui/ThinkingLevelSlider";
import { defaultLevelFor, resolveThinkingCapability } from "@/features/thinking-level/model/thinking-capability";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  KeyRound,
  RefreshCw,
} from "lucide-react";
import type { AuthProviderEntry, ModelConfigState } from "@/entities/session/model/state";
import type { CatalogModel } from "@helix/protocol";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { cn } from "@/shared/lib/cn";
import { relativeTimeSpan } from "@/shared/lib/format";

/** ctx 档位（200k / 400k / 1M…；与 P-3 同源格式）。 */
function fmtContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  return `${Math.round(tokens / 1_000)}k`;
}

/** 费率档位显示（$ / 1M tokens；小数至少两位保尾零对齐——1.5→$1.50，
 *  0.028→$0.028；0 值显示占位「…」沿原型口径）。 */
function fmtRate(v: number): string {
  if (v <= 0) return "…";
  const s = String(v);
  if (!s.includes(".")) return `$${s}`;
  const digits = Math.max(s.split(".")[1]!.length, 2);
  return `$${v.toFixed(digits)}`;
}

/** 目录刷新时间戳相对档位（刚刚 / N 分钟前 / N 小时前）。 */
function refreshedLabel(refreshedAt: number, t: (k: string, v?: Record<string, string | number>) => string): string {
  const span = relativeTimeSpan(refreshedAt, Date.now());
  switch (span.key) {
    case "justNow":
      return "";
    case "minutes":
      return t("chat.sidebar.timeMinutes", { n: span.n });
    case "hours":
      return t("chat.sidebar.timeHours", { n: span.n });
    default:
      return t("chat.sidebar.timeYesterday");
  }
}

/** 连通徽标四态（F(3.4).3：互斥单值；verifying 为前端 in-flight 态）。 */
function ConnBadge({ entry }: { entry: AuthProviderEntry }) {
  const { t } = useI18n();
  switch (entry.verifyStatus) {
    case "verifying":
      return (
        <span className="conn hud-badge hud-badge-cyan" data-conn-badge="verifying">
          <span className="hud-dot hud-dot-cyan hud-dot-pulse" aria-hidden="true" />
          {t("chat.modelsConfig.connVerifying")}
        </span>
      );
    case "ok":
      return (
        <span className="conn hud-badge hud-badge-ok" data-conn-badge="ok">
          <span className="hud-dot hud-dot-ok" aria-hidden="true" />
          {t("chat.modelsConfig.connOk", { ms: entry.latencyMs ?? 0 })}
        </span>
      );
    case "fail":
      return (
        <span className="conn hud-badge hud-badge-error" data-conn-badge="fail">
          <span className="hud-dot hud-dot-error" aria-hidden="true" />
          {t("chat.modelsConfig.connFail", { reason: entry.failReason ?? "" })}
        </span>
      );
    default:
      return (
        <span className="conn hud-badge hud-badge-off" data-conn-badge="unverified">
          {t("chat.modelsConfig.connUnverified")}
        </span>
      );
  }
}

const ModelsSettingsSection = function ModelsSettingsSection() {
  const { t } = useI18n();
  const toast = useToast();
  const {
    topology,
    requestModelConfig,
    requestAuthList,
    refreshModelCatalog,
    setDefaultModel,
    setThinkingDefault,
    verifyProvider,
    setProviderKey,
    deleteProviderKey,
  } = useSession();
  const mc: ModelConfigState = topology.modelConfig;

  // key 弹层状态（open|closed；校验 clean|error）
  const [modal, setModal] = useState<{ provider: string } | null>(null);
  const [keyValue, setKeyValue] = useState("");
  const [keyErr, setKeyErr] = useState(false);
  const keyInputRef = useRef<HTMLInputElement | null>(null);
  // 两段式删除 armed（providerId 单值；2.5s 超时复原）
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const deleteTimer = useRef<number | null>(null);
  // 展开的 provider（单值；null = 全收起）
  const [expanded, setExpanded] = useState<string | null>(null);

  // 进入分区拉数据（目录/默认未请求态才发；auth.list 每次进入刷新）
  useEffect(() => {
    requestModelConfig();
    requestAuthList();
  }, [requestModelConfig, requestAuthList]);

  // armed 超时复原（2.5s；unmount 清理）
  useEffect(() => {
    return () => {
      if (deleteTimer.current !== null) window.clearTimeout(deleteTimer.current);
    };
  }, []);

  /** provider 行（auth.list 全集；catalog 仅贡献模型表数据）。 */
  const providers = useMemo(() => {
    const rows = Object.values(mc.auth);
    rows.sort((a, b) => a.providerId.localeCompare(b.providerId));
    // 字母分组（首字母大写标签行）
    const groups: { letter: string; rows: AuthProviderEntry[] }[] = [];
    for (const row of rows) {
      const letter = (row.providerId[0] ?? "?").toUpperCase();
      const last = groups[groups.length - 1];
      if (last && last.letter === letter) last.rows.push(row);
      else groups.push({ letter, rows: [row] });
    }
    return groups;
  }, [mc.auth]);

  /** catalog 按 provider 分组（模型表数据源；F(3.4).4）。 */
  const modelsByProvider = useMemo(() => {
    const map = new Map<string, CatalogModel[]>();
    for (const m of mc.catalog?.models ?? []) {
      const list = map.get(m.providerId);
      if (list) list.push(m);
      else map.set(m.providerId, [m]);
    }
    return map;
  }, [mc.catalog]);

  const providerCount = modelsByProvider.size;
  const refreshedAtLabel = mc.catalog
    ? refreshedLabel(mc.catalog.refreshedAt, t)
    : "";

  /** key 弹层保存（F(3.4).2：非空校验 → 命令 + toast；脱敏回执驱动行更新）。 */
  const saveKey = () => {
    const v = keyValue.trim();
    if (!v || modal === null) {
      setKeyErr(true); // 空值：红边 + 内联错误 + 聚焦
      keyInputRef.current?.focus();
      return;
    }
    setProviderKey(modal.provider, v);
    setModal(null);
    setKeyValue("");
    setKeyErr(false);
  };

  /** 两段式删除（F(3.4).2：首击 armed → 按钮变「确认删除？」2.5s 复原；二击发命令）。 */
  const onDeleteKey = (providerId: string) => {
    if (armedDelete !== providerId) {
      setArmedDelete(providerId);
      if (deleteTimer.current !== null) window.clearTimeout(deleteTimer.current);
      deleteTimer.current = window.setTimeout(() => setArmedDelete(null), 2_500);
      return;
    }
    if (deleteTimer.current !== null) window.clearTimeout(deleteTimer.current);
    setArmedDelete(null);
    deleteProviderKey(providerId);
    toast.push("ok", t("chat.modelsConfig.keyDeletedToast", { provider: providerId }));
  };

  return (
    <div className="pg" data-models-section>
      <h2 className="pg-title">{t("chat.settings.title")}</h2>

      {/* 工具卡：全局默认选择器（F(3.4).6）+ 目录刷新（F(3.4).5） */}
      <div className="hud-card">
        <div className="toolbar">
          <div className="fld">
            <label className="hud-label" htmlFor="sel-default">
              {t("chat.modelsConfig.defaultLabel")}
            </label>
            <div className="sel-wrap">
              <select
                id="sel-default"
                className="hud-input"
                value={mc.defaultModel === "" ? undefined : mc.defaultModel}
                disabled={mc.catalog === null}
                onChange={(e) => {
                  setDefaultModel(e.target.value);
                  toast.push(
                    "ok",
                    t("chat.modelsConfig.defaultUpdatedToast", { model: e.target.value }),
                  );
                }}
              >
                {[...modelsByProvider.entries()].map(([providerId, models]) => (
                  <optgroup label={providerId} key={providerId}>
                    {models.map((m) => (
                      <option value={m.id} key={m.id}>
                        {m.id}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {(() => {
                // R7 全局兜底批：全局默认推理强度（档位解析基准 = 全局默认模型能力）
                const capability = resolveThinkingCapability(mc.defaultModel === "" ? "" : mc.defaultModel, mc.catalog?.models ?? undefined);
                const levels = capability?.thinkingLevels ?? [];
                if (levels.length === 0) {
                  return (
                    <p className="ag-note" data-global-thinking-unsupported>
                      {t("chat.modelsConfig.thinkingUnsupported")}
                    </p>
                  );
                }
                return (
                  <div className="fld" data-global-thinking>
                    <span className="hud-label">{t("chat.modelsConfig.thinkingDefaultLabel")}</span>
                    <ThinkingLevelSlider
                      levels={levels}
                      value={mc.defaultThinking !== null && levels.includes(mc.defaultThinking) ? mc.defaultThinking : null}
                      ghostValue={defaultLevelFor(levels)}
                      disabled={mc.catalog === null}
                      onSelect={(level) => setThinkingDefault(level)}
                      ariaLabel={t("chat.modelsConfig.thinkingDefaultLabel")}
                    />
                    {mc.defaultThinking !== null && (
                      <button
                        type="button"
                        className="hud-btn hud-btn-ghost hud-btn sm"
                        onClick={() => setThinkingDefault(null)}
                        data-global-thinking-clear
                      >
                        {t("chat.modelsConfig.thinkingDefaultClear")}
                      </button>
                    )}
                  </div>
                );
              })()}
              <span className="sel-chev">
                <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
              </span>
            </div>
          </div>
          <div className="toolbar-right">
            <button
              className="hud-btn hud-btn-ghost"
              id="btn-refresh-catalog"
              type="button"
              disabled={mc.catalogRefreshing}
              onClick={() => {
                refreshModelCatalog();
                toast.push("ok", t("chat.modelsConfig.refreshedToast"));
              }}
            >
              <RefreshCw
                className={cn(mc.catalogRefreshing && "spin")}
                size={14}
                strokeWidth={1.75}
                aria-hidden="true"
              />
              {t("chat.modelsConfig.refresh")}
            </button>
            <span className="catalog-meta" data-catalog-meta>
              <Clock size={14} strokeWidth={1.75} aria-hidden="true" />
              {mc.catalog !== null &&
                (refreshedAtLabel === ""
                  ? t("chat.modelsConfig.refreshedJustNow", { n: providerCount })
                  : t("chat.modelsConfig.refreshedAt", { time: refreshedAtLabel, n: providerCount }))}
            </span>
          </div>
        </div>
      </div>

      <h2 className="section-label">{t("chat.modelsConfig.providersLabel", { n: providers.reduce((n, g) => n + g.rows.length, 0) })}</h2>

      {/* F(3.4).1 provider 字母分组列表 */}
      {providers.map((group) => (
        <div key={group.letter}>
          <div className="pgroup-label">{group.letter}</div>
          {group.rows.map((row) => {
            const open = expanded === row.providerId;
            const models = modelsByProvider.get(row.providerId) ?? [];
            return (
              <div
                className={cn("prov", row.configured && "configured", open && "open")}
                data-prov={row.providerId}
                key={row.providerId}
              >
                <button
                  className="prov-head"
                  type="button"
                  data-prov-toggle
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? null : row.providerId)}
                >
                  <span className="prov-name">{row.providerId}</span>
                  {row.configured && row.keyMasked !== undefined ? (
                    <span className="key-chip">
                      key ····<span className="k4">{row.keyMasked.slice(-4)}</span>
                    </span>
                  ) : (
                    <span className="key-none">{t("chat.modelsConfig.unconfigured")}</span>
                  )}
                  <ConnBadge entry={row} />
                  <span className="pc-chev">
                    <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
                  </span>
                </button>
                <div className="prov-body">
                  <div className="prov-actions">
                    {row.configured ? (
                      <>
                        <button
                          className="hud-btn hud-btn-ghost sm"
                          type="button"
                          data-prov-test
                          disabled={row.verifyStatus === "verifying"}
                          onClick={() => verifyProvider(row.providerId)}
                        >
                          {t("chat.modelsConfig.test")}
                        </button>
                        <button
                          className="hud-btn hud-btn-ghost sm"
                          type="button"
                          data-prov-editkey
                          onClick={() => {
                            setModal({ provider: row.providerId });
                            setKeyValue("");
                            setKeyErr(false);
                            window.setTimeout(() => keyInputRef.current?.focus(), 60);
                          }}
                        >
                          {t("chat.modelsConfig.changeKey")}
                        </button>
                        <button
                          className="hud-btn hud-btn-danger sm"
                          type="button"
                          data-prov-delkey
                          data-armed={armedDelete === row.providerId ? "1" : undefined}
                          onClick={() => onDeleteKey(row.providerId)}
                        >
                          {armedDelete === row.providerId
                            ? t("chat.modelsConfig.confirmDelete")
                            : t("chat.modelsConfig.deleteKey")}
                        </button>
                      </>
                    ) : (
                      <button
                        className="hud-btn hud-btn-cyan sm"
                        type="button"
                        data-prov-addkey
                        onClick={() => {
                          setModal({ provider: row.providerId });
                          setKeyValue("");
                          setKeyErr(false);
                          window.setTimeout(() => keyInputRef.current?.focus(), 60);
                        }}
                      >
                        {t("chat.modelsConfig.configureKey")}
                      </button>
                    )}
                  </div>
                  {/* F(3.4).4 模型表：id / 上下文 / 四费率（tabular-nums） */}
                  <div className="mtable-wrap">
                    <table className="mtable">
                      <thead>
                        <tr>
                          <th>{t("chat.modelsConfig.colModel")}</th>
                          <th className="num">{t("chat.modelsConfig.colContext")}</th>
                          <th className="num">{t("chat.modelsConfig.colInput")}</th>
                          <th className="num">{t("chat.modelsConfig.colOutput")}</th>
                          <th className="num">{t("chat.modelsConfig.colCacheRead")}</th>
                          <th className="num">{t("chat.modelsConfig.colCacheWrite")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {models.map((m) => {
                          const isDefault =
                            mc.defaultModel !== "" && mc.defaultModel === m.id;
                          return (
                            <tr className={cn(isDefault && "is-default")} data-model-row={m.id} key={m.id}>
                              <td className="m-name">
                                {m.id}
                                {isDefault && (
                                  <span className="hud-chip" style={{ marginLeft: 6 }}>
                                    {t("chat.modelsConfig.defaultChip")}
                                  </span>
                                )}
                              </td>
                              <td className="num">{fmtContext(m.contextWindow)}</td>
                              <td className="num">{fmtRate(m.cost.input)}</td>
                              <td className="num">{fmtRate(m.cost.output)}</td>
                              <td className="num">{fmtRate(m.cost.cacheRead)}</td>
                              <td className="num">{fmtRate(m.cost.cacheWrite)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <p className="mtable-cap">{t("chat.modelsConfig.tableCaption")}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ))}

      {/* F(3.4).2 key 弹层（hud-modal：backdrop + 缩放淡入；非空校验内联） */}
      {modal !== null && (
        <div
          className={cn("modal-backdrop", "open")}
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <div className="hud-modal" role="dialog" aria-modal="true" aria-label={t("chat.modelsConfig.modalTitle", { provider: modal.provider })}>
            <div className="modal-title">
              <span className="mt-ic">
                <KeyRound size={16} strokeWidth={1.75} aria-hidden="true" />
              </span>
              {t("chat.modelsConfig.modalTitle", { provider: modal.provider })}
            </div>
            <p className="modal-sub">{t("chat.modelsConfig.modalSub")}</p>
            <div className="modal-body">
              <label className="hud-label" htmlFor="key-input">
                {t("chat.modelsConfig.apiKeyLabel")}
              </label>
              <input
                className={cn("hud-input", keyErr && "err")}
                id="key-input"
                type="password"
                autoComplete="off"
                placeholder={t("chat.modelsConfig.apiKeyPlaceholder")}
                value={keyValue}
                ref={keyInputRef}
                data-key-input
                onChange={(e) => {
                  setKeyValue(e.target.value);
                  if (keyErr) setKeyErr(false); // 输入即转 clean
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveKey();
                }}
              />
              <span className={cn("form-err", keyErr && "show")} data-key-err>
                <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
                {t("chat.modelsConfig.apiKeyEmptyErr")}
              </span>
            </div>
            <div className="modal-foot">
              <button
                className="hud-btn hud-btn-ghost"
                id="btn-modal-cancel"
                type="button"
                onClick={() => setModal(null)}
              >
                {t("chat.modelsConfig.cancel")}
              </button>
              <button
                className="hud-btn hud-btn-cyan"
                id="btn-modal-save"
                type="button"
                disabled={mc.setKeyInflight !== null}
                onClick={saveKey}
              >
                {t("chat.modelsConfig.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelsSettingsSection;
