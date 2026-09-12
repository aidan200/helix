import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, lstat } from "node:fs/promises";
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
