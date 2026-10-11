/**
 * KgQueryService —— kg 读面应用服务 + 任务层切片注入（T3.3，CL-4 F4.1 +
 * CL-1 F1.3，AD-16；检索语义化批双轨）。
 *
 * 两件事：
 * 1. **跨项目读聚合**（kg 工具消费）：search/get 按 workspace 多项目聚合
 *    ——search 汇总各已建 .kg 项目的 LIKE 命中行（project 伴随）；
 *    searchUnion = 关键词轨 ∪ 向量轨（检索语义化批）；get 按
 *    项目排序确定性首命中。项目列表经 deps.projects 注入（已建 .kg 过滤
 *    ——读面绝不新建库文件）。
 * 2. **任务层切片注入**（spawn 派发与主会话首轮双链消费同一注入器，
 *    SchedulerService / ChatService）：任务文本 → **双轨并集**——关键词轨
 *    （extractTaskTerms 词条序匹配，行为零变化）∪ 向量轨（任务文本整段
 *    向量化语义召回 top-K 且 ≥ 阈值，score 降序追加；两轨同节点去重后置
 *    关键词轨位）→ 会话足迹过滤（U7 并轨：空足迹不注入）→ selectTaskSlice
 *    （排除+去重+预算）→ digest+指针切片追加进 task 文本尾部（约束区
 *    语义）。注入成功后经 attachment.markInjected 登记
 *    会话注册表（与 edit 附着跨通道共享去重，F1.2）。向量轨任何失败/
 *    缺席降级纯关键词轨（与历史行为逐字节一致）——注入是增强，绝不阻断。
 */

import type { KnowledgeGraphPort } from "../../ports/outbound/KnowledgeGraphPort";
import type { AnchorReverseHit, CandidateListQuery, CandidateRow, NodeDigestRow, NodeDetail } from "../../../domain/kg/types";
import { ATTACHMENT_PROTOCOL_LINE_WORKER } from "../../../domain/kg/attachment/render";
import { extractTaskTerms } from "../../../domain/kg/attachment/task-slice";
import { seenKeyOf } from "../../../domain/kg/attachment/budget";
import {
  renderTaskSlice,
  selectTaskSlice,
  type TaskSliceRenderOptions,
  type TaskSliceRow,
} from "../../../domain/kg/attachment/task-slice";
import { renderResidentRules, type ResidentRuleRow } from "../../../domain/kg/attachment/resident-rules";
import type { SemanticHit } from "../../../domain/kg/semantic-recall";
import { resolveMainRepoPath } from "../../../domain/kg/project-discovery";

/** 足迹/项目根归一（形态差异消除：尾斜杠剥离 + worktree 归主仓——比对两侧同形）。 */
const normalizeRoot = (input: string): string | null => {
  try {
    return resolveMainRepoPath(input).replaceAll("\\", "/").replace(/\/+$/, "");
  } catch {
    return null;
  }
};

/** 注入登记条目（F3 修复：复合键语义——project + nodeId；多项目同 id 节点互不误排）。 */
export interface InjectedNodeRef {
  readonly project: string;
  readonly nodeId: string;
}

/** 会话级跨通道去重注册表消费面（KgAttachmentService 实现；缺省无去重）。 */
export interface SessionSeenRegistry {
  /** 会话已到达（注入过/附着过）节点读面（`project\0nodeId` 复合键集合，seenKeyOf 口径）。 */
  seenInSession(sessionId: string): ReadonlySet<string>;
  /** 注入登记（本通道到达计入——同会话其他通道不再重复到达；project+nodeId 成对登记）。 */
  markInjected(sessionId: string, nodes: readonly InjectedNodeRef[]): void;
}

