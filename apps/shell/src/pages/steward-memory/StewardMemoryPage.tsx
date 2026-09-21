/**
 * 管家记忆独立页（/steward/memory，B2-④）。
 *
 * 头部：搜索框（前端过滤——条目量千级天花板，无服务端检索诉求）+
 * 统计（N 条 · dim 维——steward.config.result memory 面）+ 当前端点徽标
 * （引用态 name/model）+ 右上「+ 新增」弹窗（text + kind 下拉 →
 * steward.memory_append）。
 *
 * 列表（steward.memory_list.result 驱动——list/append/update/delete 四命令
 * 共用回执，写后即刷新）：text | kind 徽标 | 相对时间 | 来源轮次
 * （sourceTurn：steward-turn = remember 工具 / manual = 人工新增）；
 * 行内编辑（保存触发 steward.memory_update——重嵌异步，行内「向量化中」态）
 * + 两段式 armed 删除。
 *
 * 页面壳：AppLayout（SettingsPage 同构）；不进 IconRail 六位（低频不占常驻
 * 导航——入口 = StewardPanel 头部记忆钮 + 设置管家记忆区「管理记忆」链接）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Plus, Search } from "lucide-react";
import type { StewardMemoryEntryView } from "@helix/protocol";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { relativeTimeSpan } from "@/shared/lib/format";
import AppLayout from "@/widgets/app-layout/ui/AppLayout";
import { useArmedConfirm } from "@/shared/lib/useArmedConfirm";

/** kind 下拉枚举（对齐 daemon 存储面既有 kind 值）。 */
const KIND_OPTIONS = ["fact", "preference"] as const;

/** 相对时间文案（刚刚 / N 分钟前 / N 小时前 / 昨天）。 */
function timeLabel(at: number, t: (k: string, v?: Record<string, string | number>) => string): string {
  const span = relativeTimeSpan(at, Date.now());
  switch (span.key) {
    case "justNow":
      return t("steward.memory.justNow");
    case "minutes":
      return t("chat.sidebar.timeMinutes", { n: span.n });
    case "hours":
      return t("chat.sidebar.timeHours", { n: span.n });
    default:
      return t("chat.sidebar.timeYesterday");
  }
}

