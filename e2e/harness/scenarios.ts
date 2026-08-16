/**
 * 剧本数据（test-design §5.2 场景定义；S1/S2/S3/S5/S7 —— S4/S6 属 daemon 侧）。
 *
 * 剧本输出 = 数据呈现断言源（气泡文本、工具名/参数/结果、exit code、重建
 * 条数 N 等），spec 断言值全部取自本文件，不凭空构造。
 */
import {
  agentInstance,
  closure,
  compactionEntry,
  msgEntry,
  thinkingEntry,
  toolEntry,
  usageDto,
  type ClientFrame,
} from "./protocol";
import type { EntryDto, SessionUsageDto } from "@helix/protocol";

// ── S1 多轮流式：富 markdown 回复（加粗/行内 code/列表/代码块）──────

export const S1_MODEL = "claude-sonnet-4-5";

/** 第一轮 assistant 回复：含 R-05 全部 markdown 形态。 */
export const S1_REPLY_MD = [
  "**协议是两端同源的单一定义点。** 先读 `packages/protocol/src/envelope.ts`：",
  "",
  "- 统一信封 `Enveloped` 带 `v` 版本位",
  "- 命令与事件按 `type` 判别式窄化",
  "- workspace 路由字段位预留",
  "",
  "示例帧：",
  "",
  "```ts",
  "const frame: EventEnvelope = { v: 0, type: \"hello\", payload: { token } };",
  "```",
].join("\n");

/** S1 流式分段（delta 序列，拼接 === S1_REPLY_MD）。 */
export const S1_DELTAS = ["**协议是两端同源的单一定义点。** 先读 `packages/protocol", "/src/envelope.ts`：\n\n- 统一信封 `Enveloped` 带 `v` 版本位\n- 命令与事件按 `type` 判别式窄化\n- workspace 路由字段位预留\n\n示例帧：\n\n```ts\n", "const frame: EventEnvelope = { v: 0, type: \"hello\", payload: { token } };\n```"];

export const S1_TURN2_USER = "第二轮：再把 grep 工具的匹配规则讲一下";
export const S1_TURN2_REPLY = "grep 走 `ripgrep` 语义：多命中/零命中/路径过滤/大小写四个维度。";

// ── S2 五工具（read/bash/edit/write/grep 各一；bash error exit 1）────

export const S2_TOOLS = {
  read: {
    id: "tool-read",
    name: "read",
    args: JSON.stringify({ path: "packages/protocol/src/envelope.ts" }),
    result: "export interface Envelope<T = unknown> {\n  v: 0;\n  type: string;\n  payload: T;\n}",
    durationMs: 240,
  },
  bash: {
    id: "tool-bash",
    name: "bash",
    args: JSON.stringify({ cmd: "bun test apps/daemon" }),
    result: "error: 3 tests failed\n(exit code 1)\nprocess exited with exit 1",
    durationMs: 4200,
  },
  edit: {
    id: "tool-edit",
    name: "edit",
    args: JSON.stringify({ path: "apps/shell/src/app/App.tsx", oldText: "ChatPage", newText: "ChatPageV2" }),
    result: "edited 1 file",
    durationMs: 90,
  },
  write: {
    id: "tool-write",
    name: "write",
    args: JSON.stringify({ path: "docs/notes.md", content: "# note\nhello" }),
    result: "wrote 2 lines",
    durationMs: 60,
  },
  grep: {
    id: "tool-grep",
    name: "grep",
    args: JSON.stringify({ pattern: "TODO: handshake", path: "src", ignoreCase: true }),
    result: "3 matches in 2 files",
    durationMs: 130,
  },
} as const;

// ── S3 steer ────────────────────────────────────────────────

export const S3_USER_STEER = "等一下，顺便把 session.subscribe 的语义也讲了";
export const S3_STEER_ENTRY_ID = "steer-entry-1";
export const S3_TURN1_REPLY = "第一轮回复正文中……";
export const S3_TURN2_REPLY = "收到注入消息，继续讲 session.subscribe：v0 仅保通路语义。";

// ── S5 断线重连（快照 N 条重建）─────────────────────────────

export const S5_ENTRIES: EntryDto[] = [
  msgEntry("s5-m1", "user", "重启前的用户消息"),
  msgEntry("s5-m2", "assistant", "重启前的助手回复"),
];

// ── S7 空态 ─────────────────────────────────────────────────
// 空快照（entries: []）—— R-15 断言源见 review.md 建议 chip 文案（i18n key）。

// ── M2 v0.1 剧本族（test-design §4.2 S1~S6；T4.4）────────────
// 命名前缀按剧本语义（ORCH/DRAWER/THINK/USAGE/COMPACT/REBUILD），
// 避免与首迭代 S1/S2/S3/S5 场景常量冲突。
// 纪律（test-design §4.3）：closure 五字段显式 null；usage 七字段全发；
// 数字自洽（Σ行 = 徽标，spec 内以原始数核算 + fmtTokens 单一格式化）；
// 文案断言走 zh-CN 默认词条，业务正文属 mock 载体自由构造。

