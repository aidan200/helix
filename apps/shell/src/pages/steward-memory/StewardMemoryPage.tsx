/**
 * 管家记忆独立页（/steward/memory，B2-④ + 遗忘机制批改版）。
 *
 * 头部：搜索框（前端过滤——条目量千级天花板，无服务端检索诉求）+
 * 排序下拉（最近更新/最早创建/被想起最多）+ 筛选 chip（kind × domain
 * 双维（domain 维度批，独立交叉组合）+ 生命周期档 全部/活跃/淡忘/置顶
 * ——零值 chip 隐藏）+ 多状态统计 + 当前端点徽标 + 右上「+ 新增」弹窗
 * （text + kind + domain 打标（选 project 露出项目名输入）→
 * steward.memory_append）。
 *
 * 列表（steward.memory_list.result 驱动——六命令共用回执，写后即刷新）：
 * 两行卡片（行1 text 占满换行 + pin 钮 + kind/domain 徽标；行2 meta 组
 * 「创建 · 来源（四值映射：手动/对话记录/总结沉淀/会话进展，auto-sediment
 * 历史值→自动沉淀）· 被想起 N 次 · 最后想起 X 前」+ 动作组）。faded 条目整卡灰显 +
 * 「淡忘中」徽标 + 恢复钮（steward.memory_restore——满血复活）；pinned
 * 徽标 + pin 钮切换（steward.memory_pin——置顶永不淡忘永不 GC）；
 * 行内编辑（保存触发 steward.memory_update——重嵌异步，行内「向量化中」
 * 态；编辑即救活）+ 两段式 armed 删除。
 *
 * 分页（客户端切片——协议零变更，与前端搜索/筛选正交）：每页 20/50/100
 * （localStorage helix.memory.pageSize，缺省 50）；搜索/筛选/排序变化重置
 * 第 1 页；写后回执按当前页首条 id 锚定页码；删当前页末条自动回退；
 * 总页数 ≤1 时分页条隐藏。
 *
 * 页面壳：AppLayout（SettingsPage 同构）；不进 IconRail 六位（低频不占常驻
 * 导航——入口 = StewardPanel 头部记忆钮 + 设置管家记忆区「管理记忆」链接）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ChevronLeft, ChevronRight, Pin, PinOff, Plus, RotateCcw, Search } from "lucide-react";
import type { StewardMemoryDomain, StewardMemoryEntryView } from "@helix/protocol";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { relativeTimeSpan } from "@/shared/lib/format";
import AppLayout from "@/widgets/app-layout/ui/AppLayout";
import { useArmedConfirm } from "@/shared/lib/useArmedConfirm";

/** kind 下拉枚举（对齐 daemon 存储面既有 kind 值）。 */
const KIND_OPTIONS = ["fact", "preference"] as const;

/** kind 筛选档位（比新增下拉多 progress——列表可含会话进展条目，E-247）。 */
const KIND_FILTERS = ["all", "fact", "preference", "progress"] as const;
type KindFilterKey = (typeof KIND_FILTERS)[number];

/** domain 枚举（业务领域维度批）：habit = 用户怎么干活 / general = 环境与
 * 通用工作方式 / project = 绑定具体项目才有意义（类型 = 协议 StewardMemoryDomain）。 */
const DOMAIN_VALUES: readonly StewardMemoryDomain[] = ["habit", "general", "project"];
/** domain 筛选档位。 */
const DOMAIN_FILTERS = ["all", ...DOMAIN_VALUES] as const;
type DomainFilterKey = (typeof DOMAIN_FILTERS)[number];

/** sourceTurn 实值 → i18n 键段（四值 + auto-sediment 历史存量值；未知值
 * 回落对话记录标签）。 */
const SOURCE_KEYS: Record<string, string> = {
  manual: "manual",
  "steward-turn": "stewardTurn",
  "session-summary": "sessionSummary",
  "session-progress": "sessionProgress",
  "auto-sediment": "autoSediment",
};

/** 筛选档位。 */
type FilterKey = "all" | "active" | "faded" | "pinned";
/** 排序档位。 */
type SortKey = "updated" | "created" | "recalled";

