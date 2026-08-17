import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_PORT, loadConfig } from "../../src/infrastructure/config";

/**
 * TP-CL1-4（U）+ T2.3（AD-2 瘦身）：infrastructure/config.ts 配置加载。
 * ① 瘦身形态四字段（port/maxConcurrent/maxQueued/staticDir）解析正确；
 * ② 文件缺失 → 默认值（port 7333，不抛错）；
 * ③ model 缺失不再 fail-fast（AD-2：模型位迁 SQLite + auth.json）；
 * ④ 旧格式 model/apiKeys → legacy 读面（组合根迁移入参，不报错不丢字段）。
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

describe("config（TP-CL1-4 + T2.3 AD-2 瘦身）", () => {
  test("① fixture config.json 四字段解析正确", () => {
    const file = makeFixtureHome(
      JSON.stringify({ port: 8000, maxConcurrent: 5, maxQueued: 10, staticDir: "/tmp/static" }),
    );
    const { config, legacy } = loadConfig(file);
    expect(config).toEqual({ port: 8000, maxConcurrent: 5, maxQueued: 10, staticDir: "/tmp/static" });
    expect(legacy).toEqual({}); // 瘦身形态无遗留位
  });

  test("② 文件缺失 → 默认值（port 7333，不抛错）", () => {
    const file = makeFixtureHome(); // 目录存在但 config.json 缺失
    const { config } = loadConfig(file);
    expect(config.port).toBe(7333);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.staticDir).toBeUndefined();
  });

  test("③ model 缺失不再 fail-fast（AD-2 取代：模型位迁 SQLite 默认表）", () => {
    const file = makeFixtureHome(JSON.stringify({ port: 7333 }));
    const { config } = loadConfig(file);
    expect(config.port).toBe(7333); // 正常加载，无中文报错
  });

  test("④ 旧格式 model/apiKeys → legacy 读面（迁移入参；非法值静默丢弃）", () => {
    const file = makeFixtureHome(
      JSON.stringify({
        model: "anthropic/claude-sonnet-4-5",
        apiKeys: { anthropic: "sk-test-key", broken: 123 },
        port: 7333,
      }),
    );
    const { config, legacy } = loadConfig(file);
    expect(config.port).toBe(7333);
    expect(legacy.model).toBe("anthropic/claude-sonnet-4-5");
    expect(legacy.apiKeys).toEqual({ anthropic: "sk-test-key" }); // 非 string 值丢弃
  });

  test("⑤ 旧格式空 model/空 apiKeys → legacy 视为无遗留（幂等迁移判定）", () => {
    const file = makeFixtureHome(JSON.stringify({ model: "", apiKeys: {}, port: 7333 }));
    const { legacy } = loadConfig(file);
    expect(legacy.model).toBeUndefined();
    expect(legacy.apiKeys).toBeUndefined();
  });
});