// 纪律（test-design §4.3）：closure 五字段显式 null；usage 七字段全发；
// 数字自洽（Σ行 = 徽标，spec 内以原始数核算 + fmtTokens 单一格式化）；
// 文案断言走 zh-CN 默认词条，业务正文属 mock 载体自由构造。

// S1 编排主线（CL-1 F1.1/F1.3/F1.5/F1.6）
export const ORCH_EXISTING_INSTANCE = agentInstance("agent-0", {
  state: "done",
  task: "既有实例（快照恢复的 done 终态）",
  closure: closure("done", "既有实例已收口：报告已落盘。"),
  usage: usageDto(1_800, 0.02),
});
export const ORCH_EXISTING_USAGE: SessionUsageDto = {
  total: usageDto(1_800, 0.02),
  compaction: usageDto(0, 0),
};
export const ORCH_AGENT1 = "agent-1";
export const ORCH_AGENT1_TASK = "梳理编排事件族与四态状态机";
export const ORCH_AGENT1_MODEL = "anthropic/claude-sonnet-4-5";
export const ORCH_AGENT1_DELTAS = [
  "契约 §5.1 定义七个编排生命周期事件。",
  "卡片状态机按事件族投影：四态互斥、终态吸收。",
];
export const ORCH_AGENT1_CLOSURE = closure("done", "编排事件族梳理完成：四态投影规则已核对。", {
  reportPath: "reports/sess-e2e/agent-1.md",
});
export const ORCH_AGENT2 = "agent-2";
export const ORCH_AGENT2_TASK = "预算满时排队等待空位";
export const ORCH_AGENT2_ERROR = "engine crashed: stream aborted";
export const ORCH_AGENT2_CLOSURE = closure("failed", "流式中止：引擎崩溃收口。");

// S2 抽屉全流（CL-1 F1.2/F1.8；五物种 + kill 两步 + stalled + steer 拒绝）
export const DRAWER_AGENT = "agent-1";
export const DRAWER_TASK = "核对 per-instance channel 五物种回放";
export const DRAWER_MSG = "通道消息：env.ts 注入点与契约 §5 对齐。";
export const DRAWER_THINK_FRAMES = ["思考帧甲：先核事件序。", "思考帧乙：再核 reducer 分流。"];
export const DRAWER_THINK_TEXT = "思考帧甲：先核事件序。思考帧乙：再核 reducer 分流。结论：分流正确。";
export const DRAWER_THINK_ENTRY = thinkingEntry("sa-think-1", DRAWER_THINK_TEXT, {
  instanceId: DRAWER_AGENT,
  durationMs: 4_200,
  reasoningTokens: 2_600,
});
export const DRAWER_TOOL_READ = toolEntry(
  "sa-tool-read",
  "read",
  JSON.stringify({ path: "e2e/harness/protocol.ts" }),
  "running",
  { instanceId: DRAWER_AGENT },
);
export const DRAWER_TOOL_READ_DONE = { ...DRAWER_TOOL_READ, state: "done" as const, result: "export function welcome(…)", durationMs: 240 };
export const DRAWER_TOOL_BASH_ERR = toolEntry(
  "sa-tool-bash",
  "bash",
  JSON.stringify({ cmd: "bun test apps/daemon" }),
  "error",
  { result: "process exited with exit 1", durationMs: 4_200, instanceId: DRAWER_AGENT },
);
export const DRAWER_STEER_TEXT = "主线中途追加：优先看契约 §5 的事件序。";
export const DRAWER_STALLED_MS = 45_000;
export const DRAWER_KILL_CLOSURE = closure("failed", "用户终止：任务未完成收口。", {
  reportPath: "reports/sess-e2e/agent-1.md",
  findings: [{ kind: "issue" }, { kind: "sediment" }],
  taskId: "T-44",
});

// S3 thinking 三态（CL-2 F2.3/F2.4）
export const THINK_FRAMES = ["先看契约：", " §5.2 通道族四事件，", "再核对 reducer 分流。"];
export const THINK_FULL_TEXT = THINK_FRAMES.join("") + "结论：三态互斥成立。";
export const THINK_ENTRY = thinkingEntry("think-main-1", THINK_FULL_TEXT, {
  durationMs: 3_200,
  reasoningTokens: 1_200,
});
export const THINK_REPLY = "thinking 落折叠条：完成态不可逆回流式。";
export const THINK_TURN2_REPLY = "第二轮无 thinking 事件：零 thinking 块渲染。";

