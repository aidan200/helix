/**
 * WriteFactRegistry —— per-agent 写事实登记表（U0a 底座）。
 *
 * 为什么存在：TurnDiffService 的两个记账口（recordWrite/recordExternal）
 * 是轮窗口语义——轮外写直接丢弃；跨会话协调（U1 护栏 / U4 占用 /
 * U7 足迹）需要「跨轮、daemon 生命周期内持久」的累积面。本服务是
 * daemon 全局内存单例（组合根构造、经可选槽注入两处接线点），与
 * daemon.lock/调度队列同语义：liveness 态，宿主重启自然清零，
 * 零落盘零持久化。
 *
 * 数据源三路（装配层并联接线，缺省不记录——照 turnDiff 可选槽先例）：
 * 1. main 工具写：sessionEngineFactory writeHook 并联 record（precise）；
 * 2. subagent 工具写：buildSessionStack onFileWrite 并联 record（precise）；
 * 3. bash 写：BashSenseEnvWrap exec 前后快照差集（inferred/uncertain）。
 *
 * 纯内存操作面：无 IO 注入（now 注入仅为测试确定性）。
 */

import {
  CONFIDENCE_ORDER,
  type InstanceWriteFacts,
  type WriteConfidence,
  type WriteFact,
} from "../../domain/writefact/types";
import { projectRootOfAbs, resolveMainRepoPath } from "../../domain/kg/project-discovery";

interface InstanceState {
  readonly sessionId: string;
  /** path → 当前置信（高覆盖低）+ 计数 + 最后时刻。 */
  readonly paths: Map<string, { confidence: WriteConfidence; count: number; lastAt: number }>;
  writeCount: number;
  lastWriteAt: number;
}

export interface WriteFactRegistryDeps {
  /** workspace 根（projectFootprint 归约用；未注入 → 足迹恒空）。 */
  readonly workspaceRoot?: () => string | undefined;
  /** 时钟注入（测试确定性；缺省 Date.now）。 */
  readonly now?: () => number;
}

export class WriteFactRegistry {
  private readonly byInstance = new Map<string, InstanceState>();
  private readonly now: () => number;
  private readonly workspaceRoot: () => string | undefined;

  constructor(deps: WriteFactRegistryDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.workspaceRoot = deps.workspaceRoot ?? (() => undefined);
  }

  /** 记账（幂等累积：同路径计数增长、置信高覆盖低）。 */
  record(fact: WriteFact): void {
    this.recordMany([fact]);
  }

  recordMany(facts: readonly WriteFact[]): void {
    for (const f of facts) {
      let st = this.byInstance.get(f.instanceId);
      if (st === undefined) {
        st = { sessionId: f.sessionId, paths: new Map(), writeCount: 0, lastWriteAt: 0 };
        this.byInstance.set(f.instanceId, st);
      }
      const existing = st.paths.get(f.path);
      if (existing === undefined) {
        st.paths.set(f.path, { confidence: f.confidence, count: 1, lastAt: f.at });
      } else {
        // 高置信覆盖低（precise > inferred > uncertain > unknown）
        const confidence =
          CONFIDENCE_ORDER[f.confidence] >= CONFIDENCE_ORDER[existing.confidence] ? f.confidence : existing.confidence;
        existing.confidence = confidence;
        existing.count += 1;
        existing.lastAt = Math.max(existing.lastAt, f.at);
      }
      st.writeCount += 1;
      st.lastWriteAt = Math.max(st.lastWriteAt, f.at);
    }
  }

  /** 时间窗内其他实例的 precise 写路径（U0b L2 归属剔除查询）。 */
  preciseWritesSince(cutoffMs: number, excludeInstanceId: string): readonly WriteFact[] {
    const out: WriteFact[] = [];
    for (const [instanceId, st] of this.byInstance) {
      if (instanceId === excludeInstanceId) continue;
      for (const [p, e] of st.paths) {
        if (e.confidence === "precise" && e.lastAt >= cutoffMs) {
          out.push({ instanceId, sessionId: st.sessionId, path: p, at: e.lastAt, confidence: "precise" });
        }
      }
    }
    return out;
  }

  ofInstance(instanceId: string): InstanceWriteFacts | undefined {
    const st = this.byInstance.get(instanceId);
    return st === undefined ? undefined : this.project(instanceId, st);
  }

  ofSession(sessionId: string): readonly InstanceWriteFacts[] {
    const out: InstanceWriteFacts[] = [];
    for (const [instanceId, st] of this.byInstance) {
      if (st.sessionId === sessionId) out.push(this.project(instanceId, st));
    }
    return out;
  }

  /** 会话写路径并集（min 置信门槛过滤；缺省全取——U1 护栏口径）。 */
  sessionPaths(sessionId: string, min: WriteConfidence = "unknown"): ReadonlySet<string> {
    const floor = CONFIDENCE_ORDER[min];
    const out = new Set<string>();
    for (const st of this.byInstance.values()) {
      if (st.sessionId !== sessionId) continue;
      for (const [p, e] of st.paths) {
        if (CONFIDENCE_ORDER[e.confidence] >= floor) out.add(p);
      }
    }
    return out;
  }

  /**
   * 会话项目足迹（U7 消费口——宁多勿漏：全置信并集经 projectRootOfAbs
   * 归约去重；worktree 路径先经 resolveMainRepoPath 归主仓；workspace
   * 外路径不进足迹）。
   */
  projectFootprint(sessionId: string): readonly string[] {
    const root = this.workspaceRoot();
    if (root === undefined) return [];
    const projects = new Set<string>();
    for (const p of this.sessionPaths(sessionId)) {
      const first = projectRootOfAbs(root, resolveMainRepoPath(p));
      if (first !== undefined) {
        // projectRootOfAbs 返回一级目录名——拼回根（POSIX 形态，足迹语义足够）
        projects.add(`${root.replaceAll("\\", "/").replace(/\/+$/, "")}/${first}`);
      }
    }
    return [...projects].sort();
  }

  /** 会话销毁清理（挂 SessionRegistry 回调——装配层接线）。 */
  dropSession(sessionId: string): void {
    for (const [instanceId, st] of this.byInstance) {
      if (st.sessionId === sessionId) this.byInstance.delete(instanceId);
    }
  }

  /** 实例终态清理（subagent 收口；main 保留到会话销毁）。 */
  dropInstance(instanceId: string): void {
    this.byInstance.delete(instanceId);
  }

  /** 测试/观测用全量快照。 */
  snapshot(): ReadonlyMap<string, InstanceWriteFacts> {
    const out = new Map<string, InstanceWriteFacts>();
    for (const [instanceId, st] of this.byInstance) out.set(instanceId, this.project(instanceId, st));
    return out;
  }

  private project(instanceId: string, st: InstanceState): InstanceWriteFacts {
    const paths = new Map<string, WriteConfidence>();
    for (const [p, e] of st.paths) paths.set(p, e.confidence);
    return { instanceId, sessionId: st.sessionId, paths, writeCount: st.writeCount, lastWriteAt: st.lastWriteAt };
  }
}
