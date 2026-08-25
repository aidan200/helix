import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";

/**
 * ReadTool —— 自写 read（AD-12，同名覆盖 pi 内置）。
 *
 * 与 pi read 的契约差异仅一处：文本输出带 cat -n 风格行号（`%6d\t%s`）——
 * 主动链行号供给（grep/read 供养 edit-lines 行锚），并与自写 edit 的 ③级
 * 「行号前缀剥离」互为防御（read 输出直接作 oldText 时 edit 可剥前缀重匹配）。
 * 其余契约同构：offset（1 起行号）/limit、截断上限与续读指针、图片文件
 * （jpg/png/gif/webp/bmp → image 内容块）、offset 越界报错文案。
 */

/** 截断上限（与 pi read 文档口径一致：2000 行 / 50KB）。 */
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

const readParameters = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to read (relative or absolute)" },
    offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
    limit: { type: "number", description: "Maximum number of lines to read" },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

/** 自写 read 工具：行号输出（%6d\t%s）。 */
export function createReadTool(): AgentHarnessTool<ExecutionToolContext, any, any> {
  return {
    name: "read",
    label: "read",
    description:
      `Read the contents of a file with line numbers (cat -n style: "%6d\\t%s" — the line-number prefix can be reused as edit-lines anchors). ` +
      `Supports text files and images (jpg, png, gif, webp, bmp; images are sent as attachments). ` +
      `Text output is truncated to ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files.`,
    parameters: readParameters as any,
    async execute(_toolCallId, params, signal, _onUpdate, { env }): Promise<AgentToolResult<any>> {
      const { path: filePath, offset, limit } = params as { path: string; offset?: number; limit?: number };
      const absoluteResult = await env.absolutePath(filePath, signal);
      if (!absoluteResult.ok) throw absoluteResult.error;
      const bytesResult = await env.readBinaryFile(absoluteResult.value, signal);
      if (!bytesResult.ok) {
        throw new Error(`Could not read file: ${filePath}. Error code: ${bytesResult.error.code}.`, {
          cause: bytesResult.error as Error,
        });
      }
      const bytes = bytesResult.value;
      const mimeType = detectImageMimeType(bytes);
      if (mimeType !== undefined) {
        return {
          content: [
            { type: "text", text: `Read image file [${mimeType}]` },
            { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType },
          ],
          details: undefined,
        };
      }
      const text = new TextDecoder().decode(bytes);
      const allLines = text.split("\n");
      // 末尾换行不产生额外空行（cat -n 语义；与 edit/edit-lines 行号口径一致）
      if (allLines.length > 1 && allLines[allLines.length - 1] === "") allLines.pop();
      const totalLines = allLines.length;
      const startLine = offset !== undefined ? Math.max(0, offset - 1) : 0;
      if (offset !== undefined && startLine >= totalLines) {
        throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
      }
      const userEnd = limit !== undefined ? Math.min(startLine + limit, totalLines) : totalLines;
      const rendered: string[] = [];
      let usedBytes = 0;
      let lineNo = startLine + 1;
      for (let i = startLine; i < userEnd; i++, lineNo++) {
        const numbered = `${String(lineNo).padStart(6, " ")}\t${allLines[i]}`;
        const lineBytes = Buffer.byteLength(numbered, "utf8") + 1;
        // 预算截断（行/字节先到先截；首行必含——不产出空结果）
        if (rendered.length > 0 && (rendered.length >= MAX_LINES || usedBytes + lineBytes > MAX_BYTES)) {
          break;
        }
        rendered.push(numbered);
        usedBytes += lineBytes;
      }
      let output = rendered.join("\n");
      const lastShown = startLine + rendered.length; // 0 起末行索引
      if (lastShown < totalLines) {
        output += `\n\n[Showing lines ${startLine + 1}-${lastShown} of ${totalLines}. Use offset=${lastShown + 1} to continue.]`;
      }
      return { content: [{ type: "text", text: output }], details: undefined };
    },
  };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 图片魔数探测（jpg/png/gif/webp/bmp；png 排除 aPNG——pi image.js 语义的简化面）。 */
function detectImageMimeType(buffer: Uint8Array): string | undefined {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return buffer[3] === 0xf7 ? undefined : "image/jpeg";
  if (startsWith(buffer, PNG_SIGNATURE) && readAscii(buffer, 12, 4) === "IHDR") {
    return isAnimatedPng(buffer) ? undefined : "image/png";
  }
  const head = readAscii(buffer, 0, 6);
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (readAscii(buffer, 0, 4) === "RIFF" && readAscii(buffer, 8, 4) === "WEBP") return "image/webp";
  if (readAscii(buffer, 0, 2) === "BM" && buffer.length >= 26) return "image/bmp";
  return undefined;
}

function startsWith(buffer: Uint8Array, prefix: number[]): boolean {
  return prefix.every((byte, i) => buffer[i] === byte);
}

function readAscii(buffer: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = offset; i < offset + length && i < buffer.length; i++) {
    out += String.fromCharCode(buffer[i]!);
  }
  return out;
}

/** aPNG 探测（acTL 块先于 IDAT 出现即动画——pi image.js 同语义）。 */
function isAnimatedPng(buffer: Uint8Array): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const chunkLength = readUint32BE(buffer, offset);
    const chunkType = readAscii(buffer, offset + 4, 4);
    if (chunkType === "acTL") return true;
    if (chunkType === "IDAT") return false;
    const next = offset + 8 + chunkLength + 4;
    if (next <= offset || next > buffer.length) return false;
    offset = next;
  }
  return false;
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset] ?? 0) * 0x1000000 +
    ((buffer[offset + 1] ?? 0) << 16) +
    ((buffer[offset + 2] ?? 0) << 8) +
    (buffer[offset + 3] ?? 0)
  );
}
