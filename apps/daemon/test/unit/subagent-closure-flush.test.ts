import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { writeLineAndFlush } from "../../src/adapters/driven/subagent/child/ChildMain";
import { encodeLine, type ChildOutboundLine } from "../../src/adapters/driven/subagent/transport/wire";

/**
 * M3 修复（task-8213de82 review #2.12）：closure 行 process.stdout.write 后
 * 立即 process.exit(0)，管道写未 await flush——大 closure / 管道繁忙时
 * 截断丢失（本仓已有 closure 截断事故史 task-778eb18a）。
 * writeLineAndFlush = 写行并等待 flush 回调再返回，exit 前置保证。
 */

describe("writeLineAndFlush：closure 大载荷 await flush 再 exit", () => {
  test("背压下 promise 悬置，排空后才 resolve——载荷全量一致零截断", async () => {
    const stream = new PassThrough({ highWaterMark: 16 }); // 微缓冲强制背压
    const bigSummary = "成".repeat(300 * 1024); // ~900KB UTF-8 大载荷
    const line: ChildOutboundLine = {
      type: "closure",
      instanceId: "agent-t",
      closure: { status: "done", summary: bigSummary, reportPath: null, findings: null, taskId: null },
    };

    let flushed = false;
    const p = writeLineAndFlush(line, stream).then(() => {
      flushed = true;
    });

    // 无人消费 → 背压 → flush 回调不触发（若直接 exit 此处即截断点）
    await new Promise((r) => setTimeout(r, 50));
    expect(flushed).toBe(false);

    // 排空管道 → flush 完成；逐 chunk 收字节（收齐后一次性解码，
    // 避免测试自身在 chunk 边界切坏多字节字符）
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    await p;
    expect(flushed).toBe(true);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(encodeLine(line));
  });

  test("小载荷正常路径：flush 后 resolve，行字节等于 encodeLine", async () => {
    const stream = new PassThrough();
    const line: ChildOutboundLine = { type: "log", instanceId: "agent-t", text: "ok" };
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    await writeLineAndFlush(line, stream);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(encodeLine(line));
  });
});
