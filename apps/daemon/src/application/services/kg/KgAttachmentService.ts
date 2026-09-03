/**
 * KgAttachmentService —— edit 成功路径附着编排（T3.2，CL-1 F1.1/F1.2，
 * AD-4/AD-7 补充/AD-13/AD-15）。
 *
 * 编排链：读附着快照（KnowledgeGraphPort.getAttachmentSnapshot，按
 * projectRoot）→ matchAnchors 四层递降 → applyBudget 会话去重+token 硬顶
 * → renderAttachment 📎 块。返回块文本（或 ''）由 EditTool 拼接到工具
 * 结果尾部——「任何失败静默」：全链 try/catch 返回 ''，附着失败不产生
 * 工具错误（CL-1.A11）。
 *
 * 热路径纪律（§4.1 点查微秒级）：快照按 projectRoot 缓存，attach 前仅做
 * baseline 戳比对（getIndexStatus meta 点查）——sync 完成推进基准戳后
 * 下次 attach 重载；不做逐次全表扫描、无文件 IO、无 await sync（附着不
 * 依赖新鲜度，快照滞后合法，AD-15）。
 *
 * 会话级跨通道去重注册表（F1.2）本服务唯一持有：attachAfterEdit 附着过
 * 的 nodeId 与 markInjected（T3.3 任务层切片注入后登记）注入过的 nodeId
 * 共享同一 Set——同会话内两通道互斥不再重复到达。
 */

import { relative } from "node:path";
import type { KnowledgeGraphPort } from "../../ports/outbound/KnowledgeGraphPort";
import type { AttachmentSnapshot } from "../../../domain/kg/types";
import { matchAnchors } from "../../../domain/kg/attachment/scope-matcher";
import { applyBudget, ATTACHMENT_TOKEN_BUDGET } from "../../../domain/kg/attachment/budget";
import { renderAttachment } from "../../../domain/kg/attachment/render";

export interface KgAttachmentServiceDeps {
  readonly graph: KnowledgeGraphPort;
}

/** attachAfterEdit 入参：一次成功 edit 的单编辑现场（brief T3.2 契约）。 */
export interface AttachAfterEditInput {
  readonly projectRoot: string;
  readonly sessionId: string;
  /** 落盘文件路径（绝对或 projectRoot 相对；内部归一为相对——锚表路径语义）。 */
  readonly filePath: string;
  readonly oldText: string;
  readonly newText: string;
  readonly editLineStart: number;
  readonly editLineEnd: number;
  /** 编辑后文件全量行（EditTool 已读入内存的内容复用传入，无文件 IO）。 */
  readonly fileLines: readonly string[];
}

/** per-project 快照缓存条目（baseline 戳一致性 = 缓存有效性）。 */
interface SnapshotCacheEntry {
  readonly baseline: string | null;
  readonly snapshot: AttachmentSnapshot;
}

export class KgAttachmentService {
  private readonly deps: KgAttachmentServiceDeps;
  /** 会话级跨通道去重注册表（本服务唯一持有者；T3.3 经 markInjected 接入同一状态）。 */
  private readonly sessionSeen = new Map<string, Set<string>>();
  /** M6 容量上限（LRU 256 条）：超限淘汰最久未触会话（取实现最简者——Map 插入序
   *  + 触及重插刷新）。淘汰语义：被汰会话再次附着时 seen 重建（可能重复注入一次
   *  📎 块，代价远小于会话注册表无界增长）。 */
  private static readonly SESSION_SEEN_CAP = 256;
  private readonly snapshots = new Map<string, SnapshotCacheEntry>();

  constructor(deps: KgAttachmentServiceDeps) {
    this.deps = deps;
  }

  /**
   * edit 成功路径附着：返回 📎 块或 ''；任何内部异常捕获返回 ''（宁可沉默
   * 不可错附）。内部全同步（快照点查+纯函数），async 仅为接线契约形态。
   */
  async attachAfterEdit(input: AttachAfterEditInput): Promise<string> {
    try {
      const snapshot = this.snapshotOf(input.projectRoot);
      const seen = this.seenOf(input.sessionId);
      const matched = matchAnchors(
        {
          filePath: relPathOf(input.projectRoot, input.filePath),
          oldText: input.oldText,
          newText: input.newText,
          editLineStart: input.editLineStart,
          editLineEnd: input.editLineEnd,
          fileLines: input.fileLines,
        },
        snapshot,
      );
      const selection = applyBudget(matched, seen, { maxTokens: ATTACHMENT_TOKEN_BUDGET });
      for (const anchor of selection.anchors) {
        seen.add(anchor.nodeId); // 本通道附着计入跨通道注册表（同会话不再附）
      }
      return renderAttachment(selection);
    } catch {
      return "";
    }
  }

  /**
   * 任务层注入登记（T3.3 消费面）：sessionId 内已注入过的节点 id 不再被
   * 动作层附着——跨通道共享同一注册表的机械落点。
   */
  markInjected(sessionId: string, nodeIds: string[]): void {
    const seen = this.seenOf(sessionId);
    for (const nodeId of nodeIds) seen.add(nodeId);
  }

  /**
   * 会话已到达节点 id 读面（T3.3 切片注入排除输入；与 markInjected 同一
   * 注册表——注入前排除已达 id，注入后登记新达 id，两通道互斥闭环）。
   */
  seenInSession(sessionId: string): ReadonlySet<string> {
    return this.seenOf(sessionId);
  }

  private seenOf(sessionId: string): Set<string> {
    const existing = this.sessionSeen.get(sessionId);
    if (existing !== undefined) {
      // M6 LRU：触及重插刷新插入序（最近使用沉底，淘汰取队首）
      this.sessionSeen.delete(sessionId);
      this.sessionSeen.set(sessionId, existing);
      return existing;
    }
    const seen = new Set<string>();
    if (this.sessionSeen.size >= KgAttachmentService.SESSION_SEEN_CAP) {
      const oldest = this.sessionSeen.keys().next().value;
      if (oldest !== undefined) this.sessionSeen.delete(oldest);
    }
    this.sessionSeen.set(sessionId, seen);
    return seen;
  }

  /**
   * 快照读（点查纪律）：baseline 戳一致 → 缓存命中；不一致（sync 完成推进
   * 基准戳）→ 重载。缓存条目按 projectRoot 隔离（工作区一级项目数量级）。
   * 知识层写（digest/supersede）不推进 baseline——附着面滞后合法（AD-15），
   * 下次 sync 后收敛。
   */
  private snapshotOf(projectRoot: string): AttachmentSnapshot {
    const { baseline } = this.deps.graph.getIndexStatus(projectRoot);
    const cached = this.snapshots.get(projectRoot);
    if (cached !== undefined && cached.baseline === baseline) return cached.snapshot;
    const snapshot = this.deps.graph.getAttachmentSnapshot(projectRoot);
    this.snapshots.set(projectRoot, { baseline, snapshot });
    return snapshot;
  }
}

/** 事件路径归一：绝对路径 → 相对 projectRoot（锚表/符号表相对语义同源，KgSyncService 同款）。 */
function relPathOf(projectRoot: string, filePath: string): string {
  if (!filePath.startsWith("/")) return filePath;
  return relative(projectRoot, filePath) || filePath;
}
