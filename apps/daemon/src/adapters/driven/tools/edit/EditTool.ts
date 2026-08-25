import { createHash } from "node:crypto";
import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  fuzzyFindText,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./kernel/edit-diff.js";
import { withFileMutationQueue } from "./kernel/file-mutation-queue.js";
import { buildRecovery, lineOfOffset, renderRecovery } from "./recovery";

/**
 * EditTool —— 自写 edit 外壳（AD-12 方案 C + AF-1 复制收口）。
 *
 * 编辑内核 = ./kernel/（pi-agent-core@0.84.2 纯函数逐字复制，exports 白名单
 * 拦截 import——AF-1 裁决），外壳行为与 pi createEditTool 平权（同名覆盖注册，
 * 平权对照测试以 pi 工具为行为 oracle）。与 pi 的差异只有两处增量：
 * 1. **失败三级推荐管线（F1.4）**：not-found 失败在 kernel 错误原文后附录
 *    「最近似现场（实际内容+行号，失败即 read）+ 按序三建议」；
 * 2. **成功路径挂点**：落盘后投递 notifyWrite（T2.2 KgSyncService 契约签名，
 *    不在写路径跑 sync）+ onEditApplied（T3.2 附着接线预留）。两者可选注入、
 *    容缺空操作、异常吞咽（工具结果不受注入面影响）。
 *
 * 参数契约与 pi edit 同构（path + edits[]；另接受 legacy 单编辑 oldText/newText
 * 形态——pi prepareArguments 语义内联，双路径（直接 execute / harness
 * prepareArguments）均生效）。
 */

/** 写后通知（T2.2 KgSyncService.notifyWrite 契约签名；微秒级入队语义）。 */
export type EditWriteNotify = (projectRoot: string, path: string, hash: string) => void;

/** 成功路径挂点事件（T3.2 附着接线预留：标识符抽取+行号锚定的事实输入）。 */
export interface EditAppliedEvent {
  /** 落盘文件的绝对路径。 */
  readonly filePath: string;
  readonly projectRoot?: string;
  /** 逐编辑事实；editLineStart/End = oldText 在编辑前（base）内容中的 1 起行号。 */
  readonly edits: ReadonlyArray<{
    readonly oldText: string;
    readonly newText: string;
    readonly editLineStart: number;
    readonly editLineEnd: number;
  }>;
  /** 落盘后内容按 \n 切分（含尾换行产生的空尾元素）。 */
  readonly fileLines: readonly string[];
}

/** 门面注入面（组合根装配时填充；全缺省 = 容缺空操作）。 */
export interface EditToolDeps {
  /** 通知归属 projectRoot（与 notifyWrite 成对提供；组合根注入）。 */
  readonly projectRoot?: string;
  /** 写后通知（T2.2 契约签名）；提供且 projectRoot 在位时成功落盘后投递。 */
  readonly notifyWrite?: EditWriteNotify;
  /** 成功路径回调挂点（T3.2 附着接线位）；返回值忽略、异常吞咽。 */
  readonly onEditApplied?: (event: EditAppliedEvent) => void;
}

const editParameters = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
    edits: {
      type: "array",
      description:
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
      items: {
        type: "object",
        properties: {
          oldText: {
            type: "string",
            description:
              "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
          },
          newText: { type: "string", description: "Replacement text for this targeted edit." },
        },
        required: ["oldText", "newText"],
        additionalProperties: false,
      },
    },
  },
  required: ["path", "edits"],
  // 顶层不锁 additionalProperties：legacy 单编辑形态（顶层 oldText/newText）兼容
} as const;

/** legacy 单编辑形态与 JSON 字符串 edits 归一（pi prepareEditArguments 语义）。 */
function normalizeEditInput(input: any): any {
  if (!input || typeof input !== "object") return input;
  const args = { ...input };
  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
    } catch {
      /* 保持原样，走下方 edits 校验报错 */
    }
  }
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    const edits = Array.isArray(args.edits) ? [...args.edits] : [];
    edits.push({ oldText: args.oldText, newText: args.newText });
    delete args.oldText;
    delete args.newText;
    args.edits = edits;
  }
  return args;
}

interface EditItem {
  readonly oldText: string;
  readonly newText: string;
}

function validateEditInput(input: any): { path: string; edits: EditItem[] } {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
  return { path: input.path, edits: input.edits };
}

function editAccessError(path: string, error: { code: string }): Error {
  return new Error(`Could not edit file: ${path}. Error code: ${error.code}.`, { cause: error as unknown as Error });
}

