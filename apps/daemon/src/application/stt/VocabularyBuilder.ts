/**
 * VocabularyBuilder —— 自动词汇表装配（语音输入 V1 Phase 1，设计 §5.3）。
 *
 * 【业务语义】转写请求的一部分：纯请求期组装，不落地、不常驻。多源采集
 * → 归一去重 → weight 降序贪心装填至字符预算 → AsrContext（hint 紧凑词表
 * 串 + 带权热词清单），STT adapter 各自归一下游形态（§5.6：DashScope 双
 * 通道 = 即时热词 parameters.vocabulary + 前置文本消息）。
 *
 * 【纯函数纪律】零 IO、零 Date/随机——全部输入经参数注入（单测零 mock）。
 *
 * 【预算】B = 350 字符净词表（Phase 0 查证校准：qwen-audio-3.0-asr 上下文
 * 通道每轮 ≤400 字符且静默截断；350 留 ~50 字符前缀与安全边际）。热词通道
 * 词数预算 ≤2000 与 B 解耦——热词侧输出全部入选词。
 *
 * 【V1 源面】P1 会话（extractSessionTokens 抽取）+ P3 内置基础词表；P0
 * 纠错 / P2 codegraph 符号源接口已留（学习回路批与符号源批接入），V1 恒空
 * 传入不影响装配行为。
 */

/** 上下文通道字符预算（净词表含分隔符总长上限；设计 §5.3 校准值）。 */
export const ASR_CONTEXT_BUDGET = 350;

/** 会话消息新近度全衰减窗口（最近 10 条 ×1.0，更早 ×0.5）。 */
export const SESSION_RECENCY_WINDOW = 10;