const StewardMemoryPage = function StewardMemoryPage({ path }: { path: string }) {
  const { t } = useI18n();
  const {
    sendStewardMemoryList,
    sendStewardMemoryAppend,
    sendStewardMemoryUpdate,
    sendStewardMemoryDelete,
    sendStewardGetConfig,
    subscribeStewardFrames,
  } = useSession();

  const [entries, setEntries] = useState<readonly StewardMemoryEntryView[] | null>(null);
  /** 记忆面现态（统计 + 端点徽标数据源）。 */
  const [memoryState, setMemoryState] = useState<{
    enabled: boolean;
    available: boolean;
    endpoint: { id: string; name: string; model: string; hasApiKey: boolean } | null;
    entryCount: number;
    dim: number | null;
  } | null>(null);
  const [search, setSearch] = useState("");
  /** 行内编辑（id → 编辑文本；null = 非编辑态）。 */
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  /** 向量化在途行（memory_append/update 的回执等待面）。 */
  const [vectorizing, setVectorizing] = useState<number | "new" | null>(null);
  /** 新增弹窗（text + kind）。 */
  const [adding, setAdding] = useState<{ text: string; kind: (typeof KIND_OPTIONS)[number] } | null>(null);
  const [addErr, setAddErr] = useState<string | null>(null);
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const { armed: armedDelete, confirm: confirmDelete } = useArmedConfirm();

  useEffect(() => {
    sendStewardMemoryList();
    sendStewardGetConfig();
  }, [sendStewardMemoryList, sendStewardGetConfig]);
  useEffect(
    () =>
      subscribeStewardFrames?.((e) => {
        if (e.type === "steward.memory_list.result") {
          setEntries(e.payload.entries);
          setVectorizing(null); // 写后即回新清单——清在途态
          return;
        }
        if (e.type === "steward.config.result") {
          const payload = e.payload as {
            memory?: {
              enabled: boolean;
              available: boolean;
              endpoint: { id: string; name: string; model: string; hasApiKey: boolean } | null;
              entryCount: number;
              dim: number | null;
            };
          };
          if (payload.memory !== undefined) setMemoryState(payload.memory);
        }
      }),
    [subscribeStewardFrames],
  );

  /** 前端搜索过滤（大小写不敏感子串）。 */
  const filtered = useMemo(() => {
    if (entries === null) return null;
    const q = search.trim().toLowerCase();
    if (q === "") return entries;
    return entries.filter((e) => e.text.toLowerCase().includes(q));
  }, [entries, search]);

  const available = memoryState?.available === true;

  const openAdd = (): void => {
    setAddErr(null);
    setAdding({ text: "", kind: "fact" });
    window.setTimeout(() => addInputRef.current?.focus(), 60);
  };

  const submitAdd = (): void => {
    if (adding === null) return;
    if (adding.text.trim() === "") {
      setAddErr(t("steward.memory.emptyTextErr"));
      return;
    }
    if (sendStewardMemoryAppend(adding.text, adding.kind) === false) return; // 未连接：保留弹窗可重试
    setVectorizing("new");
    setAdding(null);
  };

  const saveEdit = (): void => {
    if (editing === null || editing.text.trim() === "") return;
    if (sendStewardMemoryUpdate(editing.id, editing.text) === false) return;
    setVectorizing(editing.id);
    setEditing(null);
  };

  const onDelete = (id: number): void => {
    confirmDelete(String(id), () => {
      sendStewardMemoryDelete(id);
    });
  };

  // 新增弹窗 Escape 关闭（hud-modal 先例）
  useEffect(() => {
    if (adding === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAdding(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [adding]);

  return (
    <div data-steward-memory-page={path}>
      <AppLayout headerLeft={<h1 className="tb-title">{t("steward.memory.pageTitle")}</h1>}>
        <div className="pg" data-memory-page-body>
          {/* 头部：搜索 + 统计 + 端点徽标 + 新增入口 */}
          <div className="toolbar" data-memory-page-head>
            <div className="toolbar-row">
              <div className="fld">
                <span className="hud-label" aria-hidden="true">
                  <Search size={14} strokeWidth={1.75} />
                </span>
                <input
                  className="hud-input"
                  value={search}
                  placeholder={t("steward.memory.searchPlaceholder")}
                  data-memory-search
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {memoryState !== null && (
                <span className="ag-note" data-memory-stats>
                  {t("steward.memory.stats", {
                    count: memoryState.entryCount,
                    dim: memoryState.dim ?? 0,
                  })}
                </span>
              )}
              {memoryState?.endpoint !== null && memoryState !== null && (
                <span className="conn hud-badge hud-badge-cyan" data-memory-endpoint-badge>
                  {`${memoryState.endpoint?.name ?? ""} · ${memoryState.endpoint?.model ?? ""}`}
                </span>
              )}
              <button
                className="hud-btn hud-btn-cyan sm"
                type="button"
                data-memory-add-open
                disabled={!available}
                title={available ? undefined : t("steward.memory.unavailable")}
                onClick={openAdd}
              >
                <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
                {t("steward.memory.add")}
              </button>
            </div>
            {!available && <span className="ag-note" data-memory-unavailable>{t("steward.memory.unavailable")}</span>}
          </div>

          {/* 列表：text | kind 徽标 | 相对时间 | 来源轮次 + 行内编辑/删除 */}
          {filtered !== null && filtered.length === 0 && (
            <p className="ag-note" data-memory-list-empty>
              {t("steward.memory.empty")}
            </p>
          )}
          <div className="memory-list" data-memory-list>
            {(filtered ?? []).map((entry) => {
              const isEditing = editing?.id === entry.id;
              const isVectorizing = vectorizing === entry.id;
              return (
                <div key={entry.id} className="memory-item" data-memory-item={entry.id}>
                  {isVectorizing ? (
                    <span className="ag-note" data-memory-item-vectorizing>
                      {t("steward.memory.vectorizing")}
                    </span>
                  ) : isEditing ? (
                    <div className="memory-edit">
                      <input
                        className="hud-input"
                        value={editing!.text}
                        data-memory-edit-input
                        onChange={(e) => setEditing({ id: entry.id, text: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit();
                          if (e.key === "Escape") setEditing(null);
                        }}
                      />
                      <button
                        className="hud-btn hud-btn-cyan sm"
                        type="button"
                        data-memory-edit-save
                        disabled={editing!.text.trim() === ""}
                        onClick={saveEdit}
                      >
                        {t("chat.settings.general.memorySave")}
                      </button>
                      <button
                        className="hud-btn hud-btn-ghost sm"
                        type="button"
                        data-memory-edit-cancel
                        onClick={() => setEditing(null)}
                      >
                        {t("chat.settings.general.memoryCancel")}
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="memory-text" data-memory-item-text={entry.id}>
                        {entry.text}
                      </span>
                      <span className="hud-chip" data-memory-item-kind={entry.id}>
                        {t(`chat.settings.general.memoryKind.${entry.kind}`)}
                      </span>
                      <span className="memory-meta" data-memory-item-meta={entry.id}>
                        {timeLabel(entry.createdAt, t)} · {t(`steward.memory.source.${entry.sourceTurn === "manual" ? "manual" : "stewardTurn"}`)}
                      </span>
                      <div className="memory-actions">
                        <button
                          className="hud-btn hud-btn-ghost sm"
                          type="button"
                          data-memory-edit-btn={entry.id}
                          disabled={!available}
                          onClick={() => setEditing({ id: entry.id, text: entry.text })}
                        >
                          {t("chat.settings.general.memoryEdit")}
                        </button>
                        <button
                          className={cn("hud-btn sm", armedDelete === String(entry.id) ? "hud-btn-danger" : "hud-btn-ghost")}
                          type="button"
                          data-memory-delete-btn={entry.id}
                          data-armed={armedDelete === String(entry.id) ? "1" : undefined}
                          onClick={() => onDelete(entry.id)}
                        >
                          {armedDelete === String(entry.id)
                            ? t("chat.modelsConfig.confirmDelete")
                            : t("chat.settings.general.memoryDelete")}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* 新增弹窗（text + kind 下拉 → steward.memory_append） */}
          {adding !== null && (
            <div
              className="modal-backdrop open"
              role="presentation"
              onClick={(e) => {
                if (e.target === e.currentTarget) setAdding(null);
              }}
            >
              <div className="hud-modal" role="dialog" aria-modal="true" aria-label={t("steward.memory.addModalTitle")}>
                <div className="modal-title">{t("steward.memory.addModalTitle")}</div>
                <p className="modal-sub">{t("steward.memory.addModalSub")}</p>
                <div className="modal-body">
                  <label className="hud-label" htmlFor="memory-add-text">
                    {t("steward.memory.textLabel")}
                  </label>
                  <input
                    className={cn("hud-input", addErr !== null && adding.text.trim() === "" && "err")}
                    id="memory-add-text"
                    type="text"
                    value={adding.text}
                    ref={addInputRef}
                    data-memory-add-input
                    onChange={(e) => setAdding({ ...adding, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitAdd();
                    }}
                  />
                  <label className="hud-label" htmlFor="memory-add-kind">
                    {t("steward.memory.kindLabel")}
                  </label>
                  <div className="sel-wrap">
                    <select
                      className="hud-input"
                      id="memory-add-kind"
                      value={adding.kind}
                      data-memory-add-kind
                      onChange={(e) => setAdding({ ...adding, kind: e.target.value as (typeof KIND_OPTIONS)[number] })}
                    >
                      {KIND_OPTIONS.map((k) => (
                        <option key={k} value={k}>
                          {t(`chat.settings.general.memoryKind.${k}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <span className={cn("form-err", addErr !== null && "show")} data-memory-add-err>
                    <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
                    {addErr ?? ""}
                  </span>
                </div>
                <div className="modal-foot">
                  <button className="hud-btn hud-btn-ghost" type="button" data-memory-add-cancel onClick={() => setAdding(null)}>
                    {t("chat.modelsConfig.cancel")}
                  </button>
                  <button
                    className="hud-btn hud-btn-cyan"
                    type="button"
                    data-memory-add-save
                    disabled={vectorizing === "new"}
                    onClick={submitAdd}
                  >
                    {vectorizing === "new" ? t("steward.memory.vectorizing") : t("chat.settings.general.memorySave")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </AppLayout>
    </div>
  );
};

export default StewardMemoryPage;