/** not-found 失败装饰：kernel 错误原文 + 三级推荐管线附录（其余类别原样透传）。 */
function decorateNotFoundError(
  error: Error,
  normalizedContent: string,
  edits: readonly EditItem[],
  displayPath: string,
): Error {
  const message = error.message;
  if (!/^Could not find (the exact text|edits\[\d+\])/.test(message)) return error;
  const indexMatch = /edits\[(\d+)\]/.exec(message);
  const failingIndex = indexMatch ? Number(indexMatch[1]) : 0;
  const oldText = normalizeToLF(edits[failingIndex]?.oldText ?? "");
  if (oldText === "") return error;
  const report = buildRecovery(normalizedContent, oldText);
  return new Error(`${message}\n\n${renderRecovery(report, displayPath)}`, { cause: error });
}

/** 自写 edit 工具：内核 kernel/ 纯函数 + 失败推荐管线 + 成功路径挂点。 */
export function createEditTool(
  deps: EditToolDeps = {},
): AgentHarnessTool<ExecutionToolContext, any, any> {
  return {
    name: "edit",
    label: "edit",
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    parameters: editParameters as any,
    prepareArguments: normalizeEditInput as any,
    async execute(_toolCallId, rawInput, signal, _onUpdate, { env }): Promise<AgentToolResult<any>> {
      const { path: filePath, edits } = validateEditInput(normalizeEditInput(rawInput));
      const absoluteResult = await env.absolutePath(filePath, signal);
      if (!absoluteResult.ok) throw absoluteResult.error;
      const absolutePath = absoluteResult.value;
      return withFileMutationQueue(env, absolutePath, async () => {
        if (signal?.aborted) throw new Error("Operation aborted");
        const info = await env.fileInfo(absolutePath, signal);
        if (!info.ok) throw editAccessError(filePath, info.error);
        if (info.value.kind !== "file" && info.value.kind !== "symlink") {
          throw new Error(`Could not edit file: ${filePath}. Path is not a file.`);
        }
        const readResult = await env.readTextFile(absolutePath, signal);
        if (!readResult.ok) throw editAccessError(filePath, readResult.error);
        if (signal?.aborted) throw new Error("Operation aborted");
        const { bom, text: content } = stripBom(readResult.value);
        const originalEnding = detectLineEnding(content);
        const normalizedContent = normalizeToLF(content);
        let baseContent: string;
        let newContent: string;
        try {
          ({ baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, filePath));
        } catch (error) {
          throw decorateNotFoundError(
            error instanceof Error ? error : new Error(String(error)),
            normalizedContent,
            edits,
            filePath,
          );
        }
        if (signal?.aborted) throw new Error("Operation aborted");
        const finalContent = bom + restoreLineEndings(newContent, originalEnding);
        const writeResult = await env.writeFile(absolutePath, finalContent, signal);
        if (!writeResult.ok) throw editAccessError(filePath, writeResult.error);
        if (signal?.aborted) throw new Error("Operation aborted");
        deliverHooks(deps, absolutePath, finalContent, newContent, baseContent, edits);
        const diffResult = generateDiffString(baseContent, newContent);
        return {
          content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${filePath}.` }],
          details: {
            diff: diffResult.diff,
            patch: generateUnifiedPatch(filePath, baseContent, newContent),
            firstChangedLine: diffResult.firstChangedLine,
          },
        };
      });
    },
  };
}

/** 成功路径挂点投递（notifyWrite + onEditApplied）：异常吞咽、永不影响工具结果。 */
function deliverHooks(
  deps: EditToolDeps,
  absolutePath: string,
  finalContent: string,
  newContent: string,
  baseContent: string,
  edits: readonly EditItem[],
): void {
  try {
    if (deps.notifyWrite !== undefined && deps.projectRoot !== undefined) {
      const hash = createHash("sha256").update(finalContent).digest("hex");
      deps.notifyWrite(deps.projectRoot, absolutePath, hash);
    }
    if (deps.onEditApplied !== undefined) {
      const editFacts = edits.map((edit) => {
        const match = fuzzyFindText(baseContent, normalizeToLF(edit.oldText));
        const start = match.found ? lineOfOffset(baseContent, match.index) : 0;
        const end = match.found ? lineOfOffset(baseContent, match.index + match.matchLength - 1) : 0;
        return { oldText: edit.oldText, newText: edit.newText, editLineStart: start, editLineEnd: end };
      });
      deps.onEditApplied({
        filePath: absolutePath,
        ...(deps.projectRoot !== undefined ? { projectRoot: deps.projectRoot } : {}),
        edits: editFacts,
        fileLines: newContent.split("\n"),
      });
    }
  } catch {
    /* 注入面异常不产生工具错误（T3.2「任何失败静默」同口径） */
  }
}
