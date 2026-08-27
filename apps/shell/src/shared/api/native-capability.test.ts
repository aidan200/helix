/**
 * 壳原生能力 seam 单测（W6a；验收 2/4）。
 *
 * 覆盖：有/无能力两分支（jsdom 默认无挂载点 = 无能力降级面）、initial
 * 透传（不预校验、undefined 不构造）、选中路径零变换透传（Windows 反斜杠
 * 原样返回——禁斜杠转换/拼接/规范化）、取消（null/空串）与底层异常（能力
 * 未授予等）→ null（取消语义，输入框仍可手输）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasNativePicker, nativePickDirectory } from "./native-capability";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hasNativePicker（能力探测）", () => {
  it("无挂载点（纯浏览器 dev）→ false", () => {
    expect(hasNativePicker()).toBe(false);
  });

  it("挂载点非函数 → false（脏注入容错）", () => {
    vi.stubGlobal("helixPickDirectory", "not-a-function");
    expect(hasNativePicker()).toBe(false);
  });

  it("壳注入函数 → true", () => {
    vi.stubGlobal("helixPickDirectory", vi.fn(async () => null));
    expect(hasNativePicker()).toBe(true);
  });
});

describe("nativePickDirectory（调用面）", () => {
  it("无能力 → null（不抛错，降级面等价于未选中）", async () => {
    await expect(nativePickDirectory("/some/initial")).resolves.toBe(null);
  });

  it("initial 透传给挂载函数（不预校验：相对路径原样进）", async () => {
    const pick = vi.fn(async (_initial?: string) => "/abs/picked");
    vi.stubGlobal("helixPickDirectory", pick);
    await nativePickDirectory("relative/./weird");
    expect(pick).toHaveBeenCalledWith("relative/./weird");
  });

  it("initial 缺省 → undefined 透传（不构造默认值）", async () => {
    const pick = vi.fn(async (_initial?: string) => null);
    vi.stubGlobal("helixPickDirectory", pick);
    await nativePickDirectory();
    expect(pick).toHaveBeenCalledWith(undefined);
  });

  it("选中 → 平台原生路径串零变换透传（Windows 反斜杠原样返回）", async () => {
    const winPath = "C:\\Users\\siyong\\AI_Project";
    vi.stubGlobal("helixPickDirectory", vi.fn(async () => winPath));
    await expect(nativePickDirectory()).resolves.toBe(winPath);
  });

  it("取消（null）→ null（空串归一属壳注入脚本职责，seam 透传不重复实现）", async () => {
    vi.stubGlobal("helixPickDirectory", vi.fn(async () => null));
    await expect(nativePickDirectory()).resolves.toBe(null);
  });

  it("底层异常（能力未授予等）→ null（取消语义）", async () => {
    vi.stubGlobal("helixPickDirectory", vi.fn(async () => {
      throw new Error("plugin:dialog|open not allowed");
    }));
    await expect(nativePickDirectory()).resolves.toBe(null);
  });
});
