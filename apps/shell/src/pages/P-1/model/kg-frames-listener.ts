/**
 * P-1 KgViewer kg 族帧订阅 listener（M9 #2.31 拆分：自 kg-viewer.tsx 抽出的
 * 独立模块——15 种帧订阅分发不再与组件渲染体同居；纯工厂无 React，可独立
 * 单测）。
 *
 * 消费面：kg 族点对点回执（kg.list/node.detail/change.report/index.status/
 * node.confirm/bootstrap.create/graph.purge/index.delete/health/candidates.list/
 * review.create + code.review.create + triage.create + auto.audit）+
 * connection.error（写面在途失败收口 +
 * 体检/台账读面 loading 收口）。
 *
 * 写面回执归因经 use-kg-write-flight 单飞位（settle(kind) 匹配才消费）——
 * 回执零关联位，非本视图发起不消费；connection.error 经 notifyError 归因
 * 当前在途 kind（一次一个在途，零顺序链张冠李戴）。
 */
import type {
  EventEnvelope,
  KgCandidateRowDto,
  KgChangeReportPayload,
  KgHealthDto,
  KgIndexStatusPayload,
  KgListPayload,
  KgNodeDetailPayload,
} from "@helix/protocol";
import type { Dispatch } from "react";
import type { ToastKind } from "@/shared/ui/Toast";
import { pickInitial, type KgAction, type KgViewState } from "./kg-model";
import type { ProjectAction } from "./project-model";
import type { KgWriteFlight } from "./use-kg-write-flight";

export interface KgFramesListenerDeps {
  readonly projectName: string;
  /** 组件态 ref 镜像（listener 闭包不随重渲染更新）。 */
  readonly stateRef: { readonly current: KgViewState };
  readonly dispatch: Dispatch<KgAction>;
  /** 写面单飞归因面（settle 回执归因 / notifyError 错误归因；两函数引用稳定）。 */
  readonly flight: Pick<KgWriteFlight, "settle" | "notifyError">;
  readonly sendKgNodeDetail: (payload: KgNodeDetailPayload) => boolean;
  readonly sendKgList: (payload: KgListPayload) => boolean;
  readonly sendKgChangeReport: (payload: KgChangeReportPayload) => boolean;
  readonly sendKgIndexStatus: (payload: KgIndexStatusPayload) => boolean;
  readonly sendKgProjects: () => boolean;
  /** P5：confirm/discard 后体检面刷新（草稿栏随裁决动作实时收敛）。 */
  readonly sendKgHealth: (payload: import("@helix/protocol").KgHealthPayload) => boolean;
  readonly projectDispatch: Dispatch<ProjectAction>;
  readonly toast: { push: (kind: ToastKind, text: string, sub?: string) => void };
  readonly t: (key: string, vars?: Record<string, string | number>) => string;
  /** 体检回执落本地数据面。 */
  readonly onHealthResult: (data: KgHealthDto) => void;
  /** 台账回执落本地数据面。 */
  readonly onCandidatesResult: (rows: readonly KgCandidateRowDto[], total: number) => void;
  /** connection.error 兜底：体检/台账读面 loading 收口（M9 #2.31）。 */
  readonly clearReadLoading: () => void;
  /** review/codeReview 发起成功置 launched 态（ok-strip 呈现）。 */
  readonly markReviewLaunched: () => void;
  readonly markCodeReviewLaunched: () => void;
  /** triage 发起成功置 launched 态（P1 发起钮状态面）。 */
  readonly markTriageLaunched: () => void;
  /** 自动裁决审计回执落本地数据面（P2）。 */
  readonly onAutoAuditResult: (data: import("@helix/protocol").KgAutoAuditDto) => void;
}

