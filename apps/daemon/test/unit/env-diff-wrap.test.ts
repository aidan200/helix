import { describe, expect, test } from "bun:test";
import { wrapEnvForDiff, type EnvWriteHook, type EnvWriteTarget } from "../../src/adapters/driven/tools/TurnDiffEnvWrap";

/**
 * T2 轮次级内存态 diff——env.writeFile 写前快照包装单测：
 * - spread 语义包装（原型方法存活——NodeExecutionEnv 是 class，纯 spread
 *   会丢原型方法，包装须保原型继承）；
 * - writeFile 前 hook 触发（写前快照时序：hook 看到的是旧内容）；
 * - hook 异常吞咽（diff 失败不影响写入）；
 * - 无 hook 时行为零差（原样返回）。
 */

/** 假 env：文件表 + 原型方法（模拟 NodeExecutionEnv 的 class 形态）。 */
class FakeEnv implements EnvWriteTarget {
  readonly files = new Map<string, string>();
  writeCalls: { path: string; content: string }[] = [];

  constructor(readonly cwd = "/w") {}

  async readTextFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async writeFile(path: string, content: string | Uint8Array): Promise<{ ok: true }> {
    this.writeCalls.push({ path, content: typeof content === "string" ? content : "<bytes>" });
    this.files.set(path, typeof content === "string" ? content : "<bytes>");
    return { ok: true };
  }
  async someOtherMethod(x: number): Promise<number> {
    return x * 2; // 原型方法存活断言锚
  }
}

describe("① 写前 hook 收到旧内容（写前快照时序）", () => {
  test("hook 先于 base.writeFile 执行——读到的是写前原文", async () => {
    const env = new FakeEnv();
    env.files.set("/w/a.txt", "OLD");
    const seen: (string | null)[] = [];
    const order: string[] = [];
    const hook: EnvWriteHook = async (path) => {
      order.push("hook");
      seen.push(await env.readTextFile(path));
    };
    const wrapped = wrapEnvForDiff(env, hook);

    const res = await wrapped.writeFile("/w/a.txt", "NEW");
    expect(res).toEqual({ ok: true });
    expect(order).toEqual(["hook"]);
    expect(seen).toEqual(["OLD"]); // 写前原文，非 NEW
    expect(env.files.get("/w/a.txt")).toBe("NEW");
    expect(env.writeCalls).toEqual([{ path: "/w/a.txt", content: "NEW" }]);
  });

  test("hook 收到目标内容（content 透传——SubAgent 元数据上报面）", async () => {
    const env = new FakeEnv();
    const contents: (string | Uint8Array)[] = [];
    const wrapped = wrapEnvForDiff(env, (path, content) => {
      void path;
      contents.push(content);
    });
    await wrapped.writeFile("/w/b.txt", "PAYLOAD");
    expect(contents).toEqual(["PAYLOAD"]);
  });
});

describe("② hook 抛错不影响写入", () => {
  test("hook 同步/异步抛错均吞咽——writeFile 照常落盘并返回 base 结果", async () => {
    const env = new FakeEnv();
    const syncBoom: EnvWriteHook = () => {
      throw new Error("hook sync boom");
    };
    const w1 = wrapEnvForDiff(env, syncBoom);
    const r1 = await w1.writeFile("/w/x.txt", "1");
    expect(r1).toEqual({ ok: true });
    expect(env.files.get("/w/x.txt")).toBe("1");

    const asyncBoom: EnvWriteHook = async () => {
      throw new Error("hook async boom");
    };
    const w2 = wrapEnvForDiff(env, asyncBoom);
    const r2 = await w2.writeFile("/w/y.txt", "2");
    expect(r2).toEqual({ ok: true });
    expect(env.files.get("/w/y.txt")).toBe("2");
  });
});

describe("③ 无 hook 时行为零差", () => {
  test("hook 缺省 → 原样返回同一 env 实例（零包装）", () => {
    const env = new FakeEnv();
    expect(wrapEnvForDiff(env, undefined)).toBe(env);
  });
});

describe("④ 包装保原型（spread 陷阱防御）", () => {
  test("class env 包装后原型方法仍可用、own 字段保留、writeFile 被覆写", async () => {
    const env = new FakeEnv();
    const wrapped = wrapEnvForDiff(env, () => {});
    expect(wrapped).not.toBe(env);
    expect(wrapped.cwd).toBe("/w"); // own 字段保留
    await expect(wrapped.someOtherMethod(21)).resolves.toBe(42); // 原型方法存活
    const hookSeen: string[] = [];
    const wrapped2 = wrapEnvForDiff(env, (p) => void hookSeen.push(p));
    await wrapped2.writeFile("/w/z.txt", "z");
    expect(hookSeen).toEqual(["/w/z.txt"]); // writeFile 已被覆写（hook 生效）
  });
});