/** 分页：每页档位与本地偏好键。 */
const PAGE_SIZES = [20, 50, 100] as const;
const PAGE_SIZE_KEY = "helix.memory.pageSize";
/** 页码条折叠窗口（超过 7 页时中段折叠省略）。 */
const PAGE_ELLIPSIS_LIMIT = 7;

function loadPageSize(): number {
  const raw = Number.parseInt(window.localStorage.getItem(PAGE_SIZE_KEY) ?? "", 10);
  return (PAGE_SIZES as readonly number[]).includes(raw) ? raw : 50;
}

/** 相对时间文案（刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前）。 */
function timeLabel(at: number, t: (k: string, v?: Record<string, string | number>) => string): string {
  const span = relativeTimeSpan(at, Date.now());
  switch (span.key) {
    case "justNow":
      return t("steward.memory.justNow");
    case "minutes":
      return t("chat.sidebar.timeMinutes", { n: span.n });
    case "hours":
      return t("chat.sidebar.timeHours", { n: span.n });
    case "yesterday":
      return t("chat.sidebar.timeYesterday");
    default:
      return t("chat.sidebar.timeDays", { n: span.n });
  }
}

/** 来源标签（sourceTurn 经 SOURCE_KEYS 映射——模板串前缀族供死 key 扫描识别）。 */
function sourceLabel(sourceTurn: string, t: (k: string, v?: Record<string, string | number>) => string): string {
  return t(`steward.memory.source.${SOURCE_KEYS[sourceTurn] ?? "stewardTurn"}`);
}

