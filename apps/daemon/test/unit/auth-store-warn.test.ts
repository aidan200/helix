import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStore } from "../../src/infrastructure/auth-store";

/**
 * T1.3 单元（TP-1.3a #5）：auth-store.ts:241 排队链尾吞错可观测（源
 * R-2.3——`this.opQueue = run.catch(() => undefined)` 保持「失败不断链」
 * 语义，但同时抑制了全部 rejection 告警：丢弃返回 promise 的场景错误
 * 完全无声）。改 warn 后：
 * ① 失败 op → logger.warn 含 [auth-store] 定位 + 错误信息；
 * ② 调用方仍见错误（run 照常拒绝——「调用方可观测」面不变）；
 * ③ 队列继续（失败后下一个 op 正常执行——「失败不断链」语义保持）。
 *
 * spy logger 是观察面非替身（TP-1.3c）；被测单元 AuthStore 不 mock。
 */

describe("TP-1.3a #5 AuthStore.enqueue 链尾失败 → logger.warn", () => {
  test("损坏 JSON 读取失败：调用方见 reject + warn 含 [auth-store]；后续 op 队列继续", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t13-auth-"));
    try {
      const filePath = path.join(home, "auth.json");
      writeFileSync(filePath, "{ 这不是合法 JSON", "utf8");
      const warns: string[] = [];
      const store = new AuthStore(filePath, { warn: (m) => warns.push(m) });

      // ① 调用方仍见错误（reject 面不变）
      await expect(store.readAll()).rejects.toThrow("不是合法 JSON");

      // ② 链尾 catch 的 warn 到达（微任务）
      await new Promise((r) => setTimeout(r, 10));
      const msg = warns.find((m) => m.includes("[auth-store]"));
      expect(msg).toBeDefined();
      expect(msg!.includes("不是合法 JSON")).toBe(true);

      // ③ 失败不断链：修复文件后下一个 op 正常执行
      writeFileSync(filePath, "{}", "utf8");
      const table = await store.readAll();
      expect(table).toEqual({});
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
