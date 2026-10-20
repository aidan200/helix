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

/** 原始字节 chunk 版（多字节字符跨 chunk 边界剧本）。 */
function fakeProcBytes(chunks: readonly Uint8Array[]): unknown {
  return {
    pid: 4242,
    exited: new Promise<number>(() => undefined),
    stdin: { write: () => undefined },
    stdout: (async function* () {
      for (const c of chunks) yield c;
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

  test("多字节字符跨 chunk 边界不损坏（decode {stream:true}）", async () => {
    const text = "你好世界🌍";
    const raw = JSON.stringify({ type: "log", instanceId: "agent-t", text }) + "\n";
    const bytes = new TextEncoder().encode(raw);
    // 两个切点：一个落在「你」（3 字节 UTF-8）中间，一个落在 emoji（4 字节）中间
    const cut1 = bytes.indexOf(0xe4) + 1; // 「你」首字节后切开
    const emojiStart = bytes.indexOf(0xf0);
    const cut2 = emojiStart + 2; // emoji 前两字节后切开
    const transport = new ChildProcessTransport(
      fakeProcBytes([bytes.subarray(0, cut1), bytes.subarray(cut1, cut2), bytes.subarray(cut2)]) as never,
    );
    const received: string[] = [];
    transport.onLine((line) => received.push((line as { type: string; text: string }).text));
    await transport.drained;
    expect(received).toEqual([text]); // 无 U+FFFD、行未被丢弃
  });
});

// ── stdin 写失败承接（低危批） ──

describe("stdin 写失败承接", () => {
  /** stdin 同步抛错的假 proc（管道已关形态）。 */
  function procWithThrowingStdin(writes: string[]): unknown {
    return {
      pid: 4243,
      exited: new Promise<number>(() => undefined),
      stdin: {
        write: (s: string) => {
          writes.push(s);
          throw new Error("EPIPE: broken pipe");
        },
      },
      stdout: (async function* () {
        /* 空流 */
      })(),
    };
  }

  test("stdin.write 同步抛 → 不冒泡（写面尽力语义），且坏管道不再重复试探", () => {
    const writes: string[] = [];
    const transport = new ChildProcessTransport(procWithThrowingStdin(writes) as never);
    expect(() => transport.send("第一次")).not.toThrow();
    expect(() => transport.send("第二次")).not.toThrow(); // 已置坏：短路，不再写
    expect(writes).toEqual([expect.stringContaining("第一次")]);
  });

  test("stdin 挂 on 面 → error 事件置坏后不再写（EPIPE 异步形态）", () => {
    const writes: string[] = [];
    let onError: ((e: unknown) => void) | undefined;
    const proc = {
      pid: 4244,
      exited: new Promise<number>(() => undefined),
      stdin: {
        write: (s: string) => writes.push(s),
        on: (event: string, cb: (e: unknown) => void) => {
          if (event === "error") onError = cb;
        },
      },
      stdout: (async function* () {
        /* 空流 */
      })(),
    };
    const transport = new ChildProcessTransport(proc as never);
    transport.send("之前");
    onError?.(new Error("EPIPE"));
    transport.send("之后");
    expect(writes.length).toBe(1);
  });
});
