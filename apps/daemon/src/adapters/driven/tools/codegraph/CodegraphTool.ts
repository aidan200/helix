import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import { existsSync } from "node:fs";
import path from "node:path";
import type {
  CodegraphEnginePort,
  CodegraphQueryRequest,
} from "../../../../application/ports/outbound/CodegraphEnginePort";
import { codegraphDirPath } from "../../codegraph-engine/codegraph-db-projection";

/**
 * codegraph 工具（W1-B，R5/R6）——代码索引只读查询薄壳，与 KgTool 同构：
 * 参数校验 + projectPath 解析 + 索引缺失短路，余下薄转 engine.runQuery
 * （CLI 旗标映射/超时/截断全在适配器，本文件零 CLI 知识）。
 *
 * - 六 op（R6）：status（索引在不在/新不新鲜）/ search（按名定位符号，
 *   只返回位置）/ node（读符号或文件源码）/ callers / callees（调用关系）
 *   / impact（改动影响面）。**无 explore**；写类 op（init/index/sync）
 *   一律不给 agent——读面绝不触发建索引。
 * - projectPath：工作区一级子目录名（join workspaceRoot）或绝对路径
 *  （含 .codegraph/ 的项目根）；相对路径含分隔符/.. 拒绝（防逃逸一级）。
 * - 索引缺失短路（同 KgProjectService absent 先例）：.codegraph 目录
 *   不在 → 返回「请先构建索引」提示，**不触引擎**（CLI status 本身不建库，
 *   但查询类命令在缺索引项目上的行为不做依赖——短路统一且可测）。
 *
 * 全链路零写（只读保证：本文件无任何写路径；引擎面 runQuery 亦只读）。
 */

const OPS = ["status", "search", "node", "callers", "callees", "impact"] as const;
type Op = (typeof OPS)[number];

const codegraphParameters = {
  type: "object",
  properties: {
    op: {
      type: "string",
      enum: [...OPS],
      description:
        "操作：status 索引状态 / search 按名定位符号（只返回位置）/ node 读符号或文件源码 / callers|callees 调用关系 / impact 改动影响面",
    },
    projectPath: {
      type: "string",
      description: "目标项目：工作区一级子目录名，或含 .codegraph/ 索引的项目根绝对路径",
    },
    pattern: { type: "string", description: "search 符号名（按名字定位，只返回位置）" },
    symbol: { type: "string", description: "node/callers/callees/impact 目标符号名" },
    file: { type: "string", description: "node 文件模式：读文件（带行号 + 依赖面）；与 symbol 同给 = 符号钉到该文件消歧" },
    kind: { type: "string", description: "search 可选：符号类型过滤（function/class 等）" },
    limit: { type: "number", description: "可选：结果上限（search/callers/callees）或文件行数上限（node 文件模式）" },
    depth: { type: "number", description: "impact 可选：影响面遍历深度（默认 2）" },
    offset: { type: "number", description: "node 文件模式可选：1-based 起始行" },
    symbolsOnly: { type: "boolean", description: "node 文件模式可选：只要符号映射 + 依赖面（不带源码全文）" },
  },
  required: ["op", "projectPath"],
  additionalProperties: false,
} as const;

export interface CodegraphToolDeps {
  /** 引擎只读查询面（CLI 映射/超时/截断在适配器；本工具零 CLI 知识）。 */
  readonly engine: Pick<CodegraphEnginePort, "runQuery">;
  /** 工作区根（projectPath 一级子目录名的解析基准）。 */
  readonly workspaceRoot: string;
  /** 索引存在性探测（缺省 = 实查 <root>/.codegraph 目录；测试注入）。 */
  readonly indexExists?: (projectRoot: string) => boolean;
}

