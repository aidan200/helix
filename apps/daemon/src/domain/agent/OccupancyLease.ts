/**
 * 占用租约（U4 占用协调）——跨会话写冲突的协调事实单元。
 *
 * 为什么存在：多会话共享同一工作树时「谁正在动哪个范围」没有任何机械
 * 可见面（TR-63 两起实证事故：A 的 commit 卷入 B 的在制文件）。沙箱
 * （约束）与写事实登记（感知）各答一半——租约回答第三个问题：「这块
 * 范围此刻被谁占用、意图是什么」。租约不是台账：台账记历史事实
 * （完成后保留，成功判据要读），租约记 liveness（用完即走、宿主重启
 * 自然失效）——两者唯一交点是 plan 全 resolve 作为租约降级判据输入。
 *
 * 纯值对象 + 纯函数（domain 纪律：零 IO 零框架）。
 */

/** 占用范围：项目根（目录前缀语义）或显式路径/目录清单（前缀匹配）。 */
export type LeaseScope =
  | { readonly kind: "project"; readonly projectRoot: string }
  | { readonly kind: "paths"; readonly patterns: readonly string[] };

/**
 * 租约来源：
 * - claimed：决策主体显式声明（coord_claim 工具）；
 * - isolated：isolated spawn 的 worktree 机械登记（不构成主树冲突面）；
 * - undeclared：写事实自动补登（无租约覆盖的 ≥inferred 写行为——漏声明
 *   从踩踏隐患变为可见且带标记的偏差）。
 */
export type LeaseSource = "claimed" | "isolated" | "undeclared";

/**
 * 状态语义（处置权纪律：对活实例的占用系统永远只标注不清除——
 * 清除只有四口：release 意图 / 窗口消亡 / settled TTL 过期 / 重启清零）：
 * - active：占用中（阻塞协调判定）；
 * - stale：实例活着但久无动静（agent.stalled 标注，不清除）；
 * - settled：机械判定改完（plan 全 resolve + 本轮无新写 → 不再阻塞，
 *   保留 settleTtlMs 可查窗口后物理删）；
 * - ghost：超长闲置降级（不算阻塞面，仍可追溯）。
 */
export type LeaseStatus = "active" | "settled" | "stale" | "ghost";

export interface OccupancyLeaseData {
  readonly leaseId: string; // lease-<唯一串>
  /** 决策主体归属（会话）——subagent 短命可重派，租约挂会话不挂执行者。 */
  readonly ownerSessionId: string;
  /** 决策主体实例（main 实例 / undeclared 时的写行为实例）。 */
  readonly ownerAgentId: string;
  /** 执行实例（isolated 租约跟踪 subagent；终态摘除）。 */
  readonly executors: readonly string[];
  readonly scope: LeaseScope;
  /** 意图（自然语言；undeclared 为占位文案）。 */
  readonly intent: string;
  readonly source: LeaseSource;
  readonly status: LeaseStatus;
  readonly claimedAt: number;
  /** 最后活跃时刻（写事实持续刷新）。 */
  readonly lastActivityAt: number;
}

/**
 * 路径前缀归一（比对前调用）：折叠重复斜杠、去尾斜杠、/private 前缀
 * 折叠（macOS tmpdir 符号链接形态——/var 与 /private/var 同一 vnode，
 * U1 护栏实证过两侧形态漂移）。
 */
export function normalizeScopePath(p: string): string {
  let s = p.replace(/\/{2,}/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  if (s === "/private" || s.startsWith("/private/")) s = s.slice("/private".length) || "/";
  return s;
}

/** 目录前缀包含（归一后）：root === path 或 path 位于 root 下。 */
function isUnder(root: string, path: string): boolean {
  const r = normalizeScopePath(root);
  const p = normalizeScopePath(path);
  return r === p || p.startsWith(r + "/");
}

/** 范围覆盖路径（paths 清单任一前缀命中即覆盖）。 */
export function scopeCoversPath(scope: LeaseScope, path: string): boolean {
  if (scope.kind === "project") return isUnder(scope.projectRoot, path);
  return scope.patterns.some((pat) => isUnder(pat, path));
}

/** 两范围重叠（project/project 根相等或一方包含；paths 任一前缀相交）。 */
export function scopesOverlap(a: LeaseScope, b: LeaseScope): boolean {
  const aRoots = a.kind === "project" ? [a.projectRoot] : [...a.patterns];
  const bRoots = b.kind === "project" ? [b.projectRoot] : [...b.patterns];
  return aRoots.some((ra) => bRoots.some((rb) => isUnder(ra, rb) || isUnder(rb, ra)));
}

/** 阻塞协调判定的状态（active/stale 阻塞；settled/ghost 不阻塞）。 */
export function isBlocking(status: LeaseStatus): boolean {
  return status === "active" || status === "stale";
}

/** 租约单行紧凑描述（工具回执/审计文案用）。 */
export function describeScope(scope: LeaseScope): string {
  return scope.kind === "project" ? scope.projectRoot : scope.patterns.join(", ");
}
