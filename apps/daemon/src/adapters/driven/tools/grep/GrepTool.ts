import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import {
  createRgBackend,
  RG_TIMEOUT_MS,
} from "./backends/rg-backend";
import type { GrepMatch, GrepQuery } from "./contract";

/**
 * GrepTool —— grep 工具门面（AD-10；CL-3 域目录化，architecture §5.1）。
 *
 * 对引擎暴露的接口形状不变：AgentHarnessTool 形态、手写参数 schema
 * （pattern/path/glob/ignoreCase 四键）、输出格式 `path:行号: 行内容` /
 * `(no matches for "...")` 文案——既有工具契约零变化。
 *
 * 门面只做后端接线与输出格式化，不含匹配逻辑。**rg 单后端**（TS 内置
 * 后端已删——分发形态只有安装包与 dev 两种，均有 bundle 级 rg 保障）：
 * - **启动定格**：组合根一次性 resolve + 探针的产物经 deps 注入
 *   （见 freeze-backend.ts）。门面运行期只读定格结果——零解析、零探针。
 * - **响亮失败**（unavailable 定格）：工具仍注册，execute 返回明确
 *   错误文案（原因 + 修复指引），不静默、不让 daemon 起不来。
 * - **运行期失败透传**：RgExecError/RgTimeoutError 原样上抛转为工具
 *   错误（无 TS 兜底可降级）；超时文案含「收窄 path/glob」自愈引导。
 */

/** grep 工具参数（JSON Schema，手写；与 typebox Type.Object 产物同构，
 *  pi-ai 校验层兼容；daemon 不直接依赖 typebox）。 */

/** 输出截断口径（code-review M24，与 read/bash 的 2000 行/50KB 同轨）。 */
const MAX_GREP_LINES = 2000;
const MAX_GREP_CHARS = 50 * 1024;

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

/** 门面注入面（组合根装配时填充——启动定格产物的机械投影）。 */
export interface GrepToolDeps {
  /**
   * 启动定格的 rg 路径（AF-1：freeze-backend 产物；提供 = rg 可用，
   * 缺省 = unavailable 定格，工具响亮失败）。运行期零重新解析。
   */
  readonly rgPath?: string;
  /** unavailable 定格的缺失原因清单（响亮失败文案用；rgPath 缺省时由组合根透传）。 */
  readonly unavailableReasons?: readonly string[];
  /** rg 单次检索超时上限覆盖（测试注入面；缺省 RG_TIMEOUT_MS=10s）。 */
  readonly rgTimeoutMs?: number;
}

/** grep unavailable 定格时的响亮失败文案（原因 + 修复指引，对 agent 可见）。 */
function unavailableMessage(reasons: readonly string[]): string {
  return (
    "grep 工具不可用：rg 后端启动定格失败。\n" +
    `原因：${reasons.join("；")}\n` +
    "修复：安装包形态请重装（包内应含 rg 二进制）；开发者请先运行 " +
    "bun scripts/fetch-rg.ts 并经 dev-desktop 启动；或在 config.json 配置 rgPath 指向可用的 ripgrep。"
  );
}

/** 自写 grep 工具：实现 core 的 Tool 接口（AgentHarnessTool 形态）。 */
export function createGrepTool(deps: GrepToolDeps = {}): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  return {
    name: "grep",
    label: "grep",
    description:
      "在指定文件或目录内递归搜索文本（子串匹配），返回命中行（格式 path:行号: 行内容）。" +
      "可用 glob 过滤文件（* 可跨目录）、ignoreCase 忽略大小写。跳过 node_modules 与 .git。" +
      "单次检索有超时上限；超大目录建议收窄 path 或加 glob 过滤。",
    parameters: grepParameters as any,
    async execute(toolCallId, params, signal, _onUpdate, context): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const { pattern, path, glob, ignoreCase } = params as {
        pattern: string;
        path: string;
        glob?: string;
        ignoreCase?: boolean;
      };
      const matches = await search({ pattern, glob, ignoreCase }, path, context, signal);
      // 输出截断（code-review M24）：与 read/bash 同口径（2000 行 / 50KB 先到
      // 先截 + 截断注明 + 收窄提示）——高频 pattern 全量 join 可向模型上下文
      // 注入数十万行。
      let text: string;
      if (matches.length === 0) {
        text = `(no matches for "${pattern}")`;
      } else {
        const lines = matches.map((m) => `${m.path}:${m.lineNumber}: ${m.line}`);
        let truncatedByLines = false;
        let body = lines.slice(0, MAX_GREP_LINES).join("\n");
        if (lines.length > MAX_GREP_LINES) truncatedByLines = true;
        let truncatedByBytes = false;
        if (body.length > MAX_GREP_CHARS) {
          body = body.slice(0, MAX_GREP_CHARS);
          truncatedByBytes = true;
        }
        text =
          truncatedByLines || truncatedByBytes
            ? `${body}\n\n（命中过多已截断：共 ${matches.length} 行命中${truncatedByLines ? `，仅保留前 ${MAX_GREP_LINES} 行` : ""}${truncatedByBytes ? "，按 50KB 截断" : ""}——请收窄 path 或加 glob/更精确 pattern 后重试）`
            : body;
      }
      return { content: [{ type: "text", text }], details: undefined };
    },
  };

  /** 后端执行：rg 唯一直通；unavailable 定格 → 响亮失败。 */
  async function search(
    query: GrepQuery,
    rootPath: string,
    context: ExecutionToolContext,
    signal: AbortSignal | undefined,
  ): Promise<GrepMatch[]> {
    if (deps.rgPath === undefined) {
      throw new Error(
        unavailableMessage(deps.unavailableReasons ?? ["rg 路径未注入（启动定格为 unavailable）"]),
      );
    }
    return createRgBackend(
      deps.rgPath,
      context.env,
      rootPath,
      { timeoutMs: deps.rgTimeoutMs ?? RG_TIMEOUT_MS },
      signal,
    ).search(query);
  }
}
