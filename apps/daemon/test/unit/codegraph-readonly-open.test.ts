import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodegraphReadonly } from "../../src/adapters/driven/codegraph-engine/codegraph-db-projection";

/**
 * codegraph 只读打开失败诊断（低危批）：两条通道（plain-ro → immutable URI）
 * 都失败时，抛出的错误必须同时携带两段原因——首因被 catch{} 吞掉时，degraded
 * 诊断只剩回退尝试的错误（真实首因如库缺失/权限丢失），排障全靠猜。
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "helix-cg-open-"));
  dirs.push(d);
  return d;
}

describe("openCodegraphReadonly（打开失败诊断面）", () => {
  test("① 库文件不存在 → 抛错含「plain-ro 首因」与「immutable URI 回退」双段原因", () => {
    const missing = join(tmpDir(), "no-such-codegraph.db");
    let message = "";
    try {
      openCodegraphReadonly(missing);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("codegraph 库只读打开失败");
    expect(message).toContain("plain-ro 首因");
    expect(message).toContain("immutable URI 回退");
    // 首因不是空串（旧实现此位恒丢失）
    expect(message).not.toContain("plain-ro 首因 undefined");
  });

  test("② 路径是目录（两通道都打不开）→ 同样合并双因，报错带库路径便于定位", () => {
    const dir = tmpDir();
    let message = "";
    try {
      openCodegraphReadonly(dir);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("plain-ro 首因");
    expect(message).toContain("immutable URI 回退");
    expect(message).toContain(dir);
  });
});
