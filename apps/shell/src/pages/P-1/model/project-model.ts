/**
 * P-1 ProjectPage 页面私有状态机（F5.0；V-3 单页 master-detail）。
 *
 * 两个正交子模型（review.md「状态模型」）：
 * - 左栏折叠态：expanded（两段列表）/ collapsed（36px 窄轨）——仅形态切换，
 *   不触碰主区；选中自动折叠、☰ 展开、点当前已选中行仅折叠不重置；
 * - 主区四态状态机：empty / absent / building / graph 互斥，切项目先清旧态
 *   再进新态（kgToken 递增 = kg-viewer 重初始化，防旧图谱残影）。
 *
 * AG-15：连接私有读面页面 reducer，不进 session store（TracePage 先例）。
 * 数据源 = kg.projects / kg.index.status 六命令族（契约
 * contracts/kg-viewer-api.md）；行级四态（absent/building/synced/degraded）
 * 由 kg.projects 回执与轮询回执共同维护。
 */
import type { KgIndexStatusDto, KgProjectRow, KgProjectState } from "@helix/protocol";

/** 主区四态（互斥；absent=未建索引+构建 CTA，B1 冷启动入口在主区）。 */
export type MainMode = "empty" | "absent" | "building" | "graph";

// ── bootstrap 扩面（T3.2，CL-1 F1.1 + CL-4 F4.1~F4.3）──

/**
 * bootstrap 入口五态（互斥，review.md P-1 状态模型）：hidden=已有图谱静默
 * 不渲染 / guide=absent 引导态 / building=构建中 / ready=可发起 /
 * launched=已启动（ok-strip）/ running=任务运行中（P0① 双启动防护：
 * bootstrapRunning=true 优先于其他条件——窗口期入口不再现启动钮）。前四
 * 态由项目行机械派生（bootstrapEntryMode），launched 为会话内启动标记叠加。
 */
export type BootstrapEntryMode = "hidden" | "guide" | "building" | "ready" | "launched" | "running";

/** bootstrap 入口区会话内状态（启动标记；切项目复位）。 */
export interface BootstrapAreaState {
  /** kg.bootstrap.create 成功后置位（隐藏启动钮 + 出 ok-strip）。 */
  launched: boolean;
}

/**
 * 准入四态判定纯函数（CL-1 F1.1 机械定义，contracts/kg-bootstrap-api.md §1）：
 * 显示 bootstrap 入口 ⟺ indexStatus ∈ {synced, degraded} 且 nodeCount === 0
 *（nodeCount 缺省 = 未知 = 视为非空不显示）；absent → 引导态；building →
 * 构建中；已有图谱 → 静默。launched 仅叠加在 ready 上（不改变其余态）。
 * P0①：bootstrapRunning=true（kg.projects 行，非终态 kg-bootstrap job
 * 覆盖该项目）优先于其他条件 → running（含 launched 位——任务确在跑，
 * 入口只留观察出口；缺省/undefined = 旧 daemon 兼容 = 无任务在跑）。
 */
export function bootstrapEntryMode(
  row: { status: KgProjectState; nodeCount?: number; bootstrapRunning?: boolean },
  launched: boolean,
): BootstrapEntryMode {
  if (row.bootstrapRunning === true) return "running";
  if (row.status === "absent") return "guide";
  if (row.status === "building") return "building";
  if (row.nodeCount !== 0) return "hidden"; // >0 或缺省（未知）均不显示
  return launched ? "launched" : "ready";
}

export interface ProjectPageState {
  /** kg.projects 回执（左栏两段的项目段数据源）。 */
  projects: KgProjectRow[];
  /** 项目清单加载中（首拉骨架）。 */
  listLoading: boolean;
  /** 选中项目名（null = 未选，主区 empty）。 */
  selected: string | null;
  /** 左栏折叠（选中自动折叠；☰ 展开；不影响主区与选中）。 */
  domainCollapsed: boolean;
  /** 主区四态。 */
  mainMode: MainMode;
  /** building 态进度（O-6 轮询回执；absent/graph 态为 null）。 */
  buildProgress: { done: number; total: number } | null;
  /** graph 态重初始化令牌（切项目递增；kg-viewer remount key，防跨项目残影）。 */
  kgToken: number;
  /** bootstrap 入口区（T3.2：会话内启动标记；切项目/workspace 复位）。 */
  bootstrap: BootstrapAreaState;
}

export function createProjectPageState(): ProjectPageState {
  return {
    projects: [],
    listLoading: true,
    selected: null,
    domainCollapsed: false,
    mainMode: "empty",
    buildProgress: null,
    kgToken: 0,
    bootstrap: { launched: false },
  };
}

