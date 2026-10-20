/**
 * 运行环境配置测试（W7 env 端口派生）。
 *
 * resolvePort：只接受 1..65535 的整数端口；「7333.5」「65536」这类非端口值
 * 必须回落缺省 7333——否则拼出的 WS 地址（ws://127.0.0.1:7333.5）不可用。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePort } from "./env";

describe("resolvePort（VITE_HELIX_PORT → daemon 端口）", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("合法端口透传；缺省/空 → 7333", () => {
    vi.stubEnv("VITE_HELIX_PORT", "8123");
    expect(resolvePort()).toBe(8123);
    vi.stubEnv("VITE_HELIX_PORT", "");
    expect(resolvePort()).toBe(7333);
    vi.stubEnv("VITE_HELIX_PORT", "65535");
    expect(resolvePort()).toBe(65535);
    vi.stubEnv("VITE_HELIX_PORT", "1");
    expect(resolvePort()).toBe(1);
  });

  it("非整数/越界/非数值回落缺省（不拼非法 WS 地址）", () => {
    for (const bad of ["7333.5", "65536", "0", "-1", "abc"]) {
      vi.stubEnv("VITE_HELIX_PORT", bad);
      expect(resolvePort(), bad).toBe(7333);
    }
  });
});
