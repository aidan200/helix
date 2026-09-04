/**
 * P-1 候选台账查看面板（台账读面三件套之三，kg.candidates.list 数据面）：
 * 列表（id/title/status/created_at）+ status 过滤 + 选中行展开 body 详情。
 *
 * **只读零裁决**（用户裁决：本轮只做「查看」——无裁决按钮、无台账→知识
 * 落地联动，台账自闭环）；命令发送/回执消费归 KgViewer 常驻 listener
 * （KgHealthPane 同构），本组件纯展示 + 回调。kg-health-pane 四态计数徽章
 * 可点击设过滤（面板与徽章过滤态联动——同一 filter 状态源在 KgViewer）。
 *
 * AD-16：候选 id（CAND-n）与 targetNode（TR-n/E-n）仅在 data-* 属性与
 * 详情段承载定位语义；列表行主展示 = title + 状态徽章 + 提出时间。
 */
import type { KgCandidateRowDto } from "@helix/protocol";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** 台账过滤态（四态 + all；与 kg-health-pane 徽章点击联动共享）。 */
export type CandFilter = "all" | "pending" | "deferred" | "applied" | "discarded";

/** 状态 → 徽章文案键（与体检面板四态计数共用词条）。 */
const STATUS_KEY = {
  pending: "pj.health.candPending",
  deferred: "pj.health.candDeferred",
  applied: "pj.health.candApplied",
  discarded: "pj.health.candDiscarded",
} as const;

export default function KgCandidatesPanel({
  loading,
  rows,
  total,
  filter,
  sel,
  t,
  onFilter,
  onSelect,
}: {
  /** 拉取进行中（骨架文案）。 */
  loading: boolean;
  rows: readonly KgCandidateRowDto[];
  /** 过滤后全集计数（回执 total——分页不改变，本面板全量拉取）。 */
  total: number;
  filter: CandFilter;
  /** 选中展开详情的候选 id（null = 无展开）。 */
  sel: string | null;
  t: T;
  onFilter: (filter: CandFilter) => void;
  onSelect: (id: string) => void;
}) {
  const filters: readonly CandFilter[] = ["all", "pending", "deferred", "applied", "discarded"];
  return (
    <section className="kg-health-sec kg-cand-panel" data-kg-cand-panel>
      <div className="kg-health-sec-head">
        <span className="kg-health-sec-title">{t("pj.cand.panelTitle")}</span>
        <span className="hud-badge">{loading ? t("pj.cand.loading") : t("pj.cand.countLine", { total })}</span>
      </div>
      <div className="kg-seg" data-kg-cand-seg>
        {filters.map((v) => (
          <button
            key={v}
            type="button"
            className={filter === v ? "active" : ""}
            data-cand-filter={v}
            onClick={() => onFilter(v)}
          >
            {v === "all" ? t("pj.cand.filterAll") : t(STATUS_KEY[v])}
          </button>
        ))}
      </div>
      {loading ? (
        <div className="kgv-empty" data-kg-cand="loading">
          <div className="kgv-empty-t">{t("pj.cand.loading")}</div>
        </div>
      ) : rows.length === 0 ? (
        <div className="kgv-empty" data-kg-cand="empty">
          <div className="kgv-empty-t">{t("pj.cand.empty")}</div>
        </div>
      ) : (
        <ul className="kg-cand-list" data-kg-cand-list>
          {rows.map((row) => {
            const open = sel === row.id;
            return (
              <li
                key={row.id}
                className={`kg-cand-item${open ? " open" : ""}`}
                data-cand-id={row.id}
                data-status={row.status}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(row.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onSelect(row.id);
                }}
              >
                <div className="kg-cand-item-main">
                  <span className="kg-cand-title">{row.title}</span>
                  <span className={`kg-cand-badge st-${row.status}`}>{t(STATUS_KEY[row.status])}</span>
                  {row.status === "deferred" && row.deferAge > 0 && (
                    <span className="kg-cand-defer">{t("pj.cand.deferAge", { n: row.deferAge })}</span>
                  )}
                </div>
                <div className="kg-cand-item-meta">{t("pj.cand.createdAt", { at: row.createdAt })}</div>
                {open && (
                  <div className="kg-cand-detail" data-cand-detail>
                    {row.targetNode !== null && <div className="kg-cand-target">{t("pj.cand.target", { node: row.targetNode })}</div>}
                    {row.body !== "" && (
                      <>
                        <div className="kg-cand-body-title">{t("pj.cand.bodyTitle")}</div>
                        <pre className="kg-cand-body">{row.body}</pre>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
