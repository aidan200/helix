import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { createPaths, resolveHome } from "../../src/infrastructure/paths";

/**
 * TP-CL1-3（U）：infrastructure/paths.ts 路径解析单点（AD-14）。
 * ① 默认展开 ~/.helix；② --home <dir> 覆盖后全部派生路径指向该目录；
 * ③ 派生路径均为 path.join 产物（路径分隔符合法）。
 *
 * 注：测试用 os.homedir() 计算期望值（src/ 内唯一调用点仍收束于 paths.ts，
 * 由 structure.test.ts 的 AG-07 断言守护）。
 */
describe("paths（TP-CL1-3，AD-14）", () => {
  test("① 默认展开 ~/.helix", () => {
    const expectedHome = path.join(os.homedir(), ".helix");
    expect(resolveHome()).toBe(expectedHome);
    expect(createPaths().home).toBe(expectedHome);
  });

  test("② --home /tmp/x 覆盖后全部派生路径指向 tmp", () => {
    const p = createPaths("/tmp/x");
    expect(p.home).toBe("/tmp/x");
    expect(p.configPath()).toBe(path.join("/tmp/x", "config.json"));
    expect(p.devTokenPath()).toBe(path.join("/tmp/x", "dev-token"));
    expect(p.logsDir()).toBe(path.join("/tmp/x", "logs"));
    expect(p.dbPath()).toBe(path.join("/tmp/x", "helix.db"));
  });

  test("③ 派生路径为 path.join 产物（分隔符合法、绝对路径）", () => {
    const home = "/tmp/x";
    const p = createPaths(home);
    const derived = [
      p.configPath(),
      p.devTokenPath(),
      p.logsDir(),
      p.dbPath(),
    ];
    for (const d of derived) {
      expect(path.isAbsolute(d)).toBe(true);
      expect(d.startsWith(home + path.sep)).toBe(true);
      expect(d).not.toContain(`${path.sep}${path.sep}`);
    }
  });
});
