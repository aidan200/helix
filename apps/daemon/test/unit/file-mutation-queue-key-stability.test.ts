import { describe, expect, test } from "bun:test";
import type { ExecutionEnv } from "../../src/adapters/driven/tools/vendor/pi-harness";
import { BACKGROUND_CONTEXT } from "../../src/adapters/driven/tools/vendor/pi-harness";
import { withFileMutationQueue } from "../../src/adapters/driven/tools/vendor/pi-harness/tools/file-mutation-queue";

/**
 * 队列键跨创建边界稳定性（评审 B13）：目标文件不存在时上游以 absolutePath
 * 作键、存在时以 canonicalPath 作键——同一路径在创建前/后切换点注册落入两条
 * 互不串行队列，edit 读-改-写与 write 落盘交错静默丢更新（helix EditTool/
 * EditLinesTool 直接复用本队列作并发安全底座）。
 *
 * 回归判据：同一路径的两次 mutation 跨「不存在→存在」边界仍串行
 * （前段 end 先于后段 start）；canonical 别名路径（≠abs）与 abs 视角同样串行。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ScriptedEnvSpec {
  existsNow(): boolean;
  /** 存在时的 canonical 视角（模拟 realpath 解析，如 /var → /private/var）。 */
  canonicalOf(abs: string): string;
}

function scriptedEnv(spec: ScriptedEnvSpec): ExecutionEnv {
  return {
    absolutePath: async (p: string) => ({ ok: true as const, value: p.startsWith("/") ? p : `/ws/${p}` }),
    canonicalPath: async (abs: string) =>
      spec.existsNow()
        ? { ok: true as const, value: spec.canonicalOf(abs) }
        : { ok: false as const, error: { code: "not_found" as const, message: "missing" } },
  } as unknown as ExecutionEnv;
}

describe("withFileMutationQueue：队列键跨创建边界稳定（评审 B13 本地补丁回归）", () => {
  test("同一路径「不存在时注册 → 创建后注册」两次 mutation 仍串行", async () => {
    let exists = false;
    let canonical: string | null = null; // 创建瞬间的 canonical 视角（≠abs）
    const env = scriptedEnv({
      existsNow: () => exists,
      canonicalOf: (abs) => canonical ?? abs,
    });

    const order: string[] = [];
    const mutation = async (tag: string) => {
      order.push(`${tag}:start`);
      await sleep(25); // 读-改-写窗口
      order.push(`${tag}:end`);
    };

    // op1（write 新建）：注册时文件不存在 → 键 = absolutePath
    const p1 = withFileMutationQueue(env, "/ws/f.txt", () => mutation("op1"), BACKGROUND_CONTEXT);
    await sleep(5); // op1 已占住队列、fn 在跑
    exists = true; // op1 落盘，文件出现
    canonical = "/ws/../ws/f.txt.canon"; // realpath 解析出不同 canonical 字符串
    // op2（edit 读-改-写）：注册时文件已存在 → 上游键 = canonical ≠ op1 的 abs 键
    const p2 = withFileMutationQueue(env, "/ws/f.txt", () => mutation("op2"), BACKGROUND_CONTEXT);
    await Promise.all([p1, p2]);

    expect(order.indexOf("op1:end")).toBeGreaterThan(-1);
    expect(order.indexOf("op2:start")).toBeGreaterThan(-1);
    // 串行判据：op1 临界区收口先于 op2 进入（并行即丢更新窗口）
    expect(order.indexOf("op1:end")).toBeLessThan(order.indexOf("op2:start"));
  });

  test("既有文件 abs 与 canonical 两种视角并发 → 同队列串行（别名不漏）", async () => {
    const env = scriptedEnv({
      existsNow: () => true,
      canonicalOf: (abs) => `${abs}#canon`,
    });

    const order: string[] = [];
    const mutation = async (tag: string) => {
      order.push(`${tag}:start`);
      await sleep(20);
      order.push(`${tag}:end`);
    };

    const p1 = withFileMutationQueue(env, "/ws/a.txt", () => mutation("abs-view"), BACKGROUND_CONTEXT);
    await sleep(3);
    const p2 = withFileMutationQueue(env, "/ws/a.txt#canon", () => mutation("canon-view"), BACKGROUND_CONTEXT);
    await Promise.all([p1, p2]);

    expect(order.indexOf("abs-view:end")).toBeLessThan(order.indexOf("canon-view:start"));
  });
});
