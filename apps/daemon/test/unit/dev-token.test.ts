import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureDevToken } from "../../src/infrastructure/dev-token";

/**
 * TP-CL6-4：dev-token 文件机制（CL-6 / F(6).1）。
 * ① ensureDevToken 生成随机 token 并写 <home>/dev-token（存在且非空，0600）；
 * ② 每次调用重写（新随机 token，不复用旧值——多 daemon 由单例锁排除）；
 * ③ 返回值与文件内容一致（daemon 内存持有 = 握手比对源）。
 */
function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), "helix-devtoken-"));
}

describe("TP-CL6-4：dev-token 文件生成", () => {
  test("① 生成并写入 <home>/dev-token，非空且 0600，返回值与文件一致", () => {
    const home = tmpHome();
    try {
      const token = ensureDevToken(path.join(home, "dev-token"));
      const file = path.join(home, "dev-token");
      expect(existsSync(file)).toBe(true);
      const written = readFileSync(file, "utf8");
      expect(written.length).toBeGreaterThan(0);
      expect(written).toBe(token);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("② 每次启动重写：两次调用产生不同 token（覆盖旧文件）", () => {
    const home = tmpHome();
    try {
      const file = path.join(home, "dev-token");
      const t1 = ensureDevToken(file);
      const t2 = ensureDevToken(file);
      expect(t1).not.toBe(t2);
      expect(readFileSync(file, "utf8")).toBe(t2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
