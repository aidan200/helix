/**
 * bash 命令写候选静态提取（U0b L1——纯函数，framework-free）。
 *
 * 为什么存在：L2 快照 diff 的范围定向与降级兜底——
 * 1) 提取到的路径不在 exec cwd 的 git 仓内时，对这些路径做定向 stat
 *    （cwd 仓的 git status 覆盖不到的写）；
 * 2) L2 降级（git status 超时/快照失败）时，提取结果作为 uncertain
 *    置信的兜底事实。
 * 覆盖不求完备（任意 shell 静态分析不可能完备——变量/子shell/eval），
 * 漏报由 L2 兜（快照是完备通道），本层只求「提取到的就是对的」。
 */

/** 管道/逻辑链分隔符切分（粗粒度——引号内分隔符误切只导致漏报不误报）。 */
function splitSegments(command: string): readonly string[] {
  return command.split(/(?:\|\||&&|[|;()\n])/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** token 化（空白切分；去引号——引号内空格路径会切碎，接受漏报）。 */
function tokenize(segment: string): readonly string[] {
  return segment.split(/\s+/).filter((t) => t.length > 0).map((t) => t.replace(/^["']|["']$/g, ""));
}

/** 写目标形态：非 fd 重定向（排除 >&N / &>N / 2>&1 类；设备 /dev/null 排除）。 */
const REDIRECT_RE = /(?:\d?>>?|&>>?)\s*([^\s<>&;|]+)|(?:\d?>>?|&>>?)([^\s<>&;|]+)/g;

/** 单参写命令（参数即目标：tee/rm/rmdir/touch/truncate——取首个非 flag 参数）。 */
const ONE_ARG_WRITERS = new Set(["tee", "rmdir", "touch"]);

/** 双参写命令（第二参数为目标：cp/mv/mkdir——mkdir -p dir 的 dir 是首个非 flag）。 */
const TWO_ARG_WRITERS = new Set(["cp", "mv", "ln", "install"]);

/** 写嫌疑子命令头（段内首 token 命中即提取后续非 flag 路径参数）。 */
const WRITE_HEADERS = new Set([
  "sed", // -i 就地写（见下方专门处理）
  "mkdir",
  "truncate",
  "dd", // of= 目标
  "shred",
  "git", // 写子命令专门处理
]);

/** git 写子命令（目标 = 后续非 flag 参数；checkout/restore 无参也改树——cwd 仓覆盖）。 */
const GIT_WRITE_SUBS = new Set(["apply", "checkout", "restore", "clean", "stash", "rm", "mv", "reset", "am", "sparse-checkout"]);

/** 命令基名（路径形态取尾段）。 */
function basenameOf(token: string): string {
  const i = token.lastIndexOf("/");
  return i < 0 ? token : token.slice(i + 1);
}

/** fd 目标 / 设备文件判定（重定向提取的排除项）。 */
function isFdOrDevice(target: string): boolean {
  return /^&\d+$/.test(target) || /^\d+$/.test(target) || target === "/dev/null" || target === "/dev/stdout" || target === "/dev/stderr";
}

/**
 * 提取命令文本中的写候选路径（原始 token——相对路径由调用方按 cwd 解析）。
 * 返回去重列表；纯只读命令（cat/ls/grep 等）返回空。
 */
export function extractWriteCandidates(command: string): readonly string[] {
  const out = new Set<string>();
  for (const segment of splitSegments(command)) {
    for (const w of segmentWriteTokens(segment)) out.add(w);
  }
  return [...out];
}

/** 单段写候选 token（cd 段返回空——cd 不写文件系统）。 */
function segmentWriteTokens(segment: string): readonly string[] {
  const out: string[] = [];
  // 1) 重定向目标（全段扫描——可出现在任意位置）
  for (const m of segment.matchAll(REDIRECT_RE)) {
    const target = m[1] ?? m[2] ?? "";
    if (target !== "" && !isFdOrDevice(target)) out.push(target);
  }
  const tokens = tokenize(segment);
  const head = tokens.length > 0 ? basenameOf(tokens[0] ?? "") : "";
  if (head === "") return out;
  // 2) sed -i：POSIX 形态 script 总在 files 前——首个非 flag 参数是
  // script 表达式（跳过），其余为就地写目标（-i'' / -i.ext 变体吞掉）
  if (head === "sed") {
    if (tokens.some((t) => /^-i/.test(t))) {
      const operands = tokens.slice(1).filter((t) => !t.startsWith("-"));
      for (const t of operands.slice(1)) out.push(t); // [0] = script
    }
    return out;
  }
  // 3) tee [-a]：首个非 flag 参数
  if (ONE_ARG_WRITERS.has(head)) {
    const arg = tokens.slice(1).find((t) => !t.startsWith("-"));
    if (arg !== undefined) out.push(arg);
    return out;
  }
    // 4) cp/mv：末参（目标）；mkdir [-p]：首个非 flag；ln/install：末参
    if (TWO_ARG_WRITERS.has(head) || head === "mkdir") {
      const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
      if (args.length > 0) out.push(head === "mkdir" ? args[0] ?? "" : args[args.length - 1] ?? "");
      return out;
    }
    // 5) dd of=目标
    if (head === "dd") {
      for (const t of tokens.slice(1)) {
        const m = /^of=(.+)$/.exec(t);
        if (m !== null && m[1] !== undefined) out.push(m[1]);
      }
      return out;
    }
    // 6) git 写子命令：非 flag 参数（可多目标）
    if (head === "git") {
      const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
      if (args.length > 0 && GIT_WRITE_SUBS.has(args[0] ?? "")) {
        for (const t of args.slice(1)) out.push(t);
      }
      return out;
    }
    // 7) 其余写嫌疑头（WRITE_HEADERS 剩余项——truncate -s N file 等）：非 flag 参数
    if (WRITE_HEADERS.has(head)) {
      for (const t of tokens.slice(1)) {
        if (!t.startsWith("-")) out.push(t);
      }
    }
    return out;
}

/** 段规划项：追踪到的段工作目录（null = cd 状态失锁）+ 该段写候选（原始 token）。 */
export interface BashSegmentPlan {
  readonly cwd: string | null;
  readonly writes: readonly string[];
}

/** 纯字符串路径解析（不用 node:path——domain 纪律）：base + rel 折叠 . / ..。 */
function resolveWithin(base: string, rel: string): string {
  const isAbs = rel.startsWith("/");
  const parts = (isAbs ? rel : `${base}/${rel}`).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(p);
  }
  return `/${out.join("/")}`;
}

/** cd 目标可解析形态判定（变量/命令替换/~-展开/~ 裸 → 失锁；绝对/相对字面量 → 可解析）。 */
function cdTargetOf(tokens: readonly string[]): string | null | "unknown" {
  const t = tokens[1];
  if (t === undefined || t === "" || t === "-" || t.startsWith("$") || t.includes("$(") || t.startsWith("~")) {
    return "unknown";
  }
  return t;
}

/**
 * cd-aware 段规划（U0b 修复：agent bash 常态 `cd project && cmd > f`——
 * 段级追踪 cd 后各段工作目录，供快照面做仓探测与候选根解析）。
 *
 * 追踪规则（保守——漏报优于误报）：
 * - `cd /abs` → cwd 重置为该绝对路径；
 * - `cd rel` → 已知 cwd 上叠加；失锁态遇 rel 维持失锁；
 * - cd 裸/-/~/$VAR 形态 → 失锁（该段及后续段 cwd = null，直到绝对 cd 重置）；
 * - 失锁段的相对路径候选丢弃（根不可知——错根路径会污染足迹/降级面），
 *   绝对路径候选保留；
 * - 子 shell 括号被切分丢失边界——cd 泄漏到外层段（误判方向是 stat ∅
 *   漏报，无害）。
 */
export function planBashSegments(command: string, cwd: string): readonly BashSegmentPlan[] {
  let cur: string | null = resolveWithin(cwd, ".");
  const out: BashSegmentPlan[] = [];
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    const head = tokens.length > 0 ? basenameOf(tokens[0] ?? "") : "";
    if (head === "cd") {
      const t = cdTargetOf(tokens);
      cur = t === null || t === "unknown" ? null : t.startsWith("/") ? resolveWithin(t, ".") : cur !== null ? resolveWithin(cur, t) : null;
      continue;
    }
    const writes = segmentWriteTokens(segment).filter((w) => cur !== null || w.startsWith("/"));
    out.push({ cwd: cur, writes });
  }
  return out;
}
