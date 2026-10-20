/**
 * 图片 data URL 结构闸单测（评审 low #63）。
 *
 * 缺陷面：DATA_URL_RE 只校验字符集（[A-Za-z0-9+/=]+），错位/多余 padding、
 * 长度 mod 4 === 1 等畸形串能过闸——"任一不满足抛 Error" 的承诺被削弱，
 * 且 base64ByteLength 的尺寸护栏对畸形串失真（可能把超 2MB 的串算小）。
 *
 * 断言面：①合法 padded / 裸 base64 照收；②padding 在中间 / 超 2 个 /
 * mod 4 === 1 → ImageValidationError；③字节数推导对裸 base64 仍准确。
 */
import { describe, expect, test } from "bun:test";
import {
  ImageValidationError,
  base64ByteLength,
  isStructurallyValidBase64,
  parseDataUrlImages,
} from "../../src/application/services/images";

const PNG_PREFIX = "data:image/png;base64,";

describe("base64 结构闸（评审 low #63）", () => {
  test("合法形态放行：padded 与裸 base64", () => {
    expect(isStructurallyValidBase64(`${"A".repeat(10)}==`)).toBe(true); // 12 字符（pad 2）
    expect(isStructurallyValidBase64(`${"A".repeat(11)}=`)).toBe(true); // 12 字符（pad 1）
    expect(isStructurallyValidBase64("iVBORw0KGgo=")).toBe(true); // 真实前缀形态
    // 裸 base64（无 padding，body 长度 mod 4 = 2/3）
    expect(isStructurallyValidBase64("A".repeat(10))).toBe(true); // mod 4 = 2
    expect(isStructurallyValidBase64("A".repeat(11))).toBe(true); // mod 4 = 3
  });

  test("畸形形态拒绝：padding 错位/超量/长度 mod 4 = 1", () => {
    expect(isStructurallyValidBase64("AAA=AAAA")).toBe(false); // padding 在中间
    expect(isStructurallyValidBase64("AAAA===")).toBe(false); // padding 超 2
    expect(isStructurallyValidBase64("A".repeat(9))).toBe(false); // body mod 4 === 1
    expect(isStructurallyValidBase64("")).toBe(false);
  });

  test("parseDataUrlImages 对结构非法串抛 ImageValidationError（不只字符集）", () => {
    expect(() => parseDataUrlImages([`${PNG_PREFIX}AAA=AAAA`])).toThrow(ImageValidationError);
    expect(() => parseDataUrlImages([`${PNG_PREFIX}${"A".repeat(9)}`])).toThrow(/base64 结构非法/);
    // 合法形态照收
    expect(parseDataUrlImages([`${PNG_PREFIX}iVBORw0KGgo=`])[0]?.mimeType).toBe("image/png");
  });

  test("字节数推导：padded 与裸 base64 同值（2 字符 = 1 字节；3 字符 = 2 字节）", () => {
    expect(base64ByteLength("AB==")).toBe(1); // 4 字符 padded → 1 字节
    expect(base64ByteLength("AB")).toBe(1); // 裸 2 字符 → 1 字节
    expect(base64ByteLength("ABC=")).toBe(2);
    expect(base64ByteLength("ABC")).toBe(2);
  });
});
