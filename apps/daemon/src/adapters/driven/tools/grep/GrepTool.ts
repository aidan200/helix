import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import { createTsBackend } from "./backends/ts-backend";
import {
  createRgBackend,
  RG_TIMEOUT_MS,
  RgExecError,
  RgTimeoutError,
} from "./backends/rg-backend";
import type { GrepMatch, GrepQuery } from "./contract";

/**
 * GrepTool —— grep 工具门面（AD-10；CL-3 域目录化，architecture §5.1）。
 *
 * 对引擎暴露的接口形状不变：AgentHarnessTool 形态、手写参数 schema
 * （pattern/path/glob/ignoreCase 四键）、输出格式 `path:行号: 行内容` /
 * `(no matches for "...")` 文案——既有工具契约零变化。
 *
 * 门面只做后端接线与输出格式化，不含匹配逻辑（匹配核在
 * backends/ts-backend.ts）。后端选择编排（T1.3，AF-1 启动定格语义）：
 * - **启动定格**：组合根一次性 resolve + 探针的产物经 deps.rgPath 注入
 *   （见 freeze-backend.ts）；缺省 = 定格内置 TS。门面运行期只读内存
 *   标识选后端——零解析、零探针、零逐次降级判断。
 * - **首败永久降级**：定格 rg 时某次调用抛 RgExecError/RgTimeoutError
 *   → 当轮用 ts 重跑同一查询返回结果（不向 agent 抛错）+ warning 日志
 *   一次 + 内存标识翻转为 ts（此后直走 ts，无任何代码路径翻回）。
 *   非降级类错误（如空 pattern 语义错）原样抛出，不吞咽不翻转。
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

/** 门面注入面（组合根装配时填充；全缺省 = 定格内置 TS）。 */
export interface GrepToolDeps {
  /**
   * 启动定格的 rg 路径（AF-1：freeze-backend 产物；提供 = 定格 rg 后端，
   * 缺省 = 定格内置 TS）。运行期零重新解析。
   */
  readonly rgPath?: string;
  /** 降级 warning 日志面（首败翻转时记录一次；只进日志面，对 agent 无感）。 */
  readonly warn?: (message: string) => void;
  /** rg 单次检索超时上限覆盖（测试注入面；缺省 RG_TIMEOUT_MS=10s）。 */
  readonly rgTimeoutMs?: number;
}

/** 自写 grep 工具：实现 core 的 Tool 接口（AgentHarnessTool 形态）。 */
export function createGrepTool(deps: GrepToolDeps = {}): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  /** 内存标识（AF-1）：非 undefined = 定格 rg；首败翻转为 undefined（永久降级，无翻回路径）。 */
  let rgPath = deps.rgPath;
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
      const query: GrepQuery = { pattern, glob, ignoreCase };
      const matches = await search(query, path, context, signal);
      const text =
        matches.length > 0
          ? matches.map((m) => `${m.path}:${m.lineNumber}: ${m.line}`).join("\n")
          : `(no matches for "${pattern}")`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  };

  /** 后端分流：只读内存标识；rg 首败 → 当轮 ts 重跑 + warning + 永久翻转。 */
  async function search(
    query: GrepQuery,
    rootPath: string,
    context: ExecutionToolContext,
    signal: AbortSignal | undefined,
  ): Promise<GrepMatch[]> {
    if (rgPath === undefined) {
      return createTsBackend(context.env, rootPath, signal).search(query);
    }
    const rg = createRgBackend(rgPath, context.env, rootPath, { timeoutMs: deps.rgTimeoutMs ?? RG_TIMEOUT_MS }, signal);
    try {
      return await rg.search(query);
    } catch (e) {
      if (e instanceof RgExecError || e instanceof RgTimeoutError) {
        deps.warn?.(`grep rg 后端首败（${e.name}），当轮回退内置 TS 后端并永久降级：${e.message}`);
        rgPath = undefined; // 永久翻转：此后直走 ts，零判断（AF-1 机械判据）
        return createTsBackend(context.env, rootPath, signal).search(query);
      }
      throw e; // 非降级类错误（如空 pattern 语义错）原样抛出
    }
  }
}
