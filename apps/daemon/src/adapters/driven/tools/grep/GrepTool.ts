import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import { createTsBackend } from "./backends/ts-backend";

/**
 * GrepTool —— grep 工具门面（AD-10；CL-3 域目录化，architecture §5.1）。
 *
 * 对引擎暴露的接口形状不变：AgentHarnessTool 形态、手写参数 schema
 * （pattern/path/glob/ignoreCase 四键）、输出格式 `path:行号: 行内容` /
 * `(no matches for "...")` 文案——既有工具契约零变化。
 *
 * 门面只做后端接线与输出格式化，不含匹配逻辑（匹配核在
 * backends/ts-backend.ts）。T1.1 直挂内置 TS 后端（唯一后端，行为与
 * 迁移前完全一致）；rg 后端（T1.2）与后端选择/降级编排（T1.3，AF-1
 * 启动定格语义）落地后门面在此分流。
 */

/** grep 工具参数（JSON Schema，手写；与 typebox Type.Object 产物同构，
 *  pi-ai 校验层兼容；daemon 不直接依赖 typebox）。 */
const grepParameters = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "搜索的子串（区分大小写，除非 ignoreCase）" },
    path: { type: "string", description: "搜索起点：文件或目录（相对当前工作目录）" },
    glob: { type: "string", description: "文件路径过滤 glob（* 可跨目录，如 *.ts）" },
    ignoreCase: { type: "boolean", description: "忽略大小写（默认 false）" },
  },
  required: ["pattern", "path"],
  additionalProperties: false,
} as const;

/** 自写 grep 工具：实现 core 的 Tool 接口（AgentHarnessTool 形态）。 */
export function createGrepTool(): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "grep",
    label: "grep",
    description:
      "在指定文件或目录内递归搜索文本（子串匹配），返回命中行（格式 path:行号: 行内容）。" +
      "可用 glob 过滤文件（* 可跨目录）、ignoreCase 忽略大小写。跳过 node_modules 与 .git。",
    parameters: grepParameters as any,
    async execute(toolCallId, params, signal, _onUpdate, context): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const { pattern, path, glob, ignoreCase } = params as {
        pattern: string;
        path: string;
        glob?: string;
        ignoreCase?: boolean;
      };
      const backend = createTsBackend(context.env, path, signal); // T1.1：直挂 TS 后端（选择/降级编排属 T1.3）
      const matches = await backend.search({ pattern, glob, ignoreCase });
      const text =
        matches.length > 0
          ? matches.map((m) => `${m.path}:${m.lineNumber}: ${m.line}`).join("\n")
          : `(no matches for "${pattern}")`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}