const StewardMemoryPage = function StewardMemoryPage({ path }: { path: string }) {
  const { t } = useI18n();
  const {
    sendStewardMemoryList,
    sendStewardMemoryAppend,
    sendStewardMemoryUpdate,
    sendStewardMemoryDelete,
    sendStewardMemoryPin,
    sendStewardMemoryRestore,
    sendStewardGetConfig,
    subscribeStewardFrames,
  } = useSession();

  const [entries, setEntries] = useState<readonly StewardMemoryEntryView[] | null>(null);
  /** 记忆面现态（统计 + 端点徽标数据源）。 */
  const [memoryState, setMemoryState] = useState<{
    enabled: boolean;
    available: boolean;
    entryCount: number;
    dim: number | null;
  } | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [kindFilter, setKindFilter] = useState<KindFilterKey>("all");
  const [domainFilter, setDomainFilter] = useState<DomainFilterKey>("all");
  const [sortKey, setSortKey] = useState<SortKey>("updated");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(loadPageSize);
  /** 行内编辑（id → 编辑文本；null = 非编辑态）。 */
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  /** 向量化在途行（memory_append/update 的回执等待面）。 */
  const [vectorizing, setVectorizing] = useState<number | "new" | null>(null);
  /** 向量化在途镜像（订阅 listener 闭包读最新值——markVectorizing 同点写，
   *  TR-173：禁渲染体裸写）。 */
  const vectorizingRef = useRef<number | "new" | null>(null);
  const markVectorizing = (v: number | "new" | null): void => {
    vectorizingRef.current = v;
    setVectorizing(v);
  };
  /** 写面失败交代（connection.error 尾缀归因：steward.memory_* 写命令无结果帧
   *  ——不清在途则「向量化中」整行占位永挂且失败静默；TR-272 清位面）。 */
  const [writeError, setWriteError] = useState<string | null>(null);
  /** 新增弹窗（text + kind + domain 打标；project = domain=project 时配对
   * 的项目名——显式通道，随载荷透传）。 */
  const [adding, setAdding] = useState<{
    text: string;
    kind: (typeof KIND_OPTIONS)[number];
    domain: StewardMemoryDomain;
    project: string;
  } | null>(null);
  const [addErr, setAddErr] = useState<string | null>(null);
  const addInputRef = useRef<HTMLInputElement | null>(null);
  /** 写后回执的页码锚（当前页首条 id——新清单到达时按 id 重新定位页码）。 */
  const pageAnchorRef = useRef<number | null>(null);
  const { armed: armedDelete, confirm: confirmDelete } = useArmedConfirm();

  useEffect(() => {
    sendStewardMemoryList();
    sendStewardGetConfig();
  }, [sendStewardMemoryList, sendStewardGetConfig]);
  useEffect(
    () =>
      subscribeStewardFrames?.((e) => {
        if (e.type === "steward.memory_list.result") {
          const payload = e.payload as { entries: readonly StewardMemoryEntryView[] };
          setEntries(payload.entries);
          markVectorizing(null); // 写后即回新清单——清在途态
          setWriteError(null); // 回执成功即清写面失败交代
          return;
        }
        if (e.type === "connection.error") {
          // 写命令失败收口（评审 :131；TR-272）：daemon commandError 走
          // connection.error 无结果帧——尾缀归因（「（命令 <type>）」单一构造点），
          // 只消费 steward.memory_* 写命令（读命令 memory_list 归拉取侧，不误报）；
          // 清向量化在途位 + 行内交代（否则该行整行占位、不可编辑删除、失败静默）
          const message =
            (e.payload as { message?: string } | undefined)?.message ?? "connection.error";
          const cmd = /\uFF08\u547D\u4EE4 ([\w.]+)\uFF09\s*$/.exec(message)?.[1];
          if (cmd !== undefined && !cmd.startsWith("steward.memory_")) return; // 非本族不消费
          if (cmd === "steward.memory_list") return; // 读面失败归拉取（骨架）侧
          if (cmd === undefined && vectorizingRef.current === null) return; // 无尾缀旧 daemon：有在途写才按本面收口
          markVectorizing(null);
          setWriteError(message);
          return;
        }
        if (e.type === "steward.config.result") {
          const payload = e.payload as {
            memory?: {
              enabled: boolean;
              available: boolean;
                        entryCount: number;
              dim: number | null;
            };
          };
          if (payload.memory !== undefined) setMemoryState(payload.memory);
        }
      }),
    [subscribeStewardFrames],
  );

  /** 筛选/排序/搜索变化 → 重置第 1 页。 */
  useEffect(() => {
    setPage(1);
    pageAnchorRef.current = null;
  }, [search, filter, kindFilter, domainFilter, sortKey, pageSize]);

  /** 写操作前记录当前页首条锚（回执到达时按 id 重定位——写后条目可能换页）。 */
  const notePageAnchor = (items: readonly StewardMemoryEntryView[]): void => {
    pageAnchorRef.current = items.length > 0 ? items[0]!.id : null;
  };

  /** 搜索 + 筛选 → 排序 → 切片（派生链单点）。 */
  const view = useMemo(() => {
    if (entries === null) return null;
    const q = search.trim().toLowerCase();
    const filtered = entries.filter((e) => {
      if (q !== "" && !e.text.toLowerCase().includes(q)) return false;
      if (kindFilter !== "all" && e.kind !== kindFilter) return false; // kind × domain 双维独立交叉
      if (domainFilter !== "all" && e.domain !== domainFilter) return false;
      if (filter === "faded") return e.faded === true;
      if (filter === "pinned") return e.pinned === true;
      if (filter === "active") return e.faded !== true;
      return true;
    });
    const sorted = [...filtered].sort((a, b) => {
      if (sortKey === "created") return a.createdAt - b.createdAt;
      if (sortKey === "recalled") {
        const d = (b.recallCount ?? 0) - (a.recallCount ?? 0);
        return d !== 0 ? d : a.createdAt - b.createdAt;
      }
      return (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt);
    });
    const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
    return { sorted, pageCount };
  }, [entries, search, filter, kindFilter, domainFilter, sortKey, pageSize]);

  /** 新清单到达 → 按 id 锚定页码（找不到则回退最近有效页）。 */
  useEffect(() => {
    if (view === null) return;
    const anchor = pageAnchorRef.current;
    pageAnchorRef.current = null;
    if (anchor !== null) {
      const idx = view.sorted.findIndex((e) => e.id === anchor);
      setPage(idx >= 0 ? Math.floor(idx / pageSize) + 1 : Math.min(page, view.pageCount));
      return;
    }
    setPage((p) => Math.min(p, view.pageCount)); // 删当前页末条自动回退
  }, [view, pageSize, page]);

  /** 当前页条目（view 变化后切片）。 */
  const pageItems = useMemo(() => {
    if (view === null) return [];
    return view.sorted.slice((page - 1) * pageSize, page * pageSize);
  }, [view, page, pageSize]);

  /** 多状态统计（零值档隐藏的判据）。 */
  const stats = useMemo(() => {
    if (entries === null) return null;
    return {
      total: entries.length,
      faded: entries.filter((e) => e.faded === true).length,
      pinned: entries.filter((e) => e.pinned === true).length,
    };
  }, [entries]);

  const available = memoryState?.available === true;

  const openAdd = (): void => {
    setAddErr(null);
    // 重开弹窗：清上一条新增的在途展示态（不卡第二次写入；行级在途不动，
    // 回执照常刷新列表）
    if (vectorizingRef.current === "new") markVectorizing(null);
    setAdding({ text: "", kind: "fact", domain: "general", project: "" });
    window.setTimeout(() => addInputRef.current?.focus(), 60);
  };

  const submitAdd = (): void => {
    if (adding === null) return;
    if (adding.text.trim() === "") {
      setAddErr(t("steward.memory.emptyTextErr"));
      return;
    }
    // domain=project 配对项目名显式通道；空名回落 daemon 侧一致性约束兜底
    const project = adding.domain === "project" && adding.project.trim() !== "" ? adding.project.trim() : undefined;
    if (sendStewardMemoryAppend(adding.text, adding.kind, adding.domain, project) === false) return; // 未连接：保留弹窗可重试
    setWriteError(null); // 新写面动作清上次失败交代
    markVectorizing("new");
    setAdding(null);
  };

  const saveEdit = (): void => {
    if (editing === null || editing.text.trim() === "") return;
    if (sendStewardMemoryUpdate(editing.id, editing.text) === false) return;
    notePageAnchor(pageItems);
    setWriteError(null);
    markVectorizing(editing.id);
    setEditing(null);
  };

  const onDelete = (id: number): void => {
    confirmDelete(String(id), () => {
      notePageAnchor(pageItems);
      setWriteError(null);
      sendStewardMemoryDelete(id);
    });
  };

  const onPin = (id: number, pinned: boolean): void => {
    notePageAnchor(pageItems);
    setWriteError(null);
    sendStewardMemoryPin(id, pinned);
  };

  const onRestore = (id: number): void => {
    notePageAnchor(pageItems);
    setWriteError(null);
    sendStewardMemoryRestore(id);
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

  /** 页码条（总页数 ≤1 隐藏；>7 页中段折叠）。 */
  const pageButtons = useMemo(() => {
    if (view === null || view.pageCount <= 1) return null;
    const count = view.pageCount;
    const pages: (number | "…")[] = [];
    for (let i = 1; i <= count; i++) {
      if (count <= PAGE_ELLIPSIS_LIMIT || i === 1 || i === count || Math.abs(i - page) <= 1) {
        pages.push(i);
      } else if (pages[pages.length - 1] !== "…") {
        pages.push("…");
      }
    }
    return (
      <div className="memory-pager" data-memory-pager>
        <button
          className="hud-btn hud-btn-ghost sm"
          type="button"
          data-memory-page-prev
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          <ChevronLeft size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        {pages.map((p, i) =>
          p === "…" ? (
            <span key={`e${i}`} className="memory-page-ellipsis" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={p}
              className={cn("hud-btn sm", p === page ? "hud-btn-cyan" : "hud-btn-ghost")}
              type="button"
              data-memory-page-btn={p}
              onClick={() => setPage(p)}
            >
              {p}
            </button>
          ),
        )}
        <button
          className="hud-btn hud-btn-ghost sm"
          type="button"
          data-memory-page-next
          disabled={page >= count}
          onClick={() => setPage((p) => Math.min(count, p + 1))}
        >
          <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <span className="memory-page-range" data-memory-page-range>
          {t("steward.memory.pageRange", {
            from: (page - 1) * pageSize + 1,
            to: Math.min(page * pageSize, view.sorted.length),
            total: view.sorted.length,
          })}
        </span>
        <span className="memory-page-size">
          {t("steward.memory.pageSizeLabel")}
          <select
            className="hud-input sm"
            data-memory-page-size
            value={pageSize}
            onChange={(e) => {
              const next = Number(e.target.value);
              window.localStorage.setItem(PAGE_SIZE_KEY, String(next));
              setPageSize(next);
            }}
          >
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </span>
      </div>
    );
  }, [view, page, pageSize, t]);

  return (
    <div data-steward-memory-page={path}>
      <AppLayout headerLeft={<h1 className="tb-title">{t("steward.memory.pageTitle")}</h1>}>
        <div className="pg" data-memory-page-body>
          {/* 头部：搜索 + 排序 + 筛选 + 统计 + 端点徽标 + 新增入口 */}
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
              <div className="sel-wrap">
                <select
                  className="hud-input"
                  data-memory-sort
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as SortKey)}
                >
                  <option value="updated">{t("steward.memory.sortUpdated")}</option>
                  <option value="created">{t("steward.memory.sortCreated")}</option>
                  <option value="recalled">{t("steward.memory.sortRecalled")}</option>
                </select>
              </div>
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
            <div className="toolbar-row" data-memory-filters>
              {/* kind × domain 双维筛选（独立交叉组合；与生命周期档叠加） */}
              {KIND_FILTERS.map((k) => (
                <button
                  key={k}
                  className={cn("hud-btn sm", kindFilter === k ? "hud-btn-cyan" : "hud-btn-ghost")}
                  type="button"
                  data-memory-kind-filter={k}
                  onClick={() => setKindFilter(k)}
                >
                  {k === "all" ? t("steward.memory.filterKindAll") : t(`chat.settings.general.memoryKind.${k}`)}
                </button>
              ))}
              <span className="memory-filter-sep" aria-hidden="true" />
              {DOMAIN_FILTERS.map((d) => (
                <button
                  key={d}
                  className={cn("hud-btn sm", domainFilter === d ? "hud-btn-cyan" : "hud-btn-ghost")}
                  type="button"
                  data-memory-domain-filter={d}
                  onClick={() => setDomainFilter(d)}
                >
                  {d === "all" ? t("steward.memory.filterDomainAll") : t(`steward.memory.domain.${d}`)}
                </button>
              ))}
              <span className="memory-filter-sep" aria-hidden="true" />
              {(["all", "active", "faded", "pinned"] as const)
                .filter((f) => {
                  if (stats === null) return f === "all";
                  if (f === "faded") return stats.faded > 0;
                  if (f === "pinned") return stats.pinned > 0;
                  return true;
                })
                .map((f) => (
                  <button
                    key={f}
                    className={cn("hud-btn sm", filter === f ? "hud-btn-cyan" : "hud-btn-ghost")}
                    type="button"
                    data-memory-filter={f}
                    onClick={() => setFilter(f)}
                  >
                    {f === "all"
                      ? t("steward.memory.filterAll")
                      : f === "active"
                        ? t("steward.memory.filterActive")
                        : f === "faded"
                          ? t("steward.memory.filterFaded")
                          : t("steward.memory.filterPinned")}
                  </button>
                ))}
              {memoryState !== null && (
                <span className="ag-note" data-memory-stats>
                  {t("steward.memory.stats", { count: memoryState.entryCount, dim: memoryState.dim ?? 0 })}
                  {stats !== null && stats.faded > 0 && ` · ${t("steward.memory.statsFaded", { count: stats.faded })}`}
                  {stats !== null && stats.pinned > 0 && ` · ${t("steward.memory.statsPinned", { count: stats.pinned })}`}
                </span>
              )}
            </div>
            {!available && <span className="ag-note" data-memory-unavailable>{t("steward.memory.unavailable")}</span>}
          </div>

          {/* 写面失败交代（族B/TR-272：steward.memory_* 写命令无结果帧——行内
              交代原因，下次写动作/回执成功清） */}
          {writeError !== null && (
            <p className="ag-note mcp-err" data-memory-write-error role="alert">
              {writeError}
            </p>
          )}

          {/* 列表：两行卡片（行1 text + pin + kind；行2 meta + 动作） */}
          {entries !== null && view !== null && view.sorted.length === 0 && (
            <p className="ag-note" data-memory-list-empty>
              {t("steward.memory.empty")}
            </p>
          )}
          {entries === null && (
            <div className="memory-list" data-memory-list-loading aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="memory-item memory-skeleton" />
              ))}
            </div>
          )}
          <div className="memory-list" data-memory-list>
            {pageItems.map((entry) => {
              const isEditing = editing?.id === entry.id;
              const isVectorizing = vectorizing === entry.id;
              const faded = entry.faded === true;
              const pinned = entry.pinned === true;
              const recalled = entry.recallCount ?? 0;
              return (
                <div
                  key={entry.id}
                  className={cn("memory-item", faded && "memory-item-faded")}
                  data-memory-item={entry.id}
                  data-faded={faded ? "1" : undefined}
                >
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
                      <div className="memory-main">
                        <span className="memory-text" data-memory-item-text={entry.id}>
                          {entry.text}
                        </span>
                        <span className="memory-flags">
                          {faded && (
                            <span className="hud-chip memory-chip-faded" data-memory-item-faded={entry.id}>
                              {t("steward.memory.fadedChip")}
                            </span>
                          )}
                          {pinned && (
                            <span className="hud-chip memory-chip-pinned" data-memory-item-pinnedchip={entry.id}>
                              {t("steward.memory.pinnedChip")}
                            </span>
                          )}
                          <span className="hud-chip" data-memory-item-kind={entry.id}>
                            {t(`chat.settings.general.memoryKind.${entry.kind}`)}
                          </span>
                          {entry.domain !== undefined && (
                            <span className="hud-chip memory-chip-domain" data-memory-item-domain={entry.id}>
                              {t(`steward.memory.domain.${entry.domain}`)}
                            </span>
                          )}
                          <button
                            className={cn("hud-btn sm memory-pin-btn", pinned && "is-pinned")}
                            type="button"
                            data-memory-pin-btn={entry.id}
                            title={pinned ? t("steward.memory.unpinAction") : t("steward.memory.pinAction")}
                            onClick={() => onPin(entry.id, !pinned)}
                          >
                            {pinned ? (
                              <PinOff size={13} strokeWidth={1.75} aria-hidden="true" />
                            ) : (
                              <Pin size={13} strokeWidth={1.75} aria-hidden="true" />
                            )}
                          </button>
                        </span>
                      </div>
                      <div className="memory-sub">
                        <span className="memory-meta" data-memory-item-meta={entry.id}>
                          {timeLabel(entry.createdAt, t)} · {sourceLabel(entry.sourceTurn, t)}
                          {recalled > 0 && (
                            <>
                              {" · "}
                              {t("steward.memory.recalledTimes", { n: recalled })}
                              {(entry.lastRecalledAt ?? 0) > 0 &&
                                ` · ${t("steward.memory.lastRecalled", { span: timeLabel(entry.lastRecalledAt!, t) })}`}
                            </>
                          )}
                          {recalled === 0 && faded && ` · ${t("steward.memory.recalledNever")}`}
                        </span>
                        <div className="memory-actions">
                          {faded && (
                            <button
                              className="hud-btn hud-btn-ghost sm"
                              type="button"
                              data-memory-restore-btn={entry.id}
                              onClick={() => onRestore(entry.id)}
                            >
                              <RotateCcw size={13} strokeWidth={1.75} aria-hidden="true" />
                              {t("steward.memory.restoreAction")}
                            </button>
                          )}
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
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {pageButtons}

          {/* 新增弹窗（text + kind + domain 打标（project 配对项目名）→ steward.memory_append） */}
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
                  <label className="hud-label" htmlFor="memory-add-domain">
                    {t("steward.memory.domainLabel")}
                  </label>
                  <div className="sel-wrap">
                    <select
                      className="hud-input"
                      id="memory-add-domain"
                      value={adding.domain}
                      data-memory-add-domain
                      onChange={(e) => setAdding({ ...adding, domain: e.target.value as StewardMemoryDomain })}
                    >
                      {DOMAIN_VALUES.map((d) => (
                        <option key={d} value={d}>
                          {t(`steward.memory.domain.${d}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                  {adding.domain === "project" && (
                    <>
                      <label className="hud-label" htmlFor="memory-add-project">
                        {t("steward.memory.projectLabel")}
                      </label>
                      <input
                        className="hud-input"
                        id="memory-add-project"
                        type="text"
                        value={adding.project}
                        placeholder={t("steward.memory.projectPlaceholder")}
                        data-memory-add-project
                        onChange={(e) => setAdding({ ...adding, project: e.target.value })}
                      />
                    </>
                  )}
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
