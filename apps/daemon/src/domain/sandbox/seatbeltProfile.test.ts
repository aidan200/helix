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

  test("控制字符不得进前缀：直构 policy 也不污染 profile（字面量面末级削除）", () => {
    // 解析面已剔除含控制字符的 extraRoots；本测钉字面量面的兑底——绕过
    // parseSandboxConfig 直构 policy 时也不能把 sbpl 字面量断行/注入语句。
    const p = buildSeatbeltProfile({
      mode: "on",
      writableRoots: ['/Users/x/evil\n(allow file-write* (subpath "/"))', "/Users/x/ok\u0007"],
    });
    const literals = [...p.matchAll(/\(subpath "([^"]*)"\)/g)].map((m) => m[1]!);
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      expect(/[\u0000-\u001f\u007f]/.test(literal)).toBe(false);
    }
  });
});
