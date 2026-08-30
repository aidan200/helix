/**
 * P-1 kg-viewer 页面私有状态机（graph 态 = F5.1~F5.5；V-3 单页 master-detail
 * 的主区 graph 分量，组件非路由）。
 *
 * 状态模型（review.md「graph 态内部」）：
 * - 主状态互斥：loading（列表/详情骨架）| empty（搜索无匹配）| success；
 *   进入 graph 即新数据面（按项目重初始化：过滤/选中/报告决定/索引面板态
 *   全清空——由 kg-viewer remount 保证，本 reducer 只持单项目生命周期）；
 * - 报告子状态：待决 → 已处理（单选行动项触发，可撤销）；tab 计数联动；
 *   全部处理 → 清零横幅（仍属 success 态）；
 * - 索引子状态：面板四态中后三态（building/synced/degraded；absent 在主区
 *   呈现）——按项目状态起步，重建走 degraded→building→synced 转换。
 *
 * 过滤策略：kg.list 一次性拉全量（三路过滤参数可叠加，本页选客户端过滤
 * ——原型同型即时交互，69 节点量级无分页诉求；命令契约不因此收窄）。
 */
import type {
  KgChangeReportDto,
  KgIndexStatusDto,
  KgNodeDetailDto,
  KgNodeListRow,
  KgProjectState,
} from "@helix/protocol";

/** F5.1 三路过滤（关键词 × 类型 × 状态；'all' = 不过滤）。 */
export interface KgFilter {
  q: string;
  kind: "all" | "rule" | "entity";
  status: "all" | "confirmed" | "draft" | "superseded";
}

export type KgPaneView = "loading" | "empty" | "success";
/** 右区 tab：节点详情 / 变化报告 / 产出呈现（T3.2 kg-bootstrap 批新增第三 tab）。 */
export type KgTab = "detail" | "report" | "produce";

export interface KgViewState {
  /** 全量节点行（kg.list 无过滤回执；过滤在派生层）。 */
  all: KgNodeListRow[];
  /** 项目内全部节点数（计数行 N）。 */
  total: number;
  view: KgPaneView;
  filter: KgFilter;
  /** 选中节点 id（仅 data-id 属性承载，不作可见文本——AD-16）。 */
  sel: string | null;
  detail: KgNodeDetailDto | null;
  detailLoading: boolean;
  tab: KgTab;
  report: KgChangeReportDto | null;
  /** 报告行动项决定（条目 index → 选中选项；仅前端标记，转正除外）。 */
  resolved: Record<number, string>;
  /** 索引面板状态（kg.index.status 回执；null = 读取中）。 */
  idx: KgIndexStatusDto | null;
  /** 面板重建进行中（轮询中）。 */
  idxRebuilding: boolean;
}

export function createKgViewState(): KgViewState {
  return {
    all: [],
    total: 0,
    view: "loading",
    filter: { q: "", kind: "all", status: "all" },
    sel: null,
    detail: null,
    detailLoading: false,
    tab: "detail",
    report: null,
    resolved: {},
    idx: null,
    idxRebuilding: false,
  };
}

export type KgAction =
  | { type: "list-result"; total: number; nodes: KgNodeListRow[]; initialSel?: string }
  | { type: "filter-q"; q: string }
  | { type: "filter-kind"; kind: KgFilter["kind"] }
  | { type: "filter-status"; status: KgFilter["status"] }
  | { type: "clear-filter" }
  | { type: "select-node"; id: string }
  | { type: "detail-loading"; id: string }
  | { type: "detail-result"; detail: KgNodeDetailDto }
  | { type: "tab"; tab: KgTab }
  | { type: "report-result"; report: KgChangeReportDto }
  | { type: "resolve"; index: number; value: string }
  | { type: "unresolve"; index: number }
  | { type: "idx-result"; idx: KgIndexStatusDto }
  | { type: "idx-rebuild-started" }
  | { type: "confirm-applied"; id: string; status: KgNodeListRow["status"] };