export interface KgQueryServiceDeps {
  readonly graph: KnowledgeGraphPort;
  /** 已建 .kg 的项目根列表（有序；读面绝不新建库文件——过滤由注入方承担）。 */
  readonly projects: () => readonly string[];
  /** 会话去重注册表（可选——子进程本地栈无注册表，注入不去重）。 */
  readonly attachment?: SessionSeenRegistry;
  /**
   * 语义召回轨（可选件，检索语义化批）：query 文本 → 向量轨命中行
   * （score 降序）；缺席/失败/超时 → 纯关键词轨（行为与历史逐字节一致）。
   * 生产接 KgSemanticRecallService.recall（超时/降级在服务内收口）。
   */
  readonly semantic?: (queryText: string, projects: readonly string[]) => Promise<readonly SemanticHit[]>;
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

/** affected 命中行（project 伴随——跨项目聚合形态同 search，R20）。 */
export interface KgAffectedHit extends AnchorReverseHit {
  readonly project: string;
}

/** candidates 台账命中行（project 伴随——跨项目聚合形态同 search；读面三件套之一）。 */
export interface KgCandidateHit {
  readonly project: string;
  readonly row: CandidateRow;
}

/**
 * 切片受众（D8 W-R6 协议行分叉）：main = 主会话（持 kg-update，supersede
 * 直落措辞）；worker = SubAgent spawn 注入（无 kg-update，supersede 改经
 * findings 文件申报措辞）。缺省 main（主会话 ChatService 注入链）。
 */
export type TaskSliceAudience = "main" | "worker";

export class KgQueryService {
  private readonly deps: KgQueryServiceDeps;

  constructor(deps: KgQueryServiceDeps) {
    this.deps = deps;
  }

  /** 跨项目 search 聚合（项目序 + 项目内 id 序，确定性；关键词轨）。 */
  search(q: string): readonly KgHit[] {
    const out: KgHit[] = [];
    for (const project of this.deps.projects()) {
      for (const row of this.deps.graph.search(project, q)) {
        out.push({ project, row });
      }
    }
    return out;
  }

  /**
   * 双轨并集 search（kg search 工具消费，检索语义化批）：关键词轨原序
   * 在前 ∪ 向量轨新命中按相似度降序追加在后；两轨同节点（project+nodeId
   * 复合键）去重后置关键词轨位；向量轨缺席/失败 → 纯关键词轨。
   */
  async searchUnion(q: string): Promise<readonly KgHit[]> {
    const keyword = this.search(q);
    const seen = new Set(keyword.map((h) => seenKeyOf(h.project, h.row.id)));
    const out: KgHit[] = [...keyword];
    for (const hit of await this.collectSemanticHits(q, this.deps.projects())) {
      const key = seenKeyOf(hit.project, hit.row.id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ project: hit.project, row: hit.row });
    }
    return out;
  }

  /** 跨项目 get：按项目序首命中（确定性）；不存在返回 null。 */
  get(nodeId: string): KgNodeHit | null {
    const all = this.locate(nodeId);
    return all.length > 0 ? all[0]! : null;
  }

  /** 目标库最近迭代锚（iterationId 机械解析的库内回落，A4 任务二）。 */
  latestIteration(projectRoot: string): string | null {
    return this.deps.graph.latestIteration(projectRoot);
  }

  /**
   * 锚反查跨项目聚合（R20 affected op）：target（相对路径 / 符号名 /
   * path#symbol）→ 各已建 .kg 项目 reverseAnchorLookup 汇总（项目序 +
   * 项目内节点序，确定性；读面绝不新建库文件——项目列表注入方已过滤）。
   */
  affected(target: string): readonly KgAffectedHit[] {
    const out: KgAffectedHit[] = [];
    for (const project of this.deps.projects()) {
      for (const hit of this.deps.graph.reverseAnchorLookup(project, target)) {
        out.push({ project, ...hit });
      }
    }
    return out;
  }

