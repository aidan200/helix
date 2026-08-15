import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_PORT, loadConfig } from "../../src/infrastructure/config";

/**
 * TP-CL1-4（U）：infrastructure/config.ts 配置加载（AD-13）。
 * ① 读 fixture config.json 三字段（model/apiKeys/port）解析正确；
 * ② 文件缺失 → 默认值（port 7333，不抛错）；
 * ③ model 缺失（文件存在但无该字段）→ 抛带中文说明的错误（fail-fast）。
 *
 * fixture 全部落在 tmp 目录，不触碰真实 ~/.helix。
 */
const tmpRoots: string[] = [];

/** 在 tmp 下建一个 home 目录；content 提供时写入 config.json，不提供则只建目录（模拟文件缺失）。 */
function makeFixtureHome(content?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-t11-config-"));
  tmpRoots.push(dir);
  if (content !== undefined) {
    writeFileSync(path.join(dir, "config.json"), content, "utf8");
  }
  return path.join(dir, "config.json");
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("config（TP-CL1-4，AD-13）", () => {
  test("① fixture config.json 三字段解析正确", () => {
    const file = makeFixtureHome(
      JSON.stringify({
        model: "anthropic/claude-sonnet-4-5",
        apiKeys: { anthropic: "sk-test-key" },
        port: 8000,
      }),
    );
    const cfg = loadConfig(file);
    expect(cfg.model).toBe("anthropic/claude-sonnet-4-5");
    expect(cfg.apiKeys).toEqual({ anthropic: "sk-test-key" });
    expect(cfg.port).toBe(8000);
  });

  test("② 文件缺失 → 默认值（port 7333，不抛错）", () => {
    const file = makeFixtureHome(); // 目录存在但 config.json 缺失
    const cfg = loadConfig(file);
    expect(cfg.port).toBe(7333);
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.model).toBeUndefined();
    expect(cfg.apiKeys).toBeUndefined();
  });

  test("③ model 缺失 → 抛带中文说明的错误（fail-fast）", () => {
    const file = makeFixtureHome(JSON.stringify({ port: 7333 }));
    expect(() => loadConfig(file)).toThrow(/model/);
    try {
      loadConfig(file);
      expect.unreachable("model 缺失应抛错");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/[\u4e00-\u9fa5]/); // 错误说明为中文
      expect(msg).toContain(file); // 错误信息指明配置文件路径
    }
  });
});
