import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveMainRepoPath, resolveProjectArg } from "../../src/domain/kg/project-discovery";
import { kgReadProjects } from "../../src/adapters/driven/workspace-scan";

/**
 * D8 W-R2/W-R3：worktree 读穿透路径归一单测。
 *
 * - resolveMainRepoPath（domain 纯函数，零 IO）：路径含 /.worktrees/ 段 →
 *   剥该段归一回 git 仓根（+保留尾段）。W-R1 落点口径（权威 =
 *   GitWorktreeProvisioner 头注）：仓根 `.worktrees/<slug>`——生产
 *   isolated worktree 形如 `<ws>/<project>/.worktrees/agent-<hex>`，
 *   归一目标 = 拥有它的仓根（<ws>/<project>）。历史注记（code-review H1）：
 *   旧实现按幻影口径 `<workspaceRoot>/.worktrees/{project}-{slug}` 拆
 *   project 前缀——provisioner 从未落过该形态，仓内 slug（agent-<hex>/
 *   lowfix-w1）被拆成 `<仓根>/agent` 幻影路径，kgReadProjects 穿透空集、
 *   CodegraphTool 误报无索引、附着锚永不命中（三通道静默失效）。
 * - resolveProjectArg（domain 纯函数）：project 参数解析——绝对路径
 *   比对前做分隔符/尾斜杠归一（对齐同文件 projectRootOfAbs 先例，
 *   code-review 低危修复：win32 反斜杠/尾斜杠形态不因字面失配）。
 * - kgReadProjects（driven 读面项目域）：基座在 .worktrees 下 → 主仓有库即
 *   [主仓]（读面绝不新建库文件），无库空集；普通 workspace → 既有口径。
 */

describe("resolveMainRepoPath：worktree 路径 → 主仓归一（纯函数）", () => {
  test("非 worktree 路径 → 原样返回（普通项目根/工作区根/带尾斜杠均逐字节不变）", () => {
    expect(resolveMainRepoPath("/ws/helix")).toBe("/ws/helix");
    expect(resolveMainRepoPath("/ws")).toBe("/ws");
    expect(resolveMainRepoPath("/ws/")).toBe("/ws/");
    expect(resolveMainRepoPath("/ws/foo.worktrees/helix-x")).toBe("/ws/foo.worktrees/helix-x"); // 非独立段（无前导 /）不触发
    expect(resolveMainRepoPath("relative/path")).toBe("relative/path");
    expect(resolveMainRepoPath("")).toBe("");
  });

  test("生产仓内形态（W-R1 权威口径）：worktree 根 → git 仓根", () => {
    // SubagentLauncher provision(id)：slug = agent-<hex32>
    expect(resolveMainRepoPath("/ws/helix/.worktrees/agent-3f2a9b8c1d4e5f6")).toBe("/ws/helix");
    // slug 自身含连字符（任意 slug 形态，如手工/任务命名）
    expect(resolveMainRepoPath("/ws/helix/.worktrees/lowfix-w1")).toBe("/ws/helix");
    // 单项目工作区（daemon 直绑 git 仓自身）：仓根 = 工作区根
    expect(resolveMainRepoPath("/ws/.worktrees/agent-1a2b3c")).toBe("/ws");
  });

  test("worktree 深层路径 → 仓根等价路径（保留尾段——附着/文件语义）", () => {
    expect(resolveMainRepoPath("/ws/helix/.worktrees/agent-x/apps/daemon/src/x.ts")).toBe(
      "/ws/helix/apps/daemon/src/x.ts",
    );
  });

  test("尾斜杠：worktree 根/深层路径尾斜杠归一去尾", () => {
    expect(resolveMainRepoPath("/ws/helix/.worktrees/agent-x/")).toBe("/ws/helix");
    expect(resolveMainRepoPath("/ws/helix/.worktrees/agent-x/apps/")).toBe("/ws/helix/apps");
  });

  test(".worktrees 直结尾（无 worktree 目录名）→ 原样返回", () => {
    expect(resolveMainRepoPath("/ws/.worktrees/")).toBe("/ws/.worktrees/");
    expect(resolveMainRepoPath("/ws/.worktrees")).toBe("/ws/.worktrees"); // 无尾段（marker 不含尾斜杠）
  });

  test("嵌套 .worktrees：首个 /.worktrees/ 段生效（外层 worktree 管辖）", () => {
    expect(resolveMainRepoPath("/ws/helix/.worktrees/agent-x/.worktrees/other-y/z.ts")).toBe(
      "/ws/helix/.worktrees/other-y/z.ts",
    );
  });

  test("workspace 根为 /（.worktrees 紧贴根）→ 仓根 = /", () => {
    expect(resolveMainRepoPath("/.worktrees/agent-foo")).toBe("/");
    expect(resolveMainRepoPath("/.worktrees/agent-foo/a.ts")).toBe("/a.ts");
  });

  test("历史 workspace 级目录名（{project}-{slug} 形态遗留）→ 按仓内形态剥整段（归一为段前路径）", () => {
    // 遗留目录（如历史实验落点）目录名恰含连字符——不再拆 project 前缀：
    // 归一为 marker 前路径，按普通 workspace 扫描（无幻影 <ws>/agent 路径）
    expect(resolveMainRepoPath("/ws/.worktrees/helix-foo")).toBe("/ws");
    expect(resolveMainRepoPath("/ws/.worktrees/helix-d8-read-passthrough/apps/x.ts")).toBe("/ws/apps/x.ts");
  });

  test("win32 原生反斜杠路径（TR-95 目标平台集含 win32）：marker 命中归一，输出 POSIX 分隔符", () => {
    // 调用方传 path.join 原生反斜杠路径时不得静默失效（读穿透/附着穿透）
    expect(resolveMainRepoPath("C:\\ws\\helix\\.worktrees\\agent-x")).toBe("C:/ws/helix");
    expect(resolveMainRepoPath("C:\\ws\\helix\\.worktrees\\agent-x\\apps\\daemon\\x.ts")).toBe(
      "C:/ws/helix/apps/daemon/x.ts",
    );
    // 非 worktree win32 路径原样返回（逐字节不变，含分隔符）
    expect(resolveMainRepoPath("C:\\ws\\helix")).toBe("C:\\ws\\helix");
  });
});

