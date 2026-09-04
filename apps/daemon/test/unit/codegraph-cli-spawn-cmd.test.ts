/**
 * cliSpawnCmd 单测（TR-95 windows-x64 兼容面）。
 *
 * win32 上 .cmd/.bat launcher（codegraph windows bundle 的 bin/codegraph.cmd）
 * 不是可执行映像，CreateProcess 直起必抛——经 cmd.exe /d /s /c 包装；
 * posix / 非脚本二进制原样直通（零行为变化）。平台注入可单测。
 */
import { describe, expect, test } from "bun:test";
import { cliSpawnCmd } from "../../src/adapters/driven/codegraph-engine/CodegraphEngineAdapter";

describe("cliSpawnCmd（win32 .cmd launcher 包装）", () => {
  test("posix：原样直通（mac 零回归）", () => {
    expect(cliSpawnCmd("/res/codegraph/bin/codegraph", ["status", "-j", "/root"], "darwin")).toEqual([
      "/res/codegraph/bin/codegraph",
      "status",
      "-j",
      "/root",
    ]);
  });

  test("win32 + 非脚本二进制（.exe/无扩展名）：原样直通", () => {
    expect(cliSpawnCmd("C:\\res\\bin\\rg.exe", ["--version"], "win32")).toEqual([
      "C:\\res\\bin\\rg.exe",
      "--version",
    ]);
    expect(cliSpawnCmd("C:\\res\\codegraph\\bin\\codegraph", ["status"], "win32")).toEqual([
      "C:\\res\\codegraph\\bin\\codegraph",
      "status",
    ]);
  });

  test("win32 + .cmd：cmd.exe /d /s /c 包装", () => {
    const cmd = cliSpawnCmd("C:\\res\\codegraph\\bin\\codegraph.cmd", ["status", "-j", "C:\\proj"], "win32");
    expect(cmd.slice(0, 4)).toEqual(["cmd.exe", "/d", "/s", "/c"]);
    expect(cmd[4]).toContain("codegraph.cmd");
    expect(cmd[4]).toContain("status");
  });

  test("win32 + .bat：同样包装（大小写不敏感）", () => {
    const cmd = cliSpawnCmd("C:\\tools\\RUN.BAT", [], "win32");
    expect(cmd.slice(0, 4)).toEqual(["cmd.exe", "/d", "/s", "/c"]);
  });

  test("含空格路径/参数逐参双引号包裹", () => {
    const cmd = cliSpawnCmd(
      "C:\\Program Files\\helix\\bin\\codegraph.cmd",
      ["init", "C:\\My Proj"],
      "win32",
    );
    expect(cmd[4]).toBe('"C:\\Program Files\\helix\\bin\\codegraph.cmd" init "C:\\My Proj"');
  });

  test("无空格参数不包裹（cmd /c 解析面最小化）", () => {
    const cmd = cliSpawnCmd("C:\\res\\codegraph.cmd", ["status", "-j", "C:\\proj"], "win32");
    expect(cmd[4]).toBe("C:\\res\\codegraph.cmd status -j C:\\proj");
  });
});
