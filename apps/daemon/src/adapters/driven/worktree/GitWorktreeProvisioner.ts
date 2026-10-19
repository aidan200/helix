import { execFile } from "node:child_process";
import { symlink, mkdir, realpath, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type {
  WorktreeProvisionResult,
  WorktreeProvisionerPort,
} from "../../../application/ports/outbound/WorktreeProvisionerPort";

/**
 * GitWorktreeProvisioner —— WorktreeProvisionerPort 的 git 真体（U3）。
 *
 * 落点口径（W-R1）：仓根 `.worktrees/<slug>`；分支 `helix/<slug>`。
 * 工程坑处置（kg 既验知识机械内化）：
 * - TR-143：worktree 不继承 node_modules——主仓根/apps/shell/apps/daemon/
 *   packages/protocol 四处软链（bun workspaces 按包装配面），软链 untracked
 *   不入提交；
 * - TR-82：主仓 .git/config.lock 残留会让 worktree add 失败——检测到锁文件
 *   且锁龄超阈才删锁重跑（评审 B14：并发 git 操作正持有的新鲜活锁不可删，
 *   退避等待其自然释放）。
 *
 * exec 通道：node execFile（非 Bun.spawn——沙箱内 Bun.spawn 的 posix_spawn
 * 对 /private 前缀 cwd 形态 ENOENT，execFile 不受影响；bashSnapshot 同款
 * 通道选择）。软链/建目录/删锁走 node fs（同因，不 Shell out 到 rm——
 * node fs 单进程内完成，无 PATH/引号面）。
 */
const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;

/** config.lock 处置策略（评审 B14 注入面：测试假时钟；缺省 = 生产值）。 */
export interface WorktreeLockPolicy {
  /** 陈旧锁龄阈值（ms）：锁龄超过即判陈旧残留（TR-82）删除重跑。缺省 10s。 */
  readonly staleLockMs?: number;
  /** 新鲜锁等待窗（ms）：并发 git 操作持锁期的退避等待上限——超窗仍新鲜则
   *  放弃不动锁（防损坏 .git/config），交上层报错/重试。缺省 5s。 */
  readonly lockWaitMs?: number;
  /** 等待轮询间隔（ms）。缺省 250ms。 */
  readonly lockPollMs?: number;
}

export class GitWorktreeProvisioner implements WorktreeProvisionerPort {
  private readonly staleLockMs: number;
  private readonly lockWaitMs: number;
  private readonly lockPollMs: number;

  constructor(policy: WorktreeLockPolicy = {}) {
    this.staleLockMs = policy.staleLockMs ?? 10_000;
    this.lockWaitMs = policy.lockWaitMs ?? 5_000;
    this.lockPollMs = policy.lockPollMs ?? 250;
  }

  async provision(slug: string, baseCwd: string): Promise<WorktreeProvisionResult> {
    let root: string;
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
        cwd: baseCwd,
        timeout: GIT_TIMEOUT_MS,
      });
      root = stdout.trim();
    } catch {
      return { error: `工作目录不是 git 仓（cwd=${baseCwd}）——isolated 档需要 git 仓` };
    }
    const worktreePath = `${root.replace(/\/+$/, "")}/.worktrees/${slug}`;
    const branch = `helix/${slug}`;
    const addArgs = ["worktree", "add", "-b", branch, worktreePath];
    let added = await this.gitOk(addArgs, root);
    if (!added) {
      // TR-82 + 评审 B14：add 失败且锁存在 ≠ 陈旧——并行 isolated spawn 同仓
      // 竞态下锁可能正被并发 git 操作持有，删活锁后并发写 .git/config 有损坏
      // 风险。锁龄判定 + 活锁退避见 recoverUnderConfigLock。
      added = await this.recoverUnderConfigLock(root, `${root}/.git/config.lock`, addArgs);
    }
    if (!added) {
      // 既有 worktree（重试/残留）：路径在册 + 分支对 → 复用；路径不在册但分支滞留
      // → 陈旧分支死锁自愈；否则报错
      let listed: string | undefined;
      try {
        const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
          cwd: root,
          timeout: GIT_TIMEOUT_MS,
        });
        listed = stdout;
      } catch {
        listed = undefined;
      }
      // porcelain 块（空行分隔）定位本路径条目
      const entry = listed
        ?.split("\n\n")
        .find((block) => block.split("\n").includes(`worktree ${worktreePath}`));
      if (entry !== undefined) {
        // code-review M：复用前校验检出分支（原代码只校验路径在册——旧基分支
        // 残留 worktree 被静默复用即基线漂移事故；注释曾声称「分支对」但从不校验）
        const branchLine = entry.split("\n").find((l) => l.startsWith("branch "));
        if (branchLine !== `branch refs/heads/${branch}`) {
          return {
            error: `worktree 复用校验失败（${worktreePath} 检出 ${branchLine ?? "detached"} ≠ refs/heads/${branch}）——请人工清理该 worktree 后重试`,
          };
        }
        // 复用：分支已检出的树不动（软链补齐即可）
      } else {
        // code-review M：陈旧分支死锁自愈——git worktree remove 不删分支，分支存在
        // 且无 worktree 时 add -b 必失败、同 slug 重试永久失败。删陈旧分支重试一次。
        let branchExists = false;
        try {
          await execFileAsync("git", ["show-ref", "--verify", `refs/heads/${branch}`], {
            cwd: root,
            timeout: GIT_TIMEOUT_MS,
          });
          branchExists = true;
        } catch {
          branchExists = false;
        }
        if (branchExists) {
          // F2 #5：陈旧分支里可能压着上一个 worktree 未合入的提交（remove() 不删
          // 分支）——强删会静默丢工作。只有「分支提交全部已在基分支（HEAD）上」
          // 才允许自愈删除；否则如实报错交人工裁决（合并或手工删）。
          const merged = await this.gitOk(["merge-base", "--is-ancestor", branch, "HEAD"], root);
          if (!merged) {
            return {
              error:
                `陈旧分支 ${branch} 含未合入提交（不在 HEAD 祖先链上）——拒绝强删以免丢失工作：` +
                `请先合并该分支，或人工执行 git branch -D ${branch} 后重试`,
            };
          }
          try {
            await execFileAsync("git", ["branch", "-D", branch], { cwd: root, timeout: GIT_TIMEOUT_MS });
            added = await this.gitOk(addArgs, root);
          } catch {
            /* 删分支失败走下方报错 */
          }
        }
        if (!added) {
          return { error: `git worktree add 失败（目标 ${worktreePath}）` };
        }
      }
    }
    // TR-143：四处软链（主仓 → worktree；已存在跳过——软链 untracked 幂等）
    const linkTargets = [
      "node_modules",
      "apps/shell/node_modules",
      "apps/daemon/node_modules",
      "packages/protocol/node_modules",
    ];
    for (const rel of linkTargets) {
      const src = `${root}/${rel}`;
      const dst = `${worktreePath}/${rel}`;
      if (!(await this.existsDir(src))) continue; // 主仓无该目录（如 protocol 未装）跳过
      try {
        if (await this.existsDir(dst)) continue;
        await mkdir(dirname(dst), { recursive: true });
        await symlink(src, dst, "dir");
      } catch {
        /* 软链失败不阻断——测试若需 node_modules 会显式暴露；此处保守继续 */
      }
    }
    // realpath 归一（/var → /private/var 等 macOS 符号链接形态——SBPL/护栏同源坑）
    const real = await realpath(worktreePath).catch(() => undefined);
    return { path: real ?? worktreePath, branch };
  }

  /**
   * config.lock 恢复（评审 B14）：锁龄判定 + 活锁退避。
   * - 初始无锁：非锁因失败——不处置（上游语义保持，走既有探测/报错路径）；
   * - 锁龄 ≥ staleLockMs：陈旧残留（TR-82）→ 删锁重跑一次；
   * - 锁龄 < staleLockMs：并发 git 操作可能正持有 → 轮询等待其自然释放后重跑；
   *   等待窗耗尽仍新鲜 → 放弃（不删活锁），交上层报错/重试。
   * 返回 add 是否成功。
   */
  private async recoverUnderConfigLock(
    root: string,
    lockPath: string,
    addArgs: readonly string[],
  ): Promise<boolean> {
    if (!(await Bun.file(lockPath).exists())) return false; // 无锁：非锁因失败，不处置
    const deadline = Date.now() + this.lockWaitMs;
    for (;;) {
      let age: number;
      try {
        age = Date.now() - (await stat(lockPath)).mtimeMs;
      } catch {
        // 等待期间锁被并发方释放：重跑一次 add
        return await this.gitOk(addArgs, root);
      }
      if (age >= this.staleLockMs) {
        try {
          await unlink(lockPath);
          return await this.gitOk(addArgs, root); // 陈旧残留：删锁重跑一次
        } catch {
          return false; // 删锁失败走既有探测/报错
        }
      }
      if (Date.now() >= deadline) return false; // 活锁不动，等待窗耗尽
      await new Promise((r) => setTimeout(r, this.lockPollMs));
    }
  }

  async remove(path: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
        cwd: path,
        timeout: GIT_TIMEOUT_MS,
      });
      await execFileAsync("git", ["worktree", "remove", "--force", path], {
        cwd: stdout.trim(),
        timeout: GIT_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async existsDir(p: string): Promise<boolean> {
    try {
      return (await stat(p)).isDirectory();
    } catch {
      return false;
    }
  }

  private async gitOk(args: readonly string[], cwd: string): Promise<boolean> {
    try {
      await execFileAsync("git", [...args], { cwd, timeout: GIT_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }
}
