/**
 * KgQueryService —— kg 读面应用服务 + 任务层切片注入（T3.3，CL-4 F4.1 +
 * CL-1 F1.3，AD-16）。
 *
 * 两件事：
 * 1. **跨项目读聚合**（kg 工具消费）：search/get 按 workspace 多项目聚合
 *    ——search 汇总各已建 .kg 项目的 LIKE 命中行（project 伴随）；get 按
 *    项目排序确定性首命中。项目列表经 deps.projects 注入（已建 .kg 过滤
 *    ——读面绝不新建库文件）。
 * 2. **任务层切片注入**（spawn 派发时，SchedulerService.taskInjector 消费）：
 *    任务文本 → extractIdentifiers（与 edit 附着同源分词）→ 各项目 search
 *    同源匹配 → selectTaskSlice（排除+去重+预算）→ digest+指针切片追加进
 *    task 文本尾部（约束区语义）。注入成功后经 attachment.markInjected 登记
 *    会话注册表（与 edit 附着跨通道共享去重，F1.2）。任何失败静默返回
 *    原文——注入是增强，绝不阻断 spawn。
 */

import type { KnowledgeGraphPort } from "../../ports/outbound/KnowledgeGraphPort";
import type { NodeDigestRow, NodeDetail } from "../../../domain/kg/types";
import { extractTaskTerms } from "../../../domain/kg/attachment/task-slice";
import {
  renderTaskSlice,
  selectTaskSlice,
  type TaskSliceRenderOptions,
  type TaskSliceRow,
} from "../../../domain/kg/attachment/task-slice";

/** 会话级跨通道去重注册表消费面（KgAttachmentService 实现；缺省无去重）。 */
export interface SessionSeenRegistry {
  /** 会话已到达（注入过/附着过）的节点 id 读面。 */
  seenInSession(sessionId: string): ReadonlySet<string>;
  /** 注入登记（本通道到达计入——同会话其他通道不再重复到达）。 */
  markInjected(sessionId: string, nodeIds: readonly string[]): void;
}

export interface KgQueryServiceDeps {
  readonly graph: KnowledgeGraphPort;
  /** 已建 .kg 的项目根列表（有序；读面绝不新建库文件——过滤由注入方承担）。 */
  readonly projects: () => readonly string[];
  /** 会话去重注册表（可选——子进程本地栈无注册表，注入不去重）。 */
  readonly attachment?: SessionSeenRegistry;
}

/** search 命中行（project 伴随——多项目指针行携带项目名）。 */
export interface KgHit extends TaskSliceRow {
  readonly row: NodeDigestRow;
}

/** get 命中（project 伴随——详情展示携带归属）。 */
export interface KgNodeHit {
  readonly project: string;
  readonly detail: NodeDetail;
}

export class KgQueryService {
  private readonly deps: KgQueryServiceDeps;

  constructor(deps: KgQueryServiceDeps) {
    this.deps = deps;
  }

  /** 跨项目 search 聚合（项目序 + 项目内 id 序，确定性）。 */
  search(q: string): readonly KgHit[] {
    const out: KgHit[] = [];
    for (const project of this.deps.projects()) {
      for (const row of this.deps.graph.search(project, q)) {
        out.push({ project, row });
      }
    }
    return out;
  }

  /** 跨项目 get：按项目序首命中（确定性）；不存在返回 null。 */
  get(nodeId: string): KgNodeHit | null {
    const all = this.locate(nodeId);
    return all.length > 0 ? all[0]! : null;
  }

  /** 跨项目全命中（kg-update supersede 目标定位——多命中由调用方裁决）。 */
  locate(nodeId: string): readonly KgNodeHit[] {
    const out: KgNodeHit[] = [];
    for (const project of this.deps.projects()) {
      const detail = this.deps.graph.getNode(project, nodeId);
      if (detail !== null) out.push({ project, detail });
    }
    return out;
  }

  /**
   * 任务层切片注入（F1.3）：返回注入后的 task 文本（命中追加切片段；
   * 空命中/失败返回原文逐字节不变——空段省略不占位，AD-18）。
   * 注入的 id 即时 markInjected（跨通道去重闭环）。
   */
  injectTaskSlice(sessionId: string, taskText: string): string {
    try {
      const projects = this.deps.projects();
      if (projects.length === 0 || taskText.trim() === "") return taskText;
      const renderOptions: TaskSliceRenderOptions = { multiProject: projects.length > 1 };
      const candidates = this.collectCandidates(taskText, projects);
      if (candidates.length === 0) return taskText;
      const exclude = this.deps.attachment?.seenInSession(sessionId) ?? new Set<string>();
      const picked = selectTaskSlice(candidates, exclude, renderOptions);
      if (picked.length === 0) return taskText;
      const block = renderTaskSlice(picked, renderOptions);
      this.deps.attachment?.markInjected(
        sessionId,
        picked.map((c) => c.row.id),
      );
      return `${taskText}\n\n${block}`;
    } catch {
      return taskText; // 注入失败静默（增强面，绝不阻断 spawn）
    }
  }

  /** 任务文本 → 词条集合 → 各项目 search 同源匹配 → 候选（确定性序）。 */
  private collectCandidates(taskText: string, projects: readonly string[]): TaskSliceRow[] {
    const terms = extractTaskTerms(taskText);
    const candidates: TaskSliceRow[] = [];
    for (const identifier of terms) {
      for (const project of projects) {
        for (const row of this.deps.graph.search(project, identifier)) {
          candidates.push({ project, row });
        }
      }
    }
    return candidates;
  }
}