export type ProjectAction =
  | { type: "list-loading" }
  | { type: "list-result"; projects: KgProjectRow[] }
  /** workspace_changed（W4 刷新链）：项目域整体复位到首拉态（选中/主区/kgToken
   *  随新工作空间作废——旧选中在新域可能不存在，残影零泄漏）；重拉由页面
   *  effect 接手（sendKgProjects）。 */
  | { type: "workspace-reset" }
  /** 点项目行：同项目仅折叠（主区不重置）；异项目先清旧态再按行状态进新态。 */
  | { type: "select-project"; name: string }
  /** ☰ 展开：恢复两段列表（含最新行状态重渲染）。 */
  | { type: "expand-domain" }
  /** absent 主区「构建索引」CTA：absent→building（乐观置行徽章同步翻）。 */
  | { type: "build-started"; name: string }
  /** kg.index.status 回执（轮询或触发）：更新行状态；选中 building 项目完成→graph。 */
  | { type: "index-status"; name: string; status: KgIndexStatusDto }
  // ── bootstrap 扩面（T3.2）──
  /** kg.bootstrap.create 成功：置已启动（隐藏启动钮 + ok-strip）。 */
  | { type: "bootstrap-launched" };

/** 项目行状态 → 主区态映射（synced|degraded→graph；building→building；absent→absent）。 */
function modeOfStatus(status: KgProjectRow["status"]): Exclude<MainMode, "empty"> {
  if (status === "synced" || status === "degraded") return "graph";
  if (status === "building") return "building";
  return "absent";
}

/** 用 IndexStatus 回执补全项目行（保留 nodeCount 等行内既有信息）。 */
function patchProject(p: KgProjectRow, status: KgIndexStatusDto): KgProjectRow {
  return {
    ...p,
    status: status.state,
    symbolCount: status.state === "synced" ? (status.symbolCount ?? p.symbolCount) : undefined,
    // nodeCount 在 synced 与 degraded 两态均保留（契约 §1 准入覆盖两态；
    // absent 起步的项目建后无历史行值——?? 0 落空知识层口径，缺省会致
    // degraded 永不可发起）；building/absent 无意义置 undefined。
    nodeCount: status.state === "synced" || status.state === "degraded" ? (p.nodeCount ?? 0) : undefined,
    syncedAt: status.state === "synced" ? (status.syncedAt ?? p.syncedAt) : undefined,
    degradedNote: status.state === "degraded" ? (status.degradedNote ?? p.degradedNote) : undefined,
  };
}

export function projectReducer(state: ProjectPageState, action: ProjectAction): ProjectPageState {
  switch (action.type) {
    case "list-loading":
      return state.listLoading ? state : { ...state, listLoading: true };
    case "list-result":
      return { ...state, projects: action.projects, listLoading: false };
    case "workspace-reset":
      // 新工作空间：回到首拉态（清单待拉，选中/主区/进度/令牌全复位——
      // kg-viewer 随选中清空自然卸载，新选中后按新域重挂）
      return createProjectPageState();
    case "select-project": {
      // FID-30：点当前已选中行 → 仅折叠，主区状态与选中不动
      if (state.selected === action.name) {
        return state.domainCollapsed ? state : { ...state, domainCollapsed: true };
      }
      const row = state.projects.find((p) => p.name === action.name);
      if (row === undefined) return state;
      // 切项目先清旧态（buildProgress 清空 + kgToken 递增 + bootstrap 启动标记
      // 复位，CL-4-T6）再进新态
      const mode = modeOfStatus(row.status);
      return {
        ...state,
        selected: action.name,
        domainCollapsed: true,
        mainMode: mode,
        buildProgress: mode === "building" ? { done: 0, total: 0 } : null,
        kgToken: state.kgToken + 1,
        bootstrap: { launched: false },
      };
    }
    case "expand-domain":
      return state.domainCollapsed ? { ...state, domainCollapsed: false } : state;
    case "build-started": {
      // B1 冷启动：absent→building；行徽章乐观翻 building（次行 N/M 由轮询补）
      if (state.selected !== action.name || state.mainMode !== "absent") return state;
      return {
        ...state,
        mainMode: "building",
        buildProgress: { done: 0, total: 0 },
        projects: state.projects.map((p) =>
          p.name === action.name ? { ...p, status: "building" } : p,
        ),
      };
    }
    case "index-status": {
      const projects = state.projects.map((p) => (p.name === action.name ? patchProject(p, action.status) : p));
      if (state.selected !== action.name) return projects === state.projects ? state : { ...state, projects };
      const mode = modeOfStatus(action.status.state);
      if (state.mainMode === "building" && action.status.state === "building") {
        // 构建进度推进（O-6 轮询）
        const progress = action.status.progress ?? state.buildProgress;
        return { ...state, projects, buildProgress: progress };
      }
      if (state.mainMode === "building" && mode === "graph") {
        // 构建完成：若仍选中 → 主区自动进 graph（图谱出现）
        return { ...state, projects, mainMode: "graph", buildProgress: null, kgToken: state.kgToken + 1 };
      }
      if (state.mainMode === "building" && action.status.state === "absent") {
        // 触发未生效（回执仍是 absent）：退回 absent 态可重试
        return { ...state, projects, mainMode: "absent", buildProgress: null };
      }
      if (state.mainMode === "graph" && mode === "graph") {
        // graph 态内的索引面板重建回执由 kg-viewer 自持（不经此 reducer）
        return projects === state.projects ? state : { ...state, projects };
      }
      return { ...state, projects };
    }
    // ── bootstrap 扩面（T3.2）──
    case "bootstrap-launched":
      return { ...state, bootstrap: { launched: true } };
    default:
      return state;
  }
}
