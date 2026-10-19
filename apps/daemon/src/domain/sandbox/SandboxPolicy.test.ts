import { describe, expect, test } from "bun:test";

import { isPathWritable, normalizeRoots, parseSandboxConfig, writeDeniedMessage } from "./SandboxPolicy";

const WS = "/Users/x/work";
const HOME = "/Users/x/.helix";

describe("parseSandboxConfig", () => {
  test("enabled true → on + 双根（workspace + helix home）", () => {
    const p = parseSandboxConfig({ enabled: true }, WS, HOME);
    expect(p.mode).toBe("on");
    expect(p.writableRoots).toEqual([WS, HOME]);
  });

  test("缺文件载荷（null）/非对象 / enabled 非 true → off + 空 roots", () => {
    expect(parseSandboxConfig(null, WS, HOME).mode).toBe("off");
    expect(parseSandboxConfig({}, WS, HOME).mode).toBe("off");
    expect(parseSandboxConfig({ enabled: "true" }, WS, HOME).mode).toBe("off");
    expect(parseSandboxConfig({ enabled: false }, WS, HOME).writableRoots).toEqual([]);
  });

  test("解析失败安全方向：off（不沙箱不锁死）", () => {
    expect(parseSandboxConfig("garbage-string", WS, HOME).mode).toBe("off");
  });

  test("extraRoots 合并进 writableRoots（归一去重保序）", () => {
    const p = parseSandboxConfig({ enabled: true, extraRoots: ["/Users/x/.cache/uv/", "/opt/tools", WS] }, WS, HOME);
    expect(p.writableRoots).toEqual([WS, HOME, "/Users/x/.cache/uv", "/opt/tools"]);
  });

  test("extraRoots 非字符串/空串项过滤；enabled=false 时忽略", () => {
    const p = parseSandboxConfig({ enabled: true, extraRoots: ["/ok", 42, "  ", null] }, WS, HOME);
    expect(p.writableRoots).toEqual([WS, HOME, "/ok"]);
    expect(parseSandboxConfig({ enabled: false, extraRoots: ["/ok"] }, WS, HOME).writableRoots).toEqual([]);
  });

  test("extraRoots 含控制字符项剔除（防 sbpl 字面量断行——策略面与 profile 面同口径）", () => {
    const evil = '/opt/x\n(allow file-write* (subpath "/"))';
    const p = parseSandboxConfig({ enabled: true, extraRoots: [evil, "/ok", "/tab\there"] }, WS, HOME);
    expect(p.writableRoots).toEqual([WS, HOME, "/ok"]);
    // 剔除是策略面事实（isPathWritable 同口径拒绝该路径——不放行 profile 也不放行 write 工具）
    expect(isPathWritable("/opt/x", p)).toBe(false);
  });
});

describe("normalizeRoots", () => {
  test("去尾分隔符 + 去重保序", () => {
    expect(normalizeRoots(["/a/", "/b", "/a", "/"])).toEqual(["/a", "/b", "/"]);
  });
});

describe("isPathWritable", () => {
  const policy = parseSandboxConfig({ enabled: true }, WS, HOME);

  test("根内：根自身/子路径放行", () => {
    expect(isPathWritable(WS, policy)).toBe(true);
    expect(isPathWritable(`${WS}/apps/daemon/src/main.ts`, policy)).toBe(true);
    expect(isPathWritable(`${HOME}/reports/x.md`, policy)).toBe(true);
  });

  test("根外：前缀伪造 / 未规范化 ../ 逃逸 / 真越界均拒", () => {
    expect(isPathWritable("/Users/x/Downloads/x", policy)).toBe(false);
    expect(isPathWritable(`${WS}-evil/x`, policy)).toBe(false); // 前缀字符串相似不算
    expect(isPathWritable(`/etc/hosts`, policy)).toBe(false);
    expect(isPathWritable(`${WS}/../evil/x`, policy)).toBe(false); // ../ 折叠后逃逸
    expect(isPathWritable(`${WS}//apps/./x.ts`, policy)).toBe(true); // 规范化噪声不误拒
  });

  test("off 态恒放行（透传语义）", () => {
    const off = parseSandboxConfig(null, WS, HOME);
    expect(isPathWritable("/etc/hosts", off)).toBe(true);
  });
});

describe("writeDeniedMessage", () => {
  test("文案含路径 + 根清单 + 处置指引", () => {
    const m = writeDeniedMessage("/etc/hosts", parseSandboxConfig({ enabled: true }, WS, HOME));
    expect(m).toContain("/etc/hosts");
    expect(m).toContain("命令沙箱");
    expect(m).toContain("write/edit");
  });
});
