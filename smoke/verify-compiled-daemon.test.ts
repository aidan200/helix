/**
 * verify-compiled-daemon 纯函数面测试（评审 F5 #9/#11）。
 *
 * 该脚本是「跑真 daemon 的双形态等价验证」——端到端不宜挂进常态测试集，
 * 故把两处修复的判定面抽成可测纯函数并在此钉住：
 *
 * - #9 端口定值：旧实现写 `<home>/config.json {port}`，依赖已退役字段的
 *   legacy 迁移路径（port → KV daemon_port）才生效；迁移批收口后端口静默
 *   回落 7333，探针(c) ready/握手超时误报。定案：改传 argv `--port`
 *   （daemon 现行解析链首选位：argv --port > KV daemon_port > 7333）。
 * - #11 ready 行解析：旧实现每轮 chunk 只消费一行即回到 read() 阻塞——多行
 *   日志同 chunk 合并且其后无输出时，滞留 buf 的 ready 行永不再解析，直至
 *   15s 超时误报「ready 行未就绪」。定案：行解析内层 while 排干 buf 再阻塞。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { daemonLaunchArgs, drainCompleteLines } from "./verify-compiled-daemon";

const ROOT = join(import.meta.dir, "..");

describe("#9 daemon 启动 argv 携带 --port（不写退役 config.json port）", () => {
  test("dev 形态：bun 直跑入口 + --sidecar/--home/--port", () => {
    const args = daemonLaunchArgs({
      form: "dev",
      devEntry: "/repo/apps/daemon/src/main.ts",
      compiledPath: "/repo/binaries/helix-daemon",
      home: "/tmp/home",
      port: 43210,
      execPath: "/usr/bin/bun",
    });
    expect(args).toEqual([
      "/usr/bin/bun",
      "/repo/apps/daemon/src/main.ts",
      "--sidecar",
      "--home",
      "/tmp/home",
      "--port",
      "43210",
    ]);
  });

  test("compiled 形态：单文件产物 + --port", () => {
    const args = daemonLaunchArgs({
      form: "compiled",
      devEntry: "/repo/apps/daemon/src/main.ts",
      compiledPath: "/repo/binaries/helix-daemon",
      home: "/tmp/home",
      port: 7333,
      execPath: "/usr/bin/bun",
    });
    expect(args).toEqual([
      "/repo/binaries/helix-daemon",
      "--sidecar",
      "--home",
      "/tmp/home",
      "--port",
      "7333",
    ]);
  });

  test("脚本内不再写退役的 config.json port 字段", () => {
    const src = readFileSync(join(ROOT, "smoke/verify-compiled-daemon.ts"), "utf8");
    expect(src).not.toContain(`writeFileSync(join(home, "config.json")`);
  });
});

describe("#11 ready 行解析：单 chunk 多行必须排干（不得只消费首行）", () => {
  test("日志行 + ready 行同 chunk → 两行都切出，ready 不被滞留", () => {
    const { lines, rest } = drainCompleteLines(
      "",
      '[helix] 启动中\n{"type":"ready","port":7333,"token":"t"}\n',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]!.startsWith('{"type":"ready"')).toBe(true);
    expect(rest).toBe("");
  });

  test("跨 chunk 拼接：残行留 buf、下一 chunk 补齐后切出", () => {
    const first = drainCompleteLines("", '{"type":"re');
    expect(first.lines).toHaveLength(0);
    expect(first.rest).toBe('{"type":"re');
    const second = drainCompleteLines(first.rest, 'ady","port":1}\nlog\nhalf');
    expect(second.lines).toEqual(['{"type":"ready","port":1}', "log"]);
    expect(second.rest).toBe("half");
  });

  test("chunk 末尾无换行 → 无完整行，buf 累积", () => {
    const { lines, rest } = drainCompleteLines("abc\n", "def");
    expect(lines).toEqual(["abc"]);
    expect(rest).toBe("def");
  });
});
