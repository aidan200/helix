/**
 * P-1 事件流表格 + 分页脚（F5.3 / F5.5）。
 *
 * F5.3：混排视图四列（时间/实例/类型/摘要），实例详情视图三列（实例列
 * 省略）；行点击展开 payload JSON（格式化 + 复制按钮，复制降级 = toast
 * 反馈）；手风琴单开（openId 单值 + aria-expanded 同步）；实例分对着色
 * （主 accent / Sub violet 徽标，面板与表格一致）；engine.error 行 error
 * 色系（err-row + p1-tt-engineerr）。
 * F5.5：底部加载更多（beforeId 游标步进在 TracePage）；加载完收口
 * 「已加载全部」禁用；footer 计数（已加载 loaded / total · 每页 size）。
 */
import { ChevronRight } from "lucide-react";
import type { TraceEventRow, TraceInstanceRecord } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { useToast } from "@/shared/ui/Toast";
import { cn } from "@/shared/lib/cn";
import {
  TRACE_PAGE_SIZE,
  categoryOfType,
  instanceDisplayName,
  summarizeTraceEvent,
  type TraceCategoryKey,
} from "../model/trace-model";
import { fmtTimeMs } from "./format";

/** 类型徽标类目类（原型 TT_CLASS 映射的 p1- 前缀版）。 */
const TT_CLASS: Record<TraceCategoryKey, string> = {
  message: "p1-tt-message",
  tool: "p1-tt-tool",
  thinking: "p1-tt-thinking",
  usage: "p1-tt-usage",
  lifecycle: "p1-tt-lifecycle",
  "engine.error": "p1-tt-engineerr",
  compaction: "p1-tt-usage",
  model: "p1-tt-lifecycle",
};

export interface EventTableProps {
  /** success 态的事件行（id 降序）。 */
  events: readonly TraceEventRow[];
  instances: readonly TraceInstanceRecord[];
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  /** success 视图（true = 渲染行 + 分页脚；false = 仅表头，状态面由页面侧渲染）。 */
  success: boolean;
  /** 手风琴单开（事件 id；null = 全收）。 */
  openId: number | null;
  /** true = 实例详情三列视图（实例列省略）。 */
  detail: boolean;
  mainName: string;
  onToggleRow: (id: number) => void;
  onLoadMore: () => void;
}

const EventTable = function EventTable({
  events,
  instances,
  total,
  hasMore,
  loadingMore,
  success,
  openId,
  detail,
  mainName,
  onToggleRow,
  onLoadMore,
}: EventTableProps) {
  const { t } = useI18n();
  const toast = useToast();
  const instById = new Map(instances.map((r) => [r.instanceId, r]));

  const onCopy = (row: TraceEventRow) => {
    const text = JSON.stringify(row.payload, null, 2);
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (clipboard === undefined) {
      // 复制降级口径（review.md F5.3）：无 clipboard 时 toast 反馈，不静默
      toast.push("err", t("trace.table.copyFailed"));
      return;
    }
    clipboard.writeText(text).then(
      () => toast.push("ok", t("trace.table.copied", { id: row.id })),
      () => toast.push("err", t("trace.table.copyFailed")),
    );
  };

  return (
    <>
      <div className={cn("p1-thead p1-grid-cols", detail && "detail")}>
        <span />
        <span>{t("trace.table.time")}</span>
        {!detail && <span>{t("trace.table.instance")}</span>}
        <span className="p1-type">{t("trace.table.type")}</span>
        <span className="p1-sumcell">
          <span>{t("trace.table.summary")}</span>
          <span className="hit">{success ? t("trace.table.hit", { n: total }) : ""}</span>
        </span>
      </div>

      {success && (
      <div className="p1-tbody">
        {events.map((row) => {
          const open = openId === row.id;
          const isErr = row.type === "engine.error";
          const rec = instById.get(row.instanceId);
          const isMain = rec === undefined ? row.agentKind === "main" : rec.agentKind === "main";
          const instName =
            rec !== undefined ? instanceDisplayName(rec, mainName) : row.instanceId;
          return (
            <div key={row.id} className={cn("p1-entry", open && "open", isErr && "err-row")}>
              <button
                type="button"
                className={cn("p1-row p1-grid-cols", detail && "detail")}
                aria-expanded={open}
                aria-label={`${fmtTimeMs(row.ts)} ${row.type} ${summarizeTraceEvent(row)}`}
                onClick={() => onToggleRow(row.id)}
              >
                <span className="p1-chev" aria-hidden="true">
                  <ChevronRight size={12} strokeWidth={2} />
                </span>
                <span className="p1-time">{fmtTimeMs(row.ts)}</span>
                {!detail && (
                  <span className="p1-inst">
                    <span className={cn("inst-badge", isMain ? "main" : "sub")}>
                      <span className="hud-dot" aria-hidden="true" />
                      {instName}
                    </span>
                    <span className="inst-id">{row.instanceId}</span>
                  </span>
                )}
                <span className="p1-type">
                  <span className={cn("p1-tt", TT_CLASS[categoryOfType(row.type)])}>
                    {row.type}
                  </span>
                </span>
                <span className="p1-summary">
                  {isErr ? (
                    <span className="err-text">{summarizeTraceEvent(row)}</span>
                  ) : (
                    summarizeTraceEvent(row)
                  )}
                </span>
              </button>
              {open && (
                <div className="p1-payload">
                  <div className="p1-payload-head">
                    <span>{t("trace.table.payloadHead", { id: row.id, type: row.type })}</span>
                    <button
                      type="button"
                      className="hud-btn hud-btn-ghost sm"
                      onClick={() => onCopy(row)}
                    >
                      {t("trace.table.copyJson")}
                    </button>
                  </div>
                  <pre className="hud-code">{JSON.stringify(row.payload, null, 2)}</pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
      )}

      {success && (
      <div className="p1-foot">
        <span className="meta">
          {t("trace.paging.meta", {
            loaded: events.length,
            total,
            size: TRACE_PAGE_SIZE,
          })}
        </span>
        <button
          type="button"
          className="hud-btn hud-btn-ghost"
          disabled={!hasMore || loadingMore}
          onClick={onLoadMore}
        >
          {hasMore ? t("trace.paging.more") : t("trace.paging.allLoaded")}
        </button>
      </div>
      )}
    </>
  );
};

export default EventTable;