  /**
   * candidates 台账跨项目聚合（读面三件套之一：agent kg candidates op 消费）：
   * 各已建 .kg 项目 listCandidates 汇总（项目序 + 项目内最新在前，确定性；
   * 读面绝不新建库文件——项目列表注入方已过滤）。
   */
  listCandidates(query: CandidateListQuery): readonly KgCandidateHit[] {
    const out: KgCandidateHit[] = [];
    for (const project of this.deps.projects()) {
      for (const row of this.deps.graph.listCandidates(project, query)) {
        out.push({ project, row });
      }
    }
    return out;
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
   * 常驻规则索引段（global 声明节点 → 系统提示触发面，组装链消费）：
   * 跨项目聚合 listGlobalResidentRules → domain 渲染（name+scene+kg get
   * 指针，不含全文——命中场景后主动读全文）。空集/异常 → null（段整体
   * 省略；增强面绝不阻断系统提示组装，无图谱项目零注入痕迹）。
   *
   * U7 去全扫化：projectRoots = 会话项目足迹（WriteFactRegistry.
   * projectFootprint——只认写事实不认声明）。空足迹 → null（不注入：
   * 「感知不到项目时的默认行为，不该比注入错误项目规则更差」）；足迹
   * 内未建图谱的项目自然缺席（listGlobalResidentRules 空集）。
   */
  residentRulesSection(projectRoots: readonly string[]): string | null {
    try {
      const wanted = projectRoots
        .map((root) => normalizeRoot(root))
        .filter((r): r is string => r !== null);
      if (wanted.length === 0) return null;
      const projects = this.deps.projects().filter((project) =>
        wanted.includes(normalizeRoot(project) ?? ""),
      );
      if (projects.length === 0) return null;
      const rows: readonly ResidentRuleRow[] = projects.flatMap((project) =>
        this.deps.graph.listGlobalResidentRules(project).map((row) => ({ project, row })),
      );
      return renderResidentRules(rows, { multiProject: projects.length > 1 });
    } catch {
      return null; // 静默（增强面，绝不阻断启动）
    }
  }

  /**
   * 任务层切片注入（F1.3；检索语义化批双轨并集）：返回注入后的 task
   * 文本（命中追加切片段；空命中/失败返回原文逐字节不变——空段省略不
   * 占位，AD-18）。候选序 = 关键词轨原序（任务文本词条序+项目序+id 序）
   * + 向量轨新命中（score 降序追加在后；两轨同节点去重后置关键词轨位）。
   * 注入的 id 即时 markInjected（跨通道去重闭环）。audience（W-R6）：
   * worker 受众协议行改 findings 申报措辞（组合根 spawn 链传 "worker"，
   * 主会话 ChatService 链传 "main"）。
   *
   * projectRoots = 会话项目足迹（栈内 writeFacts.projectFootprint(sessionId)
   * 补齐，U7 去全扫化并轨 residentRulesSection 口径）：空足迹 → 原文透传
   * 不注入——「感知不到项目时的默认行为，不该比注入错误项目规则更差」；
   * 足迹经 normalizeRoot 归一（worktree 归主仓）后过滤 deps.projects()。
   *
   * 同步性（用户裁决 2026-10-11，解法 a）：注入链 async 化——嵌入往返
   * （超时上限 800ms）进注入链；超时/失败降级纯关键词轨，绝不挂死派发。
   */
  async injectTaskSlice(
    sessionId: string,
    taskText: string,
    audience: TaskSliceAudience,
    projectRoots: readonly string[],
  ): Promise<string> {
    try {
      if (taskText.trim() === "") return taskText;
      const wanted = projectRoots
        .map((root) => normalizeRoot(root))
        .filter((r): r is string => r !== null);
      if (wanted.length === 0) return taskText;
      const projects = this.deps.projects().filter((project) =>
        wanted.includes(normalizeRoot(project) ?? ""),
      );
      if (projects.length === 0) return taskText;
      const renderOptions: TaskSliceRenderOptions = {
        multiProject: projects.length > 1,
        ...(audience === "worker" ? { protocolLine: ATTACHMENT_PROTOCOL_LINE_WORKER } : {}),
      };
      const candidates = this.collectCandidates(taskText, projects);
      // 向量轨新命中追加在关键词轨后（同节点去重归 selectTaskSlice——首见保留即关键词轨位）
      const semanticRows: TaskSliceRow[] = (await this.collectSemanticHits(taskText, projects)).map((hit) => ({
        project: hit.project,
        row: hit.row,
      }));
      const all = [...candidates, ...semanticRows];
      if (all.length === 0) return taskText;
      const exclude = this.deps.attachment?.seenInSession(sessionId) ?? new Set<string>();
      const picked = selectTaskSlice(all, exclude, renderOptions);
      if (picked.length === 0) return taskText;
      const block = renderTaskSlice(picked, renderOptions);
      this.deps.attachment?.markInjected(
        sessionId,
        picked.map((c) => ({ project: c.project, nodeId: c.row.id })),
      );
      return `${taskText}\n\n${block}`;
    } catch {
      return taskText; // 注入失败静默（增强面，绝不阻断 spawn）
    }
  }

  /** 任务文本 → 词条集合 → 各项目 search 同源匹配 → 候选（确定性序；关键词轨）。 */
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

  /** 向量轨命中（缺席/失败 → []——降级纯关键词轨，绝不抛）。 */
  private async collectSemanticHits(queryText: string, projects: readonly string[]): Promise<readonly SemanticHit[]> {
    if (this.deps.semantic === undefined) return [];
    try {
      return await this.deps.semantic(queryText, projects);
    } catch {
      return [];
    }
  }
}
