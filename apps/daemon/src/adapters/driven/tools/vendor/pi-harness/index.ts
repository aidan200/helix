/**
 * vendored pi harness 工具面（fork 自 @earendil-works/pi-agent-core@0.87.1 的
 * /node 子路径导出面——pi 1.0.0 拆包后该子路径与 harness 全量删除）。
 *
 * 范围：AgentHarnessTool 工具类型契约 + bash/read/write/edit 四件套 +
 * NodeExecutionEnv 执行环境 + skills 扫描（loadSourcedSkills）+ chord Context
 * 封装 + shell 输出截断工具。**只做搬运不做语义改动**——helix 的 25+ 自定义
 * 工具（AgentHarnessTool 六参签名）与工具桥（bindToolContext）全部依赖此面，
 * 签名零漂移是本 vendor 的存在理由（升级 pi 1.0.0 批次 1，E-235）。
 *
 * 上游来源（Apache-2.0，pi monorepo v0.87.1 tag）：
 *   packages/agent/src/harness/{types,context,config,skills}.ts
 *   packages/agent/src/harness/tools/*、utils/*、env/nodejs.ts
 * chord/pi-ai/pi-telemetry 等运行时依赖走 npm 正源（1.0.0），不 vendored。
 */

export * from "./types.ts";
export * from "./messages.ts";
// loop 侧工具契约 1.0.0 主入口仍在（签名未变），转口保持消费面 import 稳定
export type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
export * from "./context.ts";
export * from "./skills.ts";
export * from "./tools/index.ts";
export * from "./tools/tool-context.ts";
export * from "./utils/truncate.ts";
export * from "./utils/shell-output.ts";
export * from "./utils/output-capture.ts";
export { NodeExecutionEnv } from "./env/nodejs.ts";

// compaction 纯函数族 + session Entry 体系（fork 自 v0.87.1 harness/compaction + session 子集）
export * from "./compaction/compaction.ts";
export type { Entry, CompactionEntry, EntryProjector } from "./session/types.ts";
export { buildContextEntries, sessionEntryToContextMessages } from "./session/context.ts";
