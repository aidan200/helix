/**
 * openUrlCommand 单测（TR-95 windows-x64 兼容面 + TR-271 quoting 纪律）。
 *
 * 纯函数 argv 组装，平台注入钉死各分支（mac 宿主可测 win32 分支）；
 * auth_url 消费链（AuthLoginService.openUrl）已有 auth-login.test.ts 覆盖，
 * 本文件只钉命令组装形态。
 */
import { describe, expect, test } from "bun:test";
import { openUrlCommand } from "../../src/infrastructure/open-url";

describe("openUrlCommand（auth_url 浏览器拉起 argv）", () => {
  test("darwin：open 直通（mac 零回归）", () => {
    expect(openUrlCommand("https://example.com/login?state=abc", "darwin")).toEqual([
      "open",
      "https://example.com/login?state=abc",
    ]);
  });

  test("linux：xdg-open 直通（零行为变化）", () => {
    expect(openUrlCommand("https://example.com/", "linux")).toEqual(["xdg-open", "https://example.com/"]);
  });

  test("win32：cmd.exe /d /s /c start + 空标题占位（verbatim 形态）", () => {
    expect(openUrlCommand("https://example.com/login", "win32")).toEqual([
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "start",
      '""',
      "https://example.com/login",
    ]);
  });

  test("win32：带 & 查询串的 url 整体双引号包裹（cmd 元字符屏蔽，TR-271）", () => {
    // auth_url 实际形态含 query string（state/code 等参数）——& 在 cmd
    // 重解析层是命令分隔符，未包裹的 url 会被腰斩成两条命令
    expect(openUrlCommand("https://example.com/cb?code=x&state=y", "win32")).toEqual([
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "start",
      '""',
      '"https://example.com/cb?code=x&state=y"',
    ]);
  });

  test("win32：url 含内部引号时翻倍转义（cmd 规则）", () => {
    expect(openUrlCommand('https://example.com/a"b', "win32")[6]).toBe('"https://example.com/a""b"');
  });

  test("win32：含空格的 url 同样整体包裹（空格是 libuv 与 cmd 共同触发条件）", () => {
    expect(openUrlCommand("https://example.com/a b", "win32")[6]).toBe('"https://example.com/a b"');
  });
});
