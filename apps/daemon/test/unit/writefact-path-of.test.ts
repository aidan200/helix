/**
 * writeFactPathOf 单测（评审 low #36）。
 *
 * 缺陷面：writeHook 内联 `p.startsWith("/")` 硬编码 POSIX 绝对判定——win32
 * 宿主下盘符路径（`C:\x\a.ts` / `C:/x/a.ts`）被判相对，再拼 toolCwd，写事实
 * 登记到错误路径（占用协调/足迹注入据此失真）。
 *
 * 断言面：POSIX 绝对原样；win32 盘符绝对原样（两种分隔符）；相对 join 到
 * toolCwd（platform 语义，win32 宿主产出反斜杠）。
 */
import { describe, expect, test } from "bun:test";
import { isAbsolute, join } from "node:path";
import { writeFactPathOf } from "../../src/infrastructure/assembly/sessionEngineFactory";

const CWD = "/ws/proj";

describe("writeFactPathOf：绝对判定不硬编码 POSIX（评审 low #36）", () => {
  test("POSIX 绝对路径原样返回", () => {
    expect(writeFactPathOf(CWD, "/ws/proj/src/a.ts")).toBe("/ws/proj/src/a.ts");
  });

  test("win32 盘符路径按绝对处理（不被拼上 toolCwd）", () => {
    expect(writeFactPathOf("C:\\ws\\proj", "C:\\ws\\proj\\src\\a.ts")).toBe("C:\\ws\\proj\\src\\a.ts");
    expect(writeFactPathOf("C:\\ws\\proj", "D:/other/b.ts")).toBe("D:/other/b.ts");
  });

  test("相对路径 join 到 toolCwd（platform 分隔符语义）", () => {
    expect(writeFactPathOf(CWD, "src/a.ts")).toBe(join(CWD, "src/a.ts"));
    expect(isAbsolute(writeFactPathOf(CWD, "src/a.ts"))).toBe(true);
  });
});
