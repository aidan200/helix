/**
 * 剧本数据（test-design §5.2 场景定义；S1/S2/S3/S5/S7 —— S4/S6 属 daemon 侧）。
 *
 * 剧本输出 = 数据呈现断言源（气泡文本、工具名/参数/结果、exit code、重建
 * 条数 N 等），spec 断言值全部取自本文件，不凭空构造。
 */
import { msgEntry, toolEntry, type ClientFrame } from "./protocol";
import type { EntryDto } from "../../packages/protocol/src/index";

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

// ── 发送命令帧校验 helper（Node 侧）─────────────────────────

export function findCommand(frames: ClientFrame[], type: string): ClientFrame | undefined {
  return frames.find((f) => f && f.type === type);
}
