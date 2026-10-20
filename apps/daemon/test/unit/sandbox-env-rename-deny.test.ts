import { describe, expect, test } from "bun:test";
import { wrapEnvForSandbox } from "../../src/adapters/driven/tools/SandboxEnvWrap";
import type { SandboxRuntime } from "../../src/adapters/driven/tools/SandboxEnvWrap";

/**
 * SandboxEnvWrap.renameFile 拒绝归因（低危批）：
 *
 * 双端校验里「源越界」却按目标路径回执，会让目标在可写根内的调用方按错误
 * 方向排障（文案说目标不可写、实际是源越界）。修复后逐端判定、拒在越界端。
 */

const ROOT = "/workspace";

function runtime(): SandboxRuntime {
  return {
    policy: { mode: "on", writableRoots: [ROOT] },
  } as unknown as SandboxRuntime;
}

/** 最小 env 替身：只需 absolutePath / renameFile（其余面本测试不触）。 */
function fakeEnv(calls: string[]) {
  return {
    cwd: ROOT,
    async absolutePath(p: string) {
      return { ok: true as const, value: p.startsWith("/") ? p : `${ROOT}/${p}` };
    },
    async renameFile(source: string, dest: string) {
      calls.push(`${source}->${dest}`);
      return { ok: true as const, value: undefined };
    },
  };
}

const context = {} as never;

describe("wrapEnvForSandbox.renameFile 拒绝归因", () => {
  test("① 源越界 + 目标可写 → 拒绝文案指向源（不再误报目标）", async () => {
    const calls: string[] = [];
    const wrapped = wrapEnvForSandbox(fakeEnv(calls) as never, runtime()) as never as {
      renameFile(s: string, d: string, c: unknown): Promise<{ ok: boolean; error?: { path: string; message: string } }>;
    };
    const res = await wrapped.renameFile("/etc/passwd", `${ROOT}/moved.txt`, context);
    expect(res.ok).toBe(false);
    expect(res.error?.path).toBe("/etc/passwd");
    expect(res.error?.message).toContain("/etc/passwd");
    expect(res.error?.message).not.toContain(`${ROOT}/moved.txt`);
    expect(calls).toEqual([]); // 未执行真实 rename
  });

  test("② 双端都在可写根内 → 放行执行", async () => {
    const calls: string[] = [];
    const wrapped = wrapEnvForSandbox(fakeEnv(calls) as never, runtime()) as never as {
      renameFile(s: string, d: string, c: unknown): Promise<{ ok: boolean }>;
    };
    const res = await wrapped.renameFile(`${ROOT}/a.ts`, `${ROOT}/b.ts`, context);
    expect(res.ok).toBe(true);
    expect(calls).toEqual([`${ROOT}/a.ts->${ROOT}/b.ts`]);
  });

  test("③ 目标越界 → 拒绝文案指向目标", async () => {
    const calls: string[] = [];
    const wrapped = wrapEnvForSandbox(fakeEnv(calls) as never, runtime()) as never as {
      renameFile(s: string, d: string, c: unknown): Promise<{ ok: boolean; error?: { path: string } }>;
    };
    const res = await wrapped.renameFile(`${ROOT}/a.ts`, "/etc/target", context);
    expect(res.ok).toBe(false);
    expect(res.error?.path).toBe("/etc/target");
    expect(calls).toEqual([]);
  });
});