/** codegraph 只读工具：注册名 "codegraph"。 */
export function createCodegraphTool(deps: CodegraphToolDeps): AgentHarnessTool<ExecutionToolContext, any, undefined> {
  const indexExists = deps.indexExists ?? ((root: string) => existsSync(codegraphDirPath(root)));
  return {
    name: "codegraph",
    label: "codegraph",
    description:
      "查询项目代码索引（.codegraph，只读——绝不触发建索引）。op 六选：status 看索引在不在/新不新鲜；" +
      "search(pattern) 按名字定位符号（只返回位置）；node(symbol|file) 读符号源码或文件（带行号+依赖面）；" +
      "callers/callees(symbol) 查调用关系；impact(symbol) 查改动影响面。**改代码前先用 impact 查影响面；" +
      "探索结构用 search/node/callers**。projectPath 传工作区一级子目录名或含 .codegraph/ 的绝对路径；" +
      "索引缺失会返回提示——请改用 read/grep，不要尝试自行构建索引。",
    parameters: codegraphParameters as any,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      void toolCallId;
      const p = params as {
        op?: string;
        projectPath?: string;
        pattern?: string;
        symbol?: string;
        file?: string;
        kind?: string;
        limit?: number;
        depth?: number;
        offset?: number;
        symbolsOnly?: boolean;
      };
      const op = p.op as Op;
      if (!OPS.includes(op)) {
        throw new Error(`未知 op "${p.op}"（合法：${OPS.join(" / ")}——无 explore，写类 op 不开放）`);
      }
      const root = resolveProjectRoot(deps.workspaceRoot, p.projectPath);
      if (!indexExists(root)) {
        return text(
          `项目 ${p.projectPath} 尚未建立 codegraph 索引（${codegraphDirPath(root)} 不存在）——` +
            "请先构建索引（构建是用户侧动作，读面绝不触发建索引）；索引进场前改用 read/grep 探索。",
        );
      }
      return text(await deps.engine.runQuery(root, buildRequest(op, p)));
    },
  };
}

/** projectPath 解析：绝对路径原样；一级子目录名 join workspaceRoot；其余拒绝。 */
function resolveProjectRoot(workspaceRoot: string, projectPath: string | undefined): string {
  if (typeof projectPath !== "string" || projectPath.trim() === "") {
    throw new Error("codegraph 需要 projectPath（工作区一级子目录名，或含 .codegraph/ 的项目根绝对路径）");
  }
  if (path.isAbsolute(projectPath)) return projectPath;
  if (projectPath.includes("/") || projectPath.includes("\\") || projectPath === ".." || projectPath === ".") {
    throw new Error(`projectPath "${projectPath}" 非法——相对形态只接受工作区一级子目录名（否则用绝对路径）`);
  }
  return path.join(workspaceRoot, projectPath);
}

/** op → 查询请求（逐 op 参数校验：缺参结构化报错，同 KgTool 先例）。 */
function buildRequest(
  op: Op,
  p: {
    pattern?: string;
    symbol?: string;
    file?: string;
    kind?: string;
    limit?: number;
    depth?: number;
    offset?: number;
    symbolsOnly?: boolean;
  },
): CodegraphQueryRequest {
  switch (op) {
    case "status":
      return { op };
    case "search": {
      if (typeof p.pattern !== "string" || p.pattern.trim() === "") {
        throw new Error("codegraph search 需要 pattern（非空符号名——按名字定位，只返回位置）");
      }
      return {
        op,
        pattern: p.pattern,
        ...(p.kind !== undefined ? { kind: p.kind } : {}),
        ...(p.limit !== undefined ? { limit: p.limit } : {}),
      };
    }
    case "node": {
      const hasSymbol = typeof p.symbol === "string" && p.symbol.trim() !== "";
      const hasFile = typeof p.file === "string" && p.file.trim() !== "";
      if (!hasSymbol && !hasFile) {
        throw new Error("codegraph node 需要 symbol（读符号源码）或 file（读文件，带行号+依赖面）");
      }
      return {
        op,
        ...(hasSymbol ? { symbol: p.symbol! } : {}),
        ...(hasFile ? { file: p.file! } : {}),
        ...(p.offset !== undefined ? { offset: p.offset } : {}),
        ...(p.limit !== undefined ? { limit: p.limit } : {}),
        ...(p.symbolsOnly !== undefined ? { symbolsOnly: p.symbolsOnly } : {}),
      };
    }
    case "callers":
    case "callees": {
      if (typeof p.symbol !== "string" || p.symbol.trim() === "") {
        throw new Error(`codegraph ${op} 需要 symbol（目标符号名）`);
      }
      return { op, symbol: p.symbol, ...(p.limit !== undefined ? { limit: p.limit } : {}) };
    }
    case "impact": {
      if (typeof p.symbol !== "string" || p.symbol.trim() === "") {
        throw new Error("codegraph impact 需要 symbol（目标符号名——改代码前查影响面）");
      }
      return { op, symbol: p.symbol, ...(p.depth !== undefined ? { depth: p.depth } : {}) };
    }
  }
}

function text(body: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: body }], details: undefined };
}
