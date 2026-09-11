import { describe, expect, test } from "bun:test";

import { extractWriteCandidates, planBashSegments } from "../../src/domain/writefact/bashExtract";
import { parsePorcelainZ, diffPathIndices } from "../../src/domain/writefact/snapshotDiff";

/**
 * U0b L1 bash 写候选静态提取 + L2 快照 diff 纯逻辑单测。
 * L1 覆盖不求完备（漏报由 L2 兜）——断言「提取到的就是对的」+ 主流写形态全覆盖。
 */

describe("extractWriteCandidates", () => {
  test("重定向目标（> >> 2> &> 变体）", () => {
    expect(extractWriteCandidates("echo hi > out.txt")).toContain("out.txt");
    expect(extractWriteCandidates("echo hi >> log.txt")).toContain("log.txt");
    expect(extractWriteCandidates("cmd 2> err.txt")).toContain("err.txt");
    expect(extractWriteCandidates("cmd &> both.txt")).toContain("both.txt");
  });
  test("fd 目标与设备排除（>&1 / 2>&1 / /dev/null）", () => {
    const r = extractWriteCandidates("cmd >file 2>&1");
    expect(r).toContain("file");
    expect(r).not.toContain("2>&1");
    expect(extractWriteCandidates("cmd >/dev/null 2>&1")).toEqual([]);
  });
  test("sed -i 就地写（BSD/GNU 两形态）", () => {
    expect(extractWriteCandidates("sed -i 's/a/b/g' a.ts")).toEqual(["a.ts"]);
    expect(extractWriteCandidates("sed -i'' -e 's/a/b/' b.ts")).toEqual(["b.ts"]);
    // 无 -i 只读
    expect(extractWriteCandidates("sed 's/a/b/' a.ts")).toEqual([]);
  });
  test("tee / touch / mkdir / cp / mv", () => {
    expect(extractWriteCandidates("cmd | tee out.txt")).toContain("out.txt");
    expect(extractWriteCandidates("tee -a log")).toContain("log");
    expect(extractWriteCandidates("touch newfile")).toContain("newfile");
    expect(extractWriteCandidates("mkdir -p a/b/c")).toContain("a/b/c");
    expect(extractWriteCandidates("cp src.ts dst.ts")).toContain("dst.ts");
    expect(extractWriteCandidates("mv a.ts b.ts")).toContain("b.ts");
    expect(extractWriteCandidates("mv a.ts b.ts")).not.toContain("a.ts");
  });
  test("git 写子命令", () => {
    expect(extractWriteCandidates("git checkout -- src/a.ts")).toContain("src/a.ts");
    expect(extractWriteCandidates("git apply patch.diff")).toContain("patch.diff");
    expect(extractWriteCandidates("git status")).toEqual([]);
    expect(extractWriteCandidates("git log --oneline")).toEqual([]);
  });
  test("管道与逻辑链分段（各段独立提取）", () => {
    const r = extractWriteCandidates("cat src | grep x > mid.txt && sed -i 's/1/2/' final.ts");
    expect(r).toContain("mid.txt");
    expect(r).toContain("final.ts");
  });
  test("纯只读命令零候选", () => {
    expect(extractWriteCandidates("ls -la")).toEqual([]);
    expect(extractWriteCandidates("cat file.ts")).toEqual([]);
    expect(extractWriteCandidates("grep -rn pattern .")).toEqual([]);
    expect(extractWriteCandidates("")).toEqual([]);
  });
  test("dd of= 目标", () => {
    expect(extractWriteCandidates("dd if=in of=out.img bs=1k")).toContain("out.img");
    expect(extractWriteCandidates("dd if=in of=out.img")).not.toContain("in");
  });
});

describe("parsePorcelainZ", () => {
  test("普通条目（真实 -z 格式：XY 空格 path NUL）", () => {
    const raw = " M src/a.ts\0?? new.ts\0";
    const m = parsePorcelainZ(raw);
    expect(m.get("src/a.ts")).toBe("M");
    expect(m.get("new.ts")).toBe("??");
  });
  test("重命名条目跳过源路径（R 目标 + 追加 orig NUL 记录）", () => {
    const raw = "R  new.ts\0old.ts\0 M b.ts\0";
    const m = parsePorcelainZ(raw);
    expect(m.has("new.ts")).toBe(true);
    expect(m.has("old.ts")).toBe(false);
    expect(m.get("b.ts")).toBe("M");
  });
  test("空输入与空 path 记录防御", () => {
    expect(parsePorcelainZ("").size).toBe(0);
    expect(parsePorcelainZ("M\0\0").size).toBe(0);
  });
});

describe("diffPathIndices", () => {
  const e = (size: number, mt: number) => ({ size, mtimeMs: mt });
  test("新增/删除/变更三态并集", () => {
    const before = new Map([["a", e(1, 1)], ["b", e(2, 2)], ["c", e(3, 3)]]);
    const after = new Map([["a", e(1, 1)], ["b", e(9, 9)], ["d", e(4, 4)]]);
    expect(new Set(diffPathIndices(before, after))).toEqual(new Set(["b", "c", "d"]));
  });
  test("全等零变更", () => {
    const idx = new Map([["a", e(1, 1)]]);
    expect(diffPathIndices(idx, new Map(idx))).toEqual([]);
  });
});

// ── cd-aware 段规划（真机缺陷回归：cwd 非 git + cd project && cmd）──

describe("planBashSegments（cd 追踪）", () => {
  test("绝对 cd 重置 + 相对候选按段 cwd 解析", () => {
    const segs = planBashSegments("cd /tmp/x && echo a > f.ts", "/ws");
    expect(segs.length).toBe(1);
    expect(segs[0]?.cwd).toBe("/tmp/x");
    expect(segs[0]?.writes).toEqual(["f.ts"]);
  });

  test("相对 cd 叠加 + .. 折叠", () => {
    const segs = planBashSegments("cd sub && cd ../other && touch g.ts", "/ws");
    expect(segs.length).toBe(1); // touch 段
    expect(segs[0]?.cwd).toBe("/ws/other");
    expect(segs[0]?.writes).toEqual(["g.ts"]);
  });

  test("失锁（cd $VAR）后相对候选丢弃、绝对候选保留、绝对 cd 恢复", () => {
    const segs = planBashSegments("cd $D && echo a > rel.ts && echo b > /abs/b.ts && cd /fix && echo c > ok.ts", "/ws");
    expect(segs[0]?.cwd).toBe(null);
    expect(segs[0]?.writes).toEqual([]); // rel.ts 被丢
    expect(segs[1]?.cwd).toBe(null);
    expect(segs[1]?.writes).toEqual(["/abs/b.ts"]); // 绝对候选保留
    expect(segs[2]?.cwd).toBe("/fix"); // 绝对 cd 恢复追踪
    expect(segs[2]?.writes).toEqual(["ok.ts"]);
  });

  test("cd 段自身不产写候选", () => {
    expect(planBashSegments("cd a/b", "/ws")).toEqual([]);
  });
});
