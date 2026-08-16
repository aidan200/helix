/**
 * P-1s 「加载更早的消息」分页胶囊（F(1.2).3 / AD-1；CL-1）：顶部居中胶囊
 * 「加载更早的消息 · 已载 N / M」→ 点击进入 loading（3 行骨架）→ 结果前插
 * + 计数更新；hasMore=false 后禁用（paged 曾真才渲染——从未有更早历史的
 * 会话不出胶囊）。
 */
import { useI18n } from "@/shared/i18n";

export interface LoadEarlierProps {
  /** 曾有更早历史可载（快照 tailStartCursor 携带或已分页过） */
  paged: boolean;
  hasMore: boolean;
  loading: boolean;
  /** 已载条数（当前主时间轴 entries 数） */
  loaded: number;
  /** 全量计数（快照 totalEntries；null = 未携带则不显示计数段） */
  total: number | null;
  onLoad: () => void;
}

const LoadEarlier = function LoadEarlier({ paged, hasMore, loading, loaded, total, onLoad }: LoadEarlierProps) {
  const { t } = useI18n();
  if (!paged) return null;
  return (
    <div className="load-earlier-wrap" data-load-earlier>
      <button
        className="load-earlier"
        type="button"
        disabled={!hasMore || loading}
        data-state={!hasMore ? "exhausted" : loading ? "loading" : "more"}
        onClick={onLoad}
      >
        {total !== null
          ? `${t("chat.paging.loadEarlier")} · ${t("chat.paging.loadedCount", { n: loaded, m: total })}`
          : t("chat.paging.loadEarlier")}
      </button>
      {loading && (
        <div className="hist-loading" aria-hidden="true">
          <div className="skel" style={{ width: "40%" }} />
          <div className="skel" style={{ width: "68%" }} />
          <div className="skel" style={{ width: "52%" }} />
        </div>
      )}
    </div>
  );
};

export default LoadEarlier;
