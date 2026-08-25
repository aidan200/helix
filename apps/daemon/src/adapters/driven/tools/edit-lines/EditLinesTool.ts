import { createHash } from "node:crypto";
import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import {
  detectLineEnding,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "../edit/kernel/edit-diff.js";
import { withFileMutationQueue } from "../edit/kernel/file-mutation-queue.js";
import { numberLine } from "../edit/recovery";
import type { EditWriteNotify } from "../edit/EditTool";

/**
 * EditLinesTool —— 行锚编辑（AD-12，hashline 方向 F-18）。
 *
 * expectedText 与文件现场 [startLine, endLine] 行段**全等**校验（LF 归一后
 * 逐字符比对，含空白不裁剪）；任何漂移拒绝落盘并在失败信息中附「现场」
 * （行段实际内容+行号——与 edit 失败现场同一渲染形态）。匹配则整段替换。
 *
 * 行号供给双路（F-19）：主动链（read 行号输出 / grep path:行号）+ 被动链
 * （edit 失败现场的 startLine 建议）。不强制 read+edit-lines 配对。
 */

/** 注入面（与 EditTool 的 notifyWrite 同一契约；无附着挂点——O-1/AD-4 只挂 edit）。 */
export interface EditLinesToolDeps {
  readonly projectRoot?: string;
  readonly notifyWrite?: EditWriteNotify;
}

const editLinesParameters = {
  type: "object",
  properties: {
    file: { type: "string", description: "Path to the file to edit (relative or absolute)" },
    startLine: {
      type: "integer",
      description: "First line to replace (1-indexed, inclusive)",
      minimum: 1,
    },
    endLine: {
      type: "integer",
      description: "Last line to replace (1-indexed, inclusive; must be >= startLine)",
      minimum: 1,
    },
    expectedText: {
      type: "string",
      description:
        "Exact current content of lines startLine..endLine, LF-joined. Must match the file exactly including all whitespace — any drift rejects the edit (the error carries the actual lines).",
    },
    newText: { type: "string", description: "Replacement text for the line range (may span multiple lines)." },
  },
  required: ["file", "startLine", "endLine", "expectedText", "newText"],
  additionalProperties: false,
} as const;

interface EditLinesInput {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly expectedText: string;
  readonly newText: string;
}

/** 自写 edit-lines 工具：expectedText 全等校验的行号编辑变体。 */
export function createEditLinesTool(
  deps: EditLinesToolDeps = {},
): AgentHarnessTool<ExecutionToolContext, any, any> {
  return {
    name: "edit-lines",
    label: "edit-lines",
    description:
      "Edit a file by line range with an exact-content guard: expectedText must equal the current lines startLine..endLine exactly (including whitespace) or the edit is rejected with the actual lines shown. Replacement text may span a different number of lines. Get line numbers from read output or the scene of a failed edit.",
    parameters: editLinesParameters as any,
    async execute(_toolCallId, params, signal, _onUpdate, { env }): Promise<AgentToolResult<any>> {
      const input = params as EditLinesInput;
      const { file, startLine, endLine, expectedText, newText } = input;
      if (!Number.isInteger(startLine) || startLine < 1) {
        throw new Error("startLine must be an integer >= 1 (1-based line numbers).");
      }
      if (!Number.isInteger(endLine) || endLine < startLine) {
        throw new Error("endLine must be an integer >= startLine.");
      }
      const absoluteResult = await env.absolutePath(file, signal);
      if (!absoluteResult.ok) throw absoluteResult.error;
      const absolutePath = absoluteResult.value;
      return withFileMutationQueue(env, absolutePath, async () => {
        if (signal?.aborted) throw new Error("Operation aborted");
        const info = await env.fileInfo(absolutePath, signal);
        if (!info.ok) {
          throw new Error(`Could not edit file: ${file}. Error code: ${info.error.code}.`, {
            cause: info.error as Error,
          });
        }
        if (info.value.kind !== "file" && info.value.kind !== "symlink") {
          throw new Error(`Could not edit file: ${file}. Path is not a file.`);
        }
        const readResult = await env.readTextFile(absolutePath, signal);
        if (!readResult.ok) {
          throw new Error(`Could not edit file: ${file}. Error code: ${readResult.error.code}.`, {
            cause: readResult.error as Error,
          });
        }
        const { bom, text: content } = stripBom(readResult.value);
        const originalEnding = detectLineEnding(content);
        const lf = normalizeToLF(content);
        const lines = lf.split("\n");
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        if (endLine > lines.length) {
          throw new Error(
            `endLine ${endLine} is beyond end of file (${lines.length} lines total) in ${file}.`,
          );
        }
        const actual = lines.slice(startLine - 1, endLine).join("\n");
        const expected = normalizeToLF(expectedText);
        if (actual !== expected) {
          // 失败现场：行段实际内容+行号（与 edit 失败现场同渲染形态——被动链供养）
          const scene = lines
            .slice(startLine - 1, endLine)
            .map((line, i) => numberLine(startLine + i, line))
            .join("\n");
          throw new Error(
            `edit-lines: expectedText does not match ${file} lines ${startLine}-${endLine} ` +
              "(must match exactly, including whitespace; line endings are LF-normalized).\n" +
              `Actual content:\n${scene}\n` +
              "Rewrite expectedText from the actual lines above (copy the text after the line numbers), or read the range first.",
          );
        }
        const replacementLines = normalizeToLF(newText).split("\n");
        const nextLines = [...lines.slice(0, startLine - 1), ...replacementLines, ...lines.slice(endLine)];
        const hadTrailingNewline = lf.endsWith("\n");
        const newLf = nextLines.join("\n") + (hadTrailingNewline ? "\n" : "");
        const finalContent = bom + restoreLineEndings(newLf, originalEnding);
        const writeResult = await env.writeFile(absolutePath, finalContent, signal);
        if (!writeResult.ok) {
          throw new Error(`Could not edit file: ${file}. Error code: ${writeResult.error.code}.`, {
            cause: writeResult.error as Error,
          });
        }
        deliverNotify(deps, absolutePath, finalContent);
        const diffResult = generateDiffString(lf, newLf);
        return {
          content: [
            { type: "text", text: `Successfully replaced lines ${startLine}-${endLine} in ${file}.` },
          ],
          details: {
            diff: diffResult.diff,
            patch: generateUnifiedPatch(file, lf, newLf),
            firstChangedLine: diffResult.firstChangedLine,
          },
        };
      });
    },
  };
}

/** 写后通知投递（同 EditTool 契约）：异常吞咽、永不影响工具结果。 */
function deliverNotify(deps: EditLinesToolDeps, absolutePath: string, finalContent: string): void {
  try {
    if (deps.notifyWrite !== undefined && deps.projectRoot !== undefined) {
      const hash = createHash("sha256").update(finalContent).digest("hex");
      deps.notifyWrite(deps.projectRoot, absolutePath, hash);
    }
  } catch {
    /* 注入面异常不产生工具错误 */
  }
}