// S4 usage 账目（CL-3 F3.3/F3.4；数字自洽见 USAGE_*_RAW 核算）
export const USAGE_MAIN_TURN = usageDto(3_000, 0.04, {
  input: 1_800,
  output: 1_000,
  reasoning: 800,
});
export const USAGE_AGENT1 = usageDto(5_000, 0.09, {
  input: 2_800,
  output: 2_000,
  cacheRead: 12_000,
  cacheWrite: 4_000,
});
export const USAGE_AGENT2_A = usageDto(1_600, 0.01);
export const USAGE_AGENT2_B = usageDto(2_400, 0.02);
/** agent-2 分次入账后的行小计（popover 行显示值） */
export const USAGE_AGENT2 = usageDto(
  USAGE_AGENT2_A.totalTokens + USAGE_AGENT2_B.totalTokens,
  +(USAGE_AGENT2_A.cost + USAGE_AGENT2_B.cost).toFixed(2),
);
/** Σ行 = 徽标（原始数核算；展示面统一走 fmtTokens 单一格式化） */
export const USAGE_TOTAL = usageDto(
  USAGE_MAIN_TURN.totalTokens + USAGE_AGENT1.totalTokens + USAGE_AGENT2_A.totalTokens + USAGE_AGENT2_B.totalTokens,
  +(USAGE_MAIN_TURN.cost + USAGE_AGENT1.cost + USAGE_AGENT2_A.cost + USAGE_AGENT2_B.cost).toFixed(2),
);

// S5 compaction（CL-4 F4.1 UI 面）
export const COMPACT_MAIN_TURN = usageDto(2_200, 0.03);
export const COMPACT_ENTRY = compactionEntry("compact-1", {
  tokensBefore: 340_000,
  tokensAfter: 20_000,
  summary: "会话上下文已压缩：保留最近任务的关键结论与工具产出。",
  usage: usageDto(1_800, 0.02),
});

// S6 快照投影重建（混合：CL-1 卡片 / CL-2 thinking / CL-3 账目）
export const REBUILD_MAIN_USAGE = usageDto(2_600, 0.03, { reasoning: 900 });
export const REBUILD_AGENT1 = agentInstance("agent-1", {
  state: "done",
  task: "重启前完成的任务",
  model: "anthropic/claude-sonnet-4-5",
  closure: closure("done", "重启前已收口：报告与结论已落盘。", {
    reportPath: "reports/sess-e2e/agent-1.md",
    findings: [{ kind: "issue" }, { kind: "sediment" }, { kind: "boundary" }],
    taskId: "T-44",
  }),
  usage: usageDto(5_400, 0.09, { cacheRead: 12_000, cacheWrite: 4_000 }),
});
export const REBUILD_AGENT2 = agentInstance("agent-2", {
  state: "failed",
  task: "重启前失败的任务",
  closure: closure("failed", "重启前崩溃收口：引擎异常。"),
  usage: usageDto(2_100, 0.04),
});
export const REBUILD_THINK_ENTRY = thinkingEntry("rebuild-think-1", "重启前的思考全文：快照重建后仍可展开回看。", {
  durationMs: 4_200,
  reasoningTokens: 2_600,
});
export const REBUILD_COMPACT_ENTRY = compactionEntry("rebuild-compact-1", {
  tokensBefore: 340_000,
  tokensAfter: 20_000,
  usage: usageDto(1_800, 0.02),
});
export const REBUILD_AGENT1_USER_MSG = msgEntry("rebuild-a1-u", "user", "抽屉回放：主线注入的用户消息", {
  instanceId: "agent-1",
});
export const REBUILD_AGENT1_TOOL = toolEntry(
  "rebuild-a1-tool",
  "read",
  JSON.stringify({ path: "packages/protocol/src/events.ts" }),
  "done",
  { result: "export const EVENT_TYPES = […]", instanceId: "agent-1" },
);
export const REBUILD_INSTANCES = [
  agentInstance("main", { kind: "main", profileKind: "main-session", usage: REBUILD_MAIN_USAGE }),
  REBUILD_AGENT1,
  REBUILD_AGENT2,
];
export const REBUILD_USAGE: SessionUsageDto = {
  total: usageDto(
    REBUILD_MAIN_USAGE.totalTokens +
      REBUILD_AGENT1.usage!.totalTokens +
      REBUILD_AGENT2.usage!.totalTokens +
      REBUILD_COMPACT_ENTRY.usage.totalTokens,
    +(
      REBUILD_MAIN_USAGE.cost +
      REBUILD_AGENT1.usage!.cost +
      REBUILD_AGENT2.usage!.cost +
      REBUILD_COMPACT_ENTRY.usage.cost
    ).toFixed(2),
  ),
  compaction: REBUILD_COMPACT_ENTRY.usage,
};

// ── 发送命令帧校验 helper（Node 侧）─────────────────────────

export function findCommand(frames: ClientFrame[], type: string): ClientFrame | undefined {
  return frames.find((f) => f && f.type === type);
}
