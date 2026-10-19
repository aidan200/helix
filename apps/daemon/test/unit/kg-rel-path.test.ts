/**
 * kg 服务族事件路径归一单点单测（评审 F1：relPathOf 绝对判定只认 '/' 前缀
 * ——win32 盘符路径被当相对输入原样透传，与 isOutsideRootRel 的 win32 反
 * 斜杠兼容不对称，Windows 上 sync 窗口键/锚表相对键失配，E-12 win32 归一
 * 口径缺口）。
 *
 * 断言面：
 * 1. POSIX 绝对路径 → 相对 projectRoot；相对输入透传；根自身回退原路径；
 * 2. win32 盘符路径按 win32 语义相对化（跨宿主平台——posix 宿主收到
 *    C:\ 形态同样归一，不透传）；
 * 3. isOutsideRootRel 根外判定（.. 前缀三形态 + ..foo 合法同前缀不误杀）。
 */
import { describe, expect, test } from "bun:test";
import { relPathOf, isOutsideRootRel } from "../../src/application/services/kg/rel-path";

describe("relPathOf：事件路径归一单点", () => {
  test("POSIX 绝对 → 相对；相对透传；根自身回退原路径（键非空不变量）", () => {
    expect(relPathOf("/w/helix", "/w/helix/src/a.ts")).toBe("src/a.ts");
    expect(relPathOf("/w/helix", "src/a.ts")).toBe("src/a.ts");
    expect(relPathOf("/w/helix", "/w/helix")).toBe("/w/helix");
  });

  test("win32 盘符路径按 win32 语义相对化（E-12 归一口径——不再原样透传）", () => {
    expect(relPathOf("C:\\proj", "C:\\proj\\src\\a.ts")).toBe("src\\a.ts");
    expect(relPathOf("C:\\proj", "C:\\proj")).toBe("C:\\proj"); // 根自身回退原路径
  });

  test("isOutsideRootRel：.. 前缀三形态根外；..foo 同前缀合法不误杀", () => {
    expect(isOutsideRootRel("..")).toBe(true);
    expect(isOutsideRootRel("../x")).toBe(true);
    expect(isOutsideRootRel("..\\x")).toBe(true);
    expect(isOutsideRootRel("..foo")).toBe(false);
    expect(isOutsideRootRel("src/a.ts")).toBe(false);
  });
});