/** 构造 KgViewer 的 kg 族帧 listener（deps 全经调用方 ref/稳定引用间接取值）。 */
export function createKgFramesListener(deps: KgFramesListenerDeps): (e: EventEnvelope) => void {
  const { projectName, stateRef, dispatch, flight, toast, t } = deps;
  /** 回执后刷新链统一出口（TR-84：send 返回值必消费）——断连窗口未发出的
   *  刷新不静默：多面同断只交代一次，界面按陈旧数据处理（旧实现吞返回值，
   *  刷新丢失零反馈）。 */
  const refreshFaces = (sends: readonly (() => boolean)[]): void => {
    let lost = false;
    for (const send of sends) if (send() === false) lost = true;
    if (lost) toast.push("err", t("pj.kg.refreshLostToast"));
  };
  return (e: EventEnvelope) => {
    switch (e.type) {
      case "kg.list.result": {
        const nodes = [...e.payload.nodes];
        // 默认选中首个现行实体节点（P2③：避开 superseded——列表默认折叠，
        // 首屏详情与列表同观感；全废回落旧序，审计仍可查）。
        // 仅首载（sel 空）应用——转正后 list 刷新不得重置当前选中/详情
        const initial = stateRef.current.sel === null ? pickInitial(nodes) : undefined;
        dispatch({ type: "list-result", total: e.payload.total, nodes, initialSel: initial?.id });
        if (initial !== undefined) {
          // 首载默认选中的 detail 发送返回值必消费（中危 F3a，TR-84 同族/与
          // confirm 分支同款收口）：list-result 已置 detailLoading，send false
          //（断线窗口）不清骨架即永挂
          if (deps.sendKgNodeDetail({ project: projectName, id: initial.id }) === false) {
            dispatch({ type: "detail-failed", id: initial.id });
          }
        }
        return;
      }
      case "kg.node.detail.result":
        dispatch({ type: "detail-result", detail: e.payload });
        return;
      case "kg.change.report.result":
        dispatch({ type: "report-result", report: e.payload });
        return;
      case "kg.index.status.result": {
        const wasRebuilding = stateRef.current.idxRebuilding;
        const idx = e.payload;
        dispatch({ type: "idx-result", idx });
        if (wasRebuilding && (idx.state === "synced" || idx.state === "degraded")) {
          // W2-D R14：手动 sync 后 orphan>0 的体检提示行随 DTO 直渲 toast 副行（只提示不处置）
          toast.push("ok", t("pj.kg.rebuildDoneToast", { symbols: idx.symbolCount ?? 0 }), idx.orphanNote);
        }
        return;
      }
      case "kg.node.confirm.result": {
        // 翻转后状态回读：列表行刷新 + 重发 detail（daemon 已落转正日志）
        dispatch({ type: "confirm-applied", id: e.payload.node.id, status: e.payload.node.status });
        // code-review 族A（TR-84）：重发返回值必消费——confirm-applied 已置
        // detailLoading，重发未发出（断连窗口）则清骨架防永挂（同节点重选不重拉）
        if (deps.sendKgNodeDetail({ project: projectName, id: e.payload.node.id }) === false) {
          dispatch({ type: "detail-failed", id: e.payload.node.id });
        }
        // P5：列表/体检面双刷新（草稿栏随转正实时收敛）
        refreshFaces([() => deps.sendKgList({ project: projectName }), () => deps.sendKgHealth({ project: projectName })]);
        toast.push("ok", t("pj.kg.promoteToast", { name: e.payload.node.name }));
        return;
      }
      case "kg.node.discard.result": {
        // P5 草稿人审驳回回执：superseded 终态——列表/体检面双刷新（无 detail
        // 重发：驳回节点退出可选面，重拉详情无消费面）
        refreshFaces([() => deps.sendKgList({ project: projectName }), () => deps.sendKgHealth({ project: projectName })]);
        toast.push("ok", t("pj.kg.discardToast", { name: e.payload.node.name }));
        return;
      }
      // ── kg-bootstrap 批五回执（T3.2；单飞归因——回执零关联位）──
      case "kg.bootstrap.create.result": {
        if (!flight.settle("create")) return; // 非本视图发起
        deps.projectDispatch({ type: "bootstrap-launched" });
        toast.push("ok", t("pj.boot.createOkToast", { name: projectName }));
        return;
      }
      // ── kg 维护批两回执（C1；单飞归因——回执零关联位）──
      case "kg.graph.purge.result": {
        if (!flight.settle("purge")) return; // 非本视图发起
        toast.push("ok", t("pj.kg.purgedToast", { name: projectName, nodes: e.payload.nodesRemoved, symbols: e.payload.symbolsRemoved }));
        // 空态呈现链：列表/报告/索引态三面刷新
        refreshFaces([
          () => deps.sendKgList({ project: projectName }),
          () => deps.sendKgChangeReport({ project: projectName }),
          () => deps.sendKgIndexStatus({ project: projectName }),
          () => deps.sendKgProjects(), // 左栏 nodeCount 权威刷新
        ]);
        return;
      }
      case "kg.index.delete.result": {
        if (!flight.settle("indexDelete")) return;
        toast.push("ok", t("pj.kg.idxDeletedToast", { name: projectName }));
        // 面板 → absent 徽章 + 左栏徽章权威刷新
        refreshFaces([() => deps.sendKgIndexStatus({ project: projectName }), () => deps.sendKgProjects()]);
        return;
      }
      // ── kg.health 批 + kg 评审批回执（W2-E/W2-F；review 单飞归因）──
      case "kg.health.result": {
        deps.onHealthResult(e.payload);
        return;
      }
      case "kg.candidates.list.result": {
        deps.onCandidatesResult(e.payload.rows, e.payload.total);
        return;
      }
      case "kg.review.create.result": {
        if (!flight.settle("review")) return; // 非本视图发起
        deps.markReviewLaunched();
        refreshFaces([() => deps.sendKgProjects()]); // 行级 reviewRunning 权威化（体检入口运行态数据源）
        toast.push("ok", t("pj.health.reviewOkToast", { name: projectName }));
        return;
      }
      case "code.review.create.result": {
        if (!flight.settle("codeReview")) return; // 非本视图发起
        deps.markCodeReviewLaunched();
        refreshFaces([() => deps.sendKgProjects()]); // 行级 codeReviewRunning 权威化（运行态数据源）
        toast.push("ok", t("pj.health.codeReviewOkToast", { name: projectName }));
        return;
      }
      // ── kg-triage 发起 + 自动裁决审计回执（P1/P2；triage 单飞归因）──
      case "kg.triage.create.result": {
        if (!flight.settle("triage")) return; // 非本视图发起
        deps.markTriageLaunched();
        refreshFaces([() => deps.sendKgProjects()]); // 任务运行态权威化（triage 按钮随 job 状态翻转）
        toast.push("ok", t("pj.health.triageOkToast", { name: projectName }));
        return;
      }
      case "kg.auto.audit.result": {
        deps.onAutoAuditResult(e.payload);
        return;
      }
      case "connection.error": {
        // M9 #2.31：体检/台账读面 loading 收口（失败回执零感知不再恒 loading）；
        // 写面在途失败经单飞位归因（一次一个在途，kind 零张冠李戴；非在途不消费）
        deps.clearReadLoading();
        const msg = (e.payload as { message?: string }).message ?? "error";
        flight.notifyError(msg);
        return;
      }
      default:
        return;
    }
  };
}
