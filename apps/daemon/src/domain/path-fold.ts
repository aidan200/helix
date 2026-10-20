/**
 * 纯字符串路径折叠单源（domain 纪律：不 import node:path，framework-free）。
 *
 * 历史：三份实现各自为政且「..」语义不一致（评审 low #72）——
 * domain/sandbox/SandboxPolicy.foldPathSegments（相对路径保留前导 ..）、
 * domain/writefact/bashExtract.resolveWithin（前导 .. 直接丢弃）、
 * domain/sandbox/ruleFallback.resolveWithin（第三份逐字重复 bashExtract 版）。
 * 收口后口径唯一：
 * - foldPathSegments：绝对输入折叠后仍带前导 `/`；相对输入保留无法消解的
 *   前导 `..`（折叠不下穿根）；
 * - resolveWithinPath(base, rel)：先按 rel 绝对性拼 base，再交 foldPathSegments
 *   ——写候选/沙箱 fallback 的统一解析入口。
 */

/** 路径折叠（. / .. / 空段归一；绝对路径不下穿根，相对路径保留前导 ..）。 */
export function foldPathSegments(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  if (abs) return `/${joined}`;
  return joined === "" ? "." : joined;
}

/** base + rel 解析（rel 绝对则忽略 base）；纯字符串，零 IO。 */
export function resolveWithinPath(base: string, rel: string): string {
  return foldPathSegments(rel.startsWith("/") ? rel : `${base}/${rel}`);
}
