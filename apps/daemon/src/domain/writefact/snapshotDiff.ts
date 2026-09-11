/**
 * 快照索引 diff 纯逻辑（U0b L2——零 IO，索引的获取归 driven）。
 *
 * 为什么存在：L2 的核心断言是「exec 前后快照差集 = 本命令效果」——
 * 差集计算是纯函数（两 Map 对比），porcelain 行解析也是纯字符串，
 * 收口本文件供 driven 快照器与测试直接消费。
 */

/**
 * git status --porcelain=v1 -z 输出解析 → Map（相对仓根路径 → xy 状态）。
 *
 * -z 真实格式（od 实测校准）：每条记录 = `XY <path>\0`（XY 两字符 +
 * 恒跟一个空格 + path，整条 NUL 结尾）；仅重命名/拷贝（R/C）追加
 * `<origPath>\0` 源路径记录（本层跳过——目标路径已是写效果）。
 * 含特殊字符路径的 `"..."` 引号形态简单去引号（core.quotepath=off 由
 * IO 侧传参规避非 ASCII 引号；控制字符场景罕见，去引号已覆盖主流量）。
 */
export function parsePorcelainZ(raw: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const parts = raw.split("\0");
  let i = 0;
  while (i < parts.length) {
    const entry = parts[i] ?? "";
    if (entry.length < 4) {
      i += 1;
      continue; // 空尾段/病短记录
    }
    const xy = entry.slice(0, 2);
    const p = entry.slice(3); // 跳过 XY + 恒跟空格
    if (p !== "") {
      const status = xy.trim();
      const unquoted = p.startsWith('"') && p.endsWith('"') && p.length >= 2 ? p.slice(1, -1) : p;
      out.set(unquoted, status === "" ? "?" : status);
      if (status.startsWith("R") || status.startsWith("C")) i += 1; // 源路径记录跳过
    }
    i += 1;
  }
  return out;
}

/** 索引条目等价判定（size+mtime 双道——同判即未变）。 */
export type SnapshotIndexEntry = { readonly size: number; readonly mtimeMs: number };

/** 两索引 diff：新增/删除/变更路径并集（before/after 键并集中不相等者）。 */
export function diffPathIndices(
  before: ReadonlyMap<string, SnapshotIndexEntry>,
  after: ReadonlyMap<string, SnapshotIndexEntry>,
): readonly string[] {
  const changed: string[] = [];
  for (const [p, a] of after) {
    const b = before.get(p);
    if (b === undefined || b.size !== a.size || b.mtimeMs !== a.mtimeMs) changed.push(p);
  }
  for (const p of before.keys()) {
    if (!after.has(p)) changed.push(p);
  }
  return changed;
}
