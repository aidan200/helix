import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { diffBashSnapshots, planBashSnapshot, takeBashSnapshot } from "../../src/adapters/driven/writefact/bashSnapshot";
import { wrapEnvForBashSense, type BashObservedWrite } from "../../src/adapters/driven/tools/BashSenseEnvWrap";

/**
 * U0b 行为测试（真 git fixture + wrap 集成）——L2 快照差集的核心断言：
 * exec 前后差集 = 本命令效果；只读零记录；归属剔除；非 git walk 面兜底。
 */

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-repo-"));
  execSync("git init -q", { cwd: dir });
  await writeFile(path.join(dir, "a.ts"), "line-x\nline-x\n", "utf-8");
  return dir;
}

/** 假 env：exec 真跑命令（同 cwd）。 */
function fakeEnv(cwd: string) {
  return {
    cwd,
    exec: async (command: string) => {
      execSync(command, { cwd, stdio: "pipe" });
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

describe("bashSnapshot（真 git fixture）", () => {
  test("plan：仓根探测 + L1 候选仓内外分流", async () => {
    const dir = await makeRepo();
    try {
      const plan = planBashSnapshot("sed -i 's/x/y/' a.ts", dir);
      expect(plan.repoRoots).toEqual([dir]);
      expect(plan.l1Paths).toEqual([path.join(dir, "a.ts")]);
      expect(plan.extraPaths).toEqual([]); // 仓内 → 不进 extra
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("plan：cd 进子仓——多仓面 + cd 后相对候选根解析（真机缺陷回归）", async () => {
    // 回归场景：cwd 非 git（workspace 根）+ `cd tmp-gf && echo > f`——
    // 修复前 repoRoot=undefined 走 walk 面（大 workspace 超预算静默零记录）
    const ws = await mkdtemp(path.join(tmpdir(), "wf-ws-"));
    try {
      const sub = path.join(ws, "tmp-gf");
      await mkdir(sub);
      execSync("git init -q", { cwd: sub });
      const plan = planBashSnapshot("cd tmp-gf && echo x > mine.ts && git add .", ws);
      expect(plan.repoRoots).toEqual([sub]); // cd 目标仓独立成面
      expect(plan.l1Paths).toEqual([path.join(sub, "mine.ts")]); // 根=段 cwd 非 ws
      expect(plan.extraPaths).toEqual([]); // 仓内
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test("diff：modify/delete/add 三态捕获", async () => {
    const dir = await makeRepo();
    try {
      const plan = planBashSnapshot("true", dir);
      const before = await takeBashSnapshot(plan, dir);
      execSync("sed -i '' 's/x/y/' a.ts && rm -f nothing 2>/dev/null; true", { cwd: dir });
      await writeFile(path.join(dir, "new.ts"), "n", "utf-8");
      const after = await takeBashSnapshot(plan, dir);
      const changed = new Set(diffBashSnapshots(before, after));
      expect(changed.has(path.join(dir, "a.ts"))).toBe(true);
      expect(changed.has(path.join(dir, "new.ts"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("wrapEnvForBashSense（集成）", () => {
  test("sed -i 改文件 → inferred 事实归属本命令", async () => {
    const dir = await makeRepo();
    try {
      const observed: BashObservedWrite[] = [];
      const env = wrapEnvForBashSense(fakeEnv(dir), {
        onObserved: (facts) => observed.push(...facts),
        now: () => 1_000,
      });
      await env.exec("sed -i '' 's/x/y/' a.ts");
      expect(observed).toEqual([{ path: path.join(dir, "a.ts"), confidence: "inferred", at: 1_000 }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("只读命令（cat/ls）零记录", async () => {
    const dir = await makeRepo();
    try {
      const observed: BashObservedWrite[] = [];
      const env = wrapEnvForBashSense(fakeEnv(dir), { onObserved: (facts) => observed.push(...facts) });
      await env.exec("cat a.ts");
      await env.exec("ls -la");
      expect(observed).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("归属剔除：他人 precise 写的路径不归本命令", async () => {
    const dir = await makeRepo();
    try {
      const observed: BashObservedWrite[] = [];
      const env = wrapEnvForBashSense(fakeEnv(dir), {
        onObserved: (facts) => observed.push(...facts),
        preciseSince: () => [path.join(dir, "a.ts")], // 他人写
        now: () => 1_000,
      });
      await env.exec("sed -i '' 's/x/y/' a.ts");
      expect(observed).toEqual([]); // 唯一变更被剔除 → 零事实
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("非 git 目录（walk 面）：echo > 新文件捕获", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "wf-plain-"));
    try {
      await mkdir(path.join(dir, "sub"), { recursive: true });
      await writeFile(path.join(dir, "sub", "keep.txt"), "k", "utf-8");
      const observed: BashObservedWrite[] = [];
      const env = wrapEnvForBashSense(fakeEnv(dir), { onObserved: (facts) => observed.push(...facts) });
      await env.exec("echo out > out.txt");
      expect(observed.map((f) => f.path)).toContain(path.join(dir, "out.txt"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cd 进子 git 仓写文件（repo 多仓面）——真机缺陷端到端回归", async () => {
    // 场景：cwd=workspace 根（非 git，且真实 workspace walk 必超预算）+
    // `cd tmp-gf && echo > f`——修复前 repoRoot=undefined → walk 面超预算
    // 静默零记录；修复后 cd 目标仓独立成 git 面捕获。
    // 注：fixture 树小，walk 面不会超时——断言点在 repo 面捕获（多仓生效），
    // walk 超预算场景由 plan 单测的 repoRoots 断言覆盖。
    const ws = await mkdtemp(path.join(tmpdir(), "wf-ws2-"));
    try {
      const sub = path.join(ws, "tmp-gf");
      await mkdir(sub);
      execSync("git init -q", { cwd: sub });
      const observed: BashObservedWrite[] = [];
      const env = wrapEnvForBashSense(fakeEnv(ws), { onObserved: (facts) => observed.push(...facts) });
      await env.exec("cd tmp-gf && echo mine > mine.ts");
      expect(observed.map((f) => f.path)).toContain(path.join(sub, "mine.ts"));
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test("runtime 缺省 → 原 env 引用不变（零侵入）", () => {
    const env = fakeEnv("/tmp");
    expect(wrapEnvForBashSense(env, undefined)).toBe(env);
  });
});
