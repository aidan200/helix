import { describe, expect, test } from "bun:test";

import { parseSandboxConfig } from "./SandboxPolicy";
import { buildSeatbeltProfile } from "./seatbeltProfile";

const WS = "/Users/x/work";
const HOME = "/Users/x/.helix";

describe("buildSeatbeltProfile", () => {
  const policy = parseSandboxConfig({ enabled: true }, WS, HOME);

  test("含 deny-default 起手（关闭式基线）", () => {
    expect(buildSeatbeltProfile(policy)).toContain("(deny default)");
  });

  test("动态段：每个 writableRoot 一条 subpath 放行", () => {
    const p = buildSeatbeltProfile(policy);
    expect(p).toContain(`(subpath "${WS}")`);
    expect(p).toContain(`(subpath "${HOME}")`);
    expect(p).toContain("file-write*");
  });

  test("网络 allow-all 段 + DNS/TLS mach-lookup（allow-all 裁决的落地形态）", () => {
    const p = buildSeatbeltProfile(policy);
    expect(p).toContain("(allow network*)");
    expect(p).toContain("com.apple.mDNSResponder");
    expect(p).toContain("com.apple.trustd.agent");
  });

  test("平台读默认段在场（缺段即崩的兼容性基座）", () => {
    const p = buildSeatbeltProfile(policy);
    expect(p).toContain('(subpath "/System/Library/Frameworks")');
    expect(p).toContain('(subpath "/usr/lib")');
    expect(p).toContain('file-write* (subpath "/tmp")'); // 系统 scratch
  });

  test("off 态调用即错（防误用——off 不应有 profile）", () => {
    expect(() => buildSeatbeltProfile(parseSandboxConfig(null, WS, HOME))).toThrow();
  });

  test("路径特殊字符转义（防御性）", () => {
    const weird = parseSandboxConfig({ enabled: true }, `/Users/x/we"ird`, HOME);
    const p = buildSeatbeltProfile(weird);
    expect(p).toContain('\\"ird');
  });
});
