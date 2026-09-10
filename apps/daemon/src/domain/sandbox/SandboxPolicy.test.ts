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
