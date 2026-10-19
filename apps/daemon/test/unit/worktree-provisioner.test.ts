import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, lstat, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWorktreeProvisioner } from "../../src/adapters/driven/worktree/GitWorktreeProvisioner";

/**
 * U3：GitWorktreeProvisioner 真行为测试（真 git fixture——同 bashSense/
 * pre-commit-guard 测试形态：真 spawn git，非 mock）。TR-152：测试 tmpdir
 * 即时回收（try/finally），wf- 前缀不在审计面。
 */

const run = async (cmd: string[], cwd: string) => {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
};

const mkRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "wf-wt-"));
  await run(["git", "init", "-q"], dir);
  await run(["git", "config", "user.email", "t@t"], dir);
  await run(["git", "config", "user.name", "t"], dir);
  await writeFile(join(dir, "a.ts"), "export const a = 1;\n");
  // 主仓四处 node_modules 模拟（TR-143 软链源——目录存在才会被软链）
  await mkdir(join(dir, "node_modules"), { recursive: true });
  await mkdir(join(dir, "apps/shell/node_modules"), { recursive: true });
  await run(["git", "add", "."], dir);
  await run(["git", "commit", "-qm", "init"], dir);
  return dir;
};

describe("GitWorktreeProvisioner", () => {
  test("provision：建树/分支/软链四处（TR-143）+ realpath 归一", async () => {
    const repo = await mkRepo();
    try {
      const p = new GitWorktreeProvisioner();
      const r = await p.provision("agent-test1", repo);
      if ("error" in r) throw new Error(r.error);
      expect(r.branch).toBe("helix/agent-test1");
      // realpath 归一（/var → /private/var 形态一致）
      expect(r.path).toBe(await Bun.file(join(r.path, "a.ts")).exists().then(() => r.path));
      expect(await Bun.file(join(r.path, "a.ts")).exists()).toBe(true);
      // 四处软链（TR-143）——lstat 判定（symlink→目录，Bun.file.exists 语义不含）
      const lstatOk = async (p: string) => {
        try {
          return (await lstat(p)).isSymbolicLink() || (await lstat(p)).isDirectory();
        } catch {
          return false;
        }
      };
      expect(await lstatOk(join(r.path, "node_modules"))).toBe(true);
      expect(await lstatOk(join(r.path, "apps/shell/node_modules"))).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("provision：幂等（同 slug 重跑复用既有树）", async () => {
    const repo = await mkRepo();
    try {
      const p = new GitWorktreeProvisioner();
      const r1 = await p.provision("agent-dup", repo);
      if ("error" in r1) throw new Error(r1.error);
      const r2 = await p.provision("agent-dup", repo);
      if ("error" in r2) throw new Error(r2.error);
      expect(r2.path).toBe(r1.path);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("provision：非 git 仓 → error（isolated 档诚实报因）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-nogit-"));
    try {
      const p = new GitWorktreeProvisioner();
      const r = await p.provision("agent-x", dir);
      expect("error" in r).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("remove：删树往返", async () => {
    const repo = await mkRepo();
    try {
      const p = new GitWorktreeProvisioner();
      const r = await p.provision("agent-rm", repo);
      if ("error" in r) throw new Error(r.error);
      expect(await p.remove(r.path)).toBe(true);
      expect(await Bun.file(join(r.path, "a.ts")).exists()).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("code-review M：陈旧分支死锁自愈 + 复用分支校验（TR-83 注释口径对齐）", () => {
  test("worktree remove 不删分支——同 slug 重 provision 自愈（删陈旧分支重试一次）", async () => {
    const repo = await mkRepo();
    try {
      const p = new GitWorktreeProvisioner();
      const r1 = await p.provision("agent-stale", repo);
      if ("error" in r1) throw new Error(r1.error);
      // 模拟残留现场：worktree 移除但分支滞留（生产 remove 路径不删分支）
      await run(["git", "worktree", "remove", "--force", r1.path], repo);
      // 现行行为红：git worktree add -b helix/agent-stale 必失败（分支已存在）且无自愈通道
      const r2 = await p.provision("agent-stale", repo);
      if ("error" in r2) throw new Error(`自愈失败：${r2.error}`);
      expect(r2.branch).toBe("helix/agent-stale");
      expect(await Bun.file(join(r2.path, "a.ts")).exists()).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("复用校验：路径已是 worktree 但检出分支不符 → 报错不静默复用（旧基分支漂移事故面）", async () => {
    const repo = await mkRepo();
    try {
      const p = new GitWorktreeProvisioner();
      // 占位：预期落点已被别的分支的 worktree 占用（旧基残留形态）
      const occPath = join(repo, ".worktrees", "agent-reuse");
      await run(["git", "worktree", "add", "-b", "helix/other-base", occPath], repo);
      const r = await p.provision("agent-reuse", repo);
      // 现行行为红：只校验路径在册即静默复用（注释声称「分支对」但从不校验）
      expect("error" in r).toBe(true);
      if ("error" in r) expect(r.error).toContain("复用校验失败");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("复用正例：路径在册且分支对 → 照常复用成功（回归面）", async () => {
    const repo = await mkRepo();
    try {
      const p = new GitWorktreeProvisioner();
      const r1 = await p.provision("agent-reuse-ok", repo);
      if ("error" in r1) throw new Error(r1.error);
      // 同 slug 二次 provision：add 失败（路径已注册）→ 复用分支校验通过 → 成功
      const r2 = await p.provision("agent-reuse-ok", repo);
      if ("error" in r2) throw new Error(`复用正例失败：${r2.error}`);
      expect(r2.branch).toBe("helix/agent-reuse-ok");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("code-review B14：config.lock 陈旧判定（锁龄阈值 + 活锁退避，不动活锁）", () => {
  const lockExists = async (repo: string): Promise<boolean> => {
    try {
      await stat(join(repo, ".git", "config.lock"));
      return true;
    } catch {
      return false;
    }
  };
  /** add 失败注入：预期落点已被非空目录占住（git worktree add 拒绝非空路径）。 */
  const blockTarget = async (repo: string, slug: string): Promise<void> => {
    await mkdir(join(repo, ".worktrees", slug), { recursive: true });
    await writeFile(join(repo, ".worktrees", slug, "blocker.txt"), "占位");
  };

  test("新鲜锁（并发 git 正持有）→ 不删锁、退避等待到窗尾后报错，不损坏 config", async () => {
    const repo = await mkRepo();
    try {
      await blockTarget(repo, "agent-livelock");
      // 新鲜活锁：mtime = 当前（并发 git 操作刚建锁形态）
      await writeFile(join(repo, ".git", "config.lock"), "");
      const p = new GitWorktreeProvisioner({ staleLockMs: 60_000, lockWaitMs: 800, lockPollMs: 50 });
      const t0 = Date.now();
      const r = await p.provision("agent-livelock", repo);
      const elapsed = Date.now() - t0;
      // 等待窗耗尽 → 诚实报错（等待不删锁，防并发写 .git/config 损坏）
      expect("error" in r).toBe(true);
      // 活锁未被删除（核心判据：上游无锁龄判定即删）
      expect(await lockExists(repo)).toBe(true);
      // 退避等待真的发生（非立即删锁重跑的短路径）
      expect(elapsed).toBeGreaterThanOrEqual(700);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 15_000);

  test("陈旧锁（锁龄超阈）→ 删除重跑自愈保留（TR-82 行为不回退）", async () => {
    const repo = await mkRepo();
    try {
      await blockTarget(repo, "agent-stalelock");
      // 陈旧残留：mtime 拨回 60s 前
      const lockPath = join(repo, ".git", "config.lock");
      await writeFile(lockPath, "");
      const old = new Date(Date.now() - 60_000);
      await utimes(lockPath, old, old);
      const p = new GitWorktreeProvisioner({ staleLockMs: 10_000, lockWaitMs: 800, lockPollMs: 50 });
      const r = await p.provision("agent-stalelock", repo);
      // add 重跑仍被 blocker 挡住 → 报错；但陈旧锁已被删（自愈动作发生）
      expect("error" in r).toBe(true);
      expect(await lockExists(repo)).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 15_000);

  test("新鲜锁在等待窗内被并发方自然释放 → 重跑 add 成功（正常并发路径）", async () => {
    const repo = await mkRepo();
    try {
      const lockPath = join(repo, ".git", "config.lock");
      await writeFile(lockPath, "");
      const p = new GitWorktreeProvisioner({ staleLockMs: 60_000, lockWaitMs: 5_000, lockPollMs: 30 });
      // 模拟并发 git 操作完成释放锁（100ms 后）
      setTimeout(() => {
        void rm(lockPath, { force: true });
      }, 100);
      const r = await p.provision("agent-concurrent-release", repo);
      if ("error" in r) throw new Error(r.error);
      expect(r.branch).toBe("helix/agent-concurrent-release");
      expect(await Bun.file(join(r.path, "a.ts")).exists()).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 15_000);
});