/** 会话 token 抽取模式（§5.2 P1：`[A-Za-z][A-Za-z0-9_.#-]{2,}`）。 */
const SESSION_TOKEN_PATTERN = /[A-Za-z][A-Za-z0-9_.#-]{2,}/g;

/** 单源字符占比上限（§5.3-4：防单源霸屏；对预算 B 的比例）。 */
export const SOURCE_CHAR_RATIOS = {
  correction: 0.1,
  session: 0.5,
  symbol: 0.35,
  base: 0.05,
} as const;

/** 词汇来源四档（P0 纠错 / P1 会话 / P2 符号 / P3 基础）。 */
export type VocabSourceKind = keyof typeof SOURCE_CHAR_RATIOS;

/** 单词（term 形态 + 内部权重 + 来源——热词映射与占比统计共用）。 */
export interface WeightedTerm {
  /** 保留原形态（camelCase/snake_case——ASR 输出音近串，形态由 key 对齐决定）。 */
  readonly term: string;
  /** 热词权重（DashScope 即时热词域 [1,5]，装配末统一 clamp）。 */
  readonly weight: number;
  readonly source: VocabSourceKind;
}

/** 归一后候选（装配中间态；weight 未 clamp）。 */
interface Candidate {
  readonly term: string;
  readonly weight: number;
  readonly source: VocabSourceKind;
}

/** 纠错记忆条目（P0；V1 恒空传入——学习回路批接入）。 */
export interface CorrectionTerm {
  readonly term: string;
  /** 外部可携带权重（历史命中计数等）；缺省 = 优先级基数 ×5。 */
  readonly weight?: number;
}

/** buildAsrContext 输入（四源各按需传入；全缺省 = 裸转写）。 */
export interface AsrContextInput {
  /** P0 纠错记忆（V1 恒空）。 */
  readonly corrections?: readonly CorrectionTerm[];
  /** P1 会话 token（extractSessionTokens 产物或等价注入）。 */
  readonly sessionTerms?: readonly string[];
  /** P2 项目符号（V1 恒空——codegraph 符号源批接入）。 */
  readonly symbols?: readonly string[];
  /** P3 基础词表（缺省 = 空——纯函数不隐式拉全局常量；组合根显式传 BASE_VOCABULARY）。 */
  readonly baseTerms?: readonly string[];
}

/** 装配产物：adapter 归一下游形态的统一输入（§5.6 AsrContext）。 */
export interface AsrContext {
  /** 入选词（weight 降序；热词通道全量消费，词数预算 ≤2000 与 B 解耦）。 */
  readonly terms: readonly WeightedTerm[];
  /** 紧凑词表串（逗号+空格分隔；总长 ≤ ASR_CONTEXT_BUDGET——词表匹配生效机制，无自然语言包装）。 */
  readonly hint: string;
}

/**
 * 会话消息流 → token 权重表（P1 源）。
 *
 * messages **最近在前**（index 0 = 最新消息）：新近度衰减 = index <
 * SESSION_RECENCY_WINDOW ×1.0，否则 ×0.5；会话基数 ×3。同小写 key 多形态
 * 时取 weight 高者（新近条目胜）；同 weight 首见胜（最新消息的形态优先）。
 */
export function extractSessionTokens(
  messages: readonly string[],
): Map<string, { term: string; weight: number }> {
  const out = new Map<string, { term: string; weight: number }>();
  messages.forEach((message, index) => {
    const recency = index < SESSION_RECENCY_WINDOW ? 1.0 : 0.5;
    const weight = 3 * recency;
    const matches = message.match(SESSION_TOKEN_PATTERN) ?? [];
    for (const term of matches) {
      const key = term.toLowerCase();
      const existing = out.get(key);
      if (existing === undefined || weight > existing.weight) {
        out.set(key, { term, weight });
      }
    }
  });
  return out;
}

/**
 * 多源装配 AsrContext（§5.3 算法：采集 → 归一 → 去重 → 降序贪心 → 占比上限）。
 *
 * 归一丢弃：纯数字 / >30 字符 / 单字母项。小写 key 去重保 camelCase 形态
 * （高 weight 胜、同 weight 首见胜——四源注入序 = corrections → session →
 * symbols → base，纠错记忆最优先）。贪心装填按字符 cost（term.length + 2
 * 分隔符）；单源占比超上限的词跳过（后续更小词仍可入选），总预算满即停。
 */
export function buildAsrContext(input: AsrContextInput): AsrContext {
  // 1. 采集：四源产出 candidate（weight = 优先级基数；纠错可外部携带）
  const candidates: Candidate[] = [];
  for (const c of input.corrections ?? []) {
    candidates.push({ term: c.term, weight: c.weight ?? 5, source: "correction" });
  }
  for (const term of input.sessionTerms ?? []) {
    candidates.push({ term, weight: 3, source: "session" });
  }
  for (const term of input.symbols ?? []) {
    candidates.push({ term, weight: 2, source: "symbol" });
  }
  for (const term of input.baseTerms ?? []) {
    candidates.push({ term, weight: 1, source: "base" });
  }

  // 2. 归一丢弃：纯数字 / 超长（>30）/ 单字母
  const normalized = candidates.filter((c) => {
    if (c.term.length > 30) return false;
    if (c.term.length <= 1) return false;
    if (/^[0-9]+$/.test(c.term)) return false;
    return true;
  });

  // 3. 去重：小写 key；高 weight 胜，同 weight 首见胜（normalized 序保持注入序）
  const byKey = new Map<string, Candidate>();
  for (const c of normalized) {
    const key = c.term.toLowerCase();
    const existing = byKey.get(key);
    if (existing === undefined || c.weight > existing.weight) byKey.set(key, c);
  }

  // 4. 排序：weight 降序（Array.prototype.sort 稳定——同 weight 保持去重后插入序）
  const ordered = [...byKey.values()].sort((a, b) => b.weight - a.weight);

  // 5. 贪心装填：总预算 + 单源占比上限（cost = 词长 + 2 分隔符；末词无分隔符 → hint 实长更短，预算守恒）
  const charCost = (term: string): number => term.length + 2;
  const sourceCaps: Record<VocabSourceKind, number> = {
    correction: Math.ceil(ASR_CONTEXT_BUDGET * SOURCE_CHAR_RATIOS.correction),
    session: Math.ceil(ASR_CONTEXT_BUDGET * SOURCE_CHAR_RATIOS.session),
    symbol: Math.ceil(ASR_CONTEXT_BUDGET * SOURCE_CHAR_RATIOS.symbol),
    base: Math.ceil(ASR_CONTEXT_BUDGET * SOURCE_CHAR_RATIOS.base),
  };
  const sourceChars: Record<VocabSourceKind, number> = { correction: 0, session: 0, symbol: 0, base: 0 };
  let total = 0;
  const picked: WeightedTerm[] = [];
  for (const c of ordered) {
    if (total >= ASR_CONTEXT_BUDGET) break;
    const cost = charCost(c.term);
    if (total + cost > ASR_CONTEXT_BUDGET) continue; // 更小的后续词仍可入选
    if (sourceChars[c.source] + cost > sourceCaps[c.source]) continue; // 单源占比上限：跳过不终止
    sourceChars[c.source] += cost;
    total += cost;
    // 6. 热词 weight clamp [1,5]（DashScope 即时热词域；低权抬 1 高权截 5）
    picked.push({
      term: c.term,
      weight: Math.min(5, Math.max(1, Math.round(c.weight))),
      source: c.source,
    });
  }

  return { terms: picked, hint: picked.map((t) => t.term).join(", ") };
}

/**
 * 内置基础词表（P3，§5.2：~100 词软件开发高频通用词——git/PR/merge/deploy
 * 级。ASR 对这些常用英文词本身识别良好，weight ×1 + 5% 占位上限——仅作
 * 覆盖兜底，不占会话词预算）。
 */
export const BASE_VOCABULARY: readonly string[] = [
  // 版本控制 / git 工作流
  "git", "commit", "push", "pull", "merge", "rebase", "checkout", "branch", "stash", "cherry-pick",
  "diff", "conflict", "repository", "fork", "clone", "tag", "blame", "reflog",
  // 代码评审 / 协作
  "pull request", "code review", "approve", "reviewer", "assignee", "milestone", "backlog",
  "standup", "retrospective", "sprint", "kanban", "issue", "ticket", "label",
  // 构建 / 部署
  "build", "deploy", "release", "rollback", "pipeline", "artifact", "registry", "staging",
  "production", "dev", "preview", "compile", "transpile", "minify",
  // 测试
  "test", "unit test", "integration test", "coverage", "fixture", "snapshot", "mock",
  "regression", "flaky", "assertion",
  // 调试 / 缺陷
  "bug", "debug", "breakpoint", "stacktrace", "log", "warning", "error", "exception",
  "segmentation fault", "memory leak", "race condition", "deadlock",
  // 架构 / 模式
  "refactor", "architecture", "pattern", "abstraction", "coupling", "cohesion",
  "monolith", "microservice", "middleware", "adapter", "port", "hexagonal",
  // 数据 / 存储
  "database", "schema", "migration", "index", "query", "transaction", "cache",
  "sqlite", "postgres", "redis",
  // 前端 / 通用技术词
  "component", "props", "state", "hook", "render", "hydration", "bundle", "webpack",
  "vite", "esbuild", "polyfill",
  // API / 网络
  "api", "endpoint", "rest", "graphql", "websocket", "grpc", "request", "response",
  "header", "payload", "latency", "timeout", "retry", "rate limit", "cdn",
  // 安全 / 认证
  "auth", "token", "session", "oauth", "jwt", "credential", "permission", "sandbox",
  // 进程 / 运维
  "daemon", "process", "thread", "signal", "socket", "stdin", "stdout", "stderr",
  "environment", "config", "flag", "feature toggle",
  // 通用编程词汇
  "async", "await", "promise", "callback", "closure", "recursion", "iterator",
  "generator", "immutable", "typecheck", "lint", "format", "snippet", "TODO",
];