/** F5.1 客户端三路过滤（关键词匹配 name/digest；大小写不敏感）。 */
export function filterRows(all: readonly KgNodeListRow[], filter: KgFilter): KgNodeListRow[] {
  return all.filter((n) => {
    if (filter.kind !== "all" && n.kind !== filter.kind) return false;
    if (filter.status !== "all" && n.status !== filter.status) return false;
    if (filter.q !== "") {
      const q = filter.q.toLowerCase();
      if (!n.name.toLowerCase().includes(q) && !n.digest.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

/** 主状态派生：全量空 or 过滤无匹配 → empty。 */
export function viewOf(all: readonly KgNodeListRow[], matched: number): KgPaneView {
  if (all.length === 0) return "loading"; // 数据未到（kg.list 在途）
  return matched === 0 ? "empty" : "success";
}

/** 报告待决计数（tab 徽章联动）。 */
export function pendingCount(report: KgChangeReportDto | null, resolved: Record<number, string>): number {
  if (report === null) return 0;
  return report.entries.length - Object.keys(resolved).length;
}

/** 索引面板起步态（graph 态仅呈现后三态；absent 归主区）。 */
export function panelStateOf(state: KgProjectState): "building" | "synced" | "degraded" {
  return state === "building" ? "building" : state === "degraded" ? "degraded" : "synced";
}

export function kgReducer(state: KgViewState, action: KgAction): KgViewState {
  switch (action.type) {
    case "list-result": {
      // 过滤变化或重入先清旧渲染（转换干净）；initialSel 仅首载生效
      // （sel 已有时 list 刷新保持当前选中，不重置详情）
      const next: KgViewState = {
        ...state,
        all: action.nodes,
        total: action.total,
        view: action.nodes.length === 0 ? "empty" : "success",
      };
      if (state.sel === null && action.initialSel !== undefined && action.initialSel !== "") {
        next.sel = action.initialSel;
        next.detailLoading = true;
        next.detail = null;
      }
      return next;
    }
    case "filter-q":
      return { ...state, filter: { ...state.filter, q: action.q } };
    case "filter-kind":
      return { ...state, filter: { ...state.filter, kind: action.kind } };
    case "filter-status":
      return { ...state, filter: { ...state.filter, status: action.status } };
    case "clear-filter":
      return { ...state, filter: { q: "", kind: "all", status: "all" } };
    case "select-node": {
      // 选中即跳详情（FID-09/10/13「引用可跳转」：report 态下行/引用点击
      // 也要切回 detail）；同节点且已在详情 = 无操作，不重拉
      if (state.sel === action.id) {
        return state.tab === "detail" ? state : { ...state, tab: "detail" };
      }
      return { ...state, sel: action.id, tab: "detail", detail: null, detailLoading: true };
    }
    case "detail-loading":
      // kg-viewer 发出 kg.node.detail（select-node 后置骨架）
      return { ...state, sel: action.id, detail: null, detailLoading: true };
    case "detail-result":
      if (state.sel !== action.detail.id) return state; // 迟到结果丢弃
      return { ...state, detail: action.detail, detailLoading: false };
    case "tab":
      return { ...state, tab: action.tab };
    case "report-result":
      return { ...state, report: action.report };
    case "resolve":
      return { ...state, resolved: { ...state.resolved, [action.index]: action.value } };
    case "unresolve": {
      const resolved = { ...state.resolved };
      delete resolved[action.index];
      return { ...state, resolved };
    }
    case "idx-result": {
      const done = action.idx.state !== "building";
      return { ...state, idx: action.idx, idxRebuilding: done ? false : state.idxRebuilding };
    }
    case "idx-rebuild-started":
      return { ...state, idxRebuilding: true, idx: { state: "building" } };
    case "confirm-applied": {
      // 转正回执：列表行状态翻转；详情由重发 kg.node.detail 刷新（daemon 落 log）
      const all = state.all.map((n) => (n.id === action.id ? { ...n, status: action.status } : n));
      const detail =
        state.detail !== null && state.detail.id === action.id
          ? { ...state.detail, status: action.status }
          : state.detail;
      return { ...state, all, detail, detailLoading: state.sel === action.id };
    }
    default:
      return state;
  }
}