describe("kgReadProjects：kg 读面项目域（W-R3 读穿透 + 既有口径不变）", () => {
  test("普通 workspace：既有口径不变（有 .helix-kg 的项目入列，absent 不入）", () => {
    const root = mkdtempSync(path.join(tmpdir(), "worktree-kg-read-a-"));
    try {
      mkdirSync(path.join(root, "proj-a", ".helix-kg"), { recursive: true });
      writeFileSync(path.join(root, "proj-a", ".helix-kg", "kg.db"), "stub");
      mkdirSync(path.join(root, "proj-b"), { recursive: true });
      expect(kgReadProjects(root)).toEqual([path.join(root, "proj-a")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("生产仓内形态基座 → 读穿透主仓：主仓有 kg.db → [主仓]（code-review H1 通道①）", () => {
    const root = mkdtempSync(path.join(tmpdir(), "worktree-kg-read-b-"));
    try {
      mkdirSync(path.join(root, "helix", ".helix-kg"), { recursive: true });
      writeFileSync(path.join(root, "helix", ".helix-kg", "kg.db"), "stub");
      mkdirSync(path.join(root, "helix", ".worktrees", "agent-d8-x"), { recursive: true });
      expect(kgReadProjects(path.join(root, "helix", ".worktrees", "agent-d8-x"))).toEqual([
        path.join(root, "helix"),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("仓内形态基座 + 主仓无 kg.db → 空集（读面绝不新建库文件——零建库副作用）", () => {
    const root = mkdtempSync(path.join(tmpdir(), "worktree-kg-read-c-"));
    try {
      const base = path.join(root, "helix", ".worktrees", "agent-d8-x");
      mkdirSync(base, { recursive: true });
      expect(kgReadProjects(base)).toEqual([]);
      // 零建库副作用：主仓与 worktree 内均未凭空产生 kg.db
      expect(existsSync(path.join(root, "helix", ".helix-kg", "kg.db"))).toBe(false);
      expect(existsSync(path.join(base, ".helix-kg", "kg.db"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("仓内形态基座（仓根无任何库痕迹）→ 空集", () => {
    const root = mkdtempSync(path.join(tmpdir(), "worktree-kg-read-d-"));
    try {
      const base = path.join(root, "ghost-proj", ".worktrees", "ghost-x");
      mkdirSync(base, { recursive: true });
      expect(kgReadProjects(base)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveProjectArg：project 参数解析（纯函数）", () => {
  const entries = [
    { name: "helix", path: "/ws/helix" },
    { name: "demo", path: "/ws/demo" },
  ];

  test("项目名与绝对路径命中（返回条目原生路径）", () => {
    expect(resolveProjectArg(entries, "helix")).toBe("/ws/helix");
    expect(resolveProjectArg(entries, "/ws/demo")).toBe("/ws/demo");
  });

  test("绝对路径比对前归一：尾斜杠不因字面失配（对齐 projectRootOfAbs 先例）", () => {
    expect(resolveProjectArg(entries, "/ws/helix/")).toBe("/ws/helix");
    expect(resolveProjectArg(entries, "/ws/helix///")).toBe("/ws/helix");
  });

  test("win32 反斜杠形态命中（归一后比对，返回仍为条目 POSIX 原生路径）", () => {
    expect(resolveProjectArg(entries, "\\ws\\helix")).toBe("/ws/helix");
  });

  test("全集外/空白 → undefined（调用方回 KG_E_PARAM）", () => {
    expect(resolveProjectArg(entries, "ghost")).toBeUndefined();
    expect(resolveProjectArg(entries, "/ws/ghost")).toBeUndefined();
    expect(resolveProjectArg(entries, "   ")).toBeUndefined();
  });
});
