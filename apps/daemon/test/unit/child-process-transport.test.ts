import { describe, expect, test } from "bun:test";
import { ChildProcessTransport } from "../../src/adapters/driven/subagent/transport/ChildProcessTransport";

/**
 * H8 单元：ChildProcessTransport.readStdout 行回调单行 try/catch 隔离——
 * 一行的回调抛错（非法形状行消费侧崩溃）不应终止整个 stdout 读取循环，
 * 后续行仍须送达（现状异常冒泡到外层 catch，流提前终结）。
 */

function fakeProc(chunks: readonly string[]): unknown {
  const encoder = new TextEncoder();
  return {
    pid: 4242,
    exited: new Promise<number>(() => undefined), // 测试面不 exit
    stdin: { write: () => undefined },
    stdout: (async function* () {
      for (const c of chunks) yield encoder.encode(c);
    })(),
  };
}

describe("H8：readStdout 行回调异常隔离", () => {
  test("某行回调抛错 → 后续行仍送达（循环不被单行异常终止）", async () => {
    const transport = new ChildProcessTransport(
      fakeProc(['{"type":"boom","text":"x"}\n', '{"type":"after","text":"y"}\n']) as never,
    );
    const received: string[] = [];
    const errors: unknown[] = [];
    transport.onLine((line) => {
      const l = line as { type: string };
      if (l.type === "boom") throw new Error("行消费崩溃（注入）");
      received.push(l.type);
    });
    try {
      await transport.drained;
    } catch (e) {
      errors.push(e);
    }
    expect(errors).toEqual([]); // drained 不拒绝
    expect(received).toEqual(["after"]); // boom 行崩溃后 after 行仍送达
  });

  test("正常行序列全送达（回归：隔离不改变既有语义）", async () => {
    const transport = new ChildProcessTransport(
      fakeProc(['{"type":"a"}\n{"type":"b"}\n', '{"type":"c"}\n']) as never,
    );
    const received: string[] = [];
    transport.onLine((line) => received.push((line as { type: string }).type));
    await transport.drained;
    expect(received).toEqual(["a", "b", "c"]);
  });
});
