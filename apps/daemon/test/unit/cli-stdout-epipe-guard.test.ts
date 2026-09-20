import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { StdoutEventPublisher } from "../../src/adapters/driving/cli/CliAdapter";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { StreamDelta } from "../../src/application/ports/outbound/EventPublisherPort";

/**
 * 修复批 ②（EPIPE 守卫）：CliAdapter stdout 写入全部守卫——
 * writable/destroyed 检查 + try/catch，broken 后标记降级（后续 publish
 * 静默 no-op），任何情况不向上抛。
 *
 * 事故链（2026-09-20 log 05:41:16）：daemon sidecar 形态 stdout 消费端
 * （壳/管道读端）死亡 → process.stdout.write 抛 EPIPE uncaughtException
 * → daemon 崩溃 → 前端重连死锁（连接建立但 daemon 零帧不应答的另一诱因）。
 */

function toolResultEvent(): DomainEvent {
  return {
    type: "tool.call.result",
    sessionId: "s-1",
    payload: { toolName: "bash", isError: false, result: "ok", callId: "tc-1" },
    occurredAt: "2026-09-20T05:41:16.000Z",
  } as unknown as DomainEvent;
}

function delta(text: string): StreamDelta {
  return { messageId: "e5", delta: text };
}

/** 每次写都抛（EPIPE 同步抛路径复现）。 */
function brokenWritable(): NodeJS.WritableStream & { writes: number } {
  return {
    writes: 0,
    write(_chunk: unknown): boolean {
      (this as { writes: number }).writes += 1;
      const err = new Error("write EPIPE") as NodeJS.ErrnoException;
      err.code = "EPIPE";
      throw err;
    },
  } as unknown as NodeJS.WritableStream & { writes: number };
}

describe("修复② StdoutEventPublisher EPIPE 守卫", () => {
  test("write 同步抛 EPIPE → publish 不向上抛；后续 publish 静默降级零写", () => {
    const out = brokenWritable();
    const publisher = new StdoutEventPublisher(out);
    expect(() => publisher.publish(toolResultEvent())).not.toThrow(); // 任何情况不向上抛
    expect(out.writes).toBe(1); // 第一次写真实发生（守卫不吞首次写语义——异常后降级）
    expect(() => publisher.publishDelta(delta("半句"))).not.toThrow();
    expect(out.writes).toBe(1); // 降级后零写（静默 no-op）
    expect(() => publisher.publish(toolResultEvent())).not.toThrow();
    expect(out.writes).toBe(1);
  });

  test("destroyed 流 → 写跳过不抛（broken 检查先行）", () => {
    const out = {
      destroyed: true,
      writes: 0,
      write(): boolean {
        throw new Error("不应触达已销毁流的写面");
      },
    } as unknown as NodeJS.WritableStream & { writes: number; destroyed: boolean };
    const publisher = new StdoutEventPublisher(out);
    expect(() => publisher.publish(toolResultEvent())).not.toThrow();
    expect(out.writes).toBe(0);
  });

  test("writable=false 流 → 写跳过不抛", () => {
    const out = {
      writable: false,
      writes: 0,
      write(): boolean {
        throw new Error("不应触达不可写流的写面");
      },
    } as unknown as NodeJS.WritableStream & { writes: number; writable: boolean };
    const publisher = new StdoutEventPublisher(out);
    expect(() => publisher.publishDelta(delta("流"))).not.toThrow();
    expect(out.writes).toBe(0);
  });

  test("健康流回归：正常写入不降级（多次 publish 均到达）", () => {
    const out = new PassThrough();
    const publisher = new StdoutEventPublisher(out);
    const chunks: string[] = [];
    out.on("data", (c) => chunks.push(String(c)));
    publisher.publish(toolResultEvent());
    publisher.publishDelta(delta("打字机"));
    publisher.publish(toolResultEvent());
    expect(chunks.length).toBe(3);
    expect(chunks.join("")).toContain("[tool] bash 完成");
    expect(chunks.join("")).toContain("打字机");
  });

  test("异步 error 事件（EPIPE 异步投递路径）→ 吸收并降级，不成为 uncaughtException", async () => {
    const out = new PassThrough();
    const publisher = new StdoutEventPublisher(out);
    const chunks: string[] = [];
    out.on("data", (c) => chunks.push(String(c)));
    publisher.publish(toolResultEvent());
    expect(chunks.length).toBe(1);
    // 异步 EPIPE 投递（无 error 监听时将成为进程级 uncaughtException 的路径）
    out.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    await new Promise((r) => setTimeout(r, 5));
    // 降级后不再写
    publisher.publish(toolResultEvent());
    expect(chunks.length).toBe(1);
  });
});
