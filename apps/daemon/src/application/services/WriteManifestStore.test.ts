import { describe, expect, it } from "bun:test";
import { $ } from "bun";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WriteManifestStore, manifestDir, readManifest, type ManifestFsPort } from "./WriteManifestStore";

const realFs: ManifestFsPort = {
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  writeFile: async (p, body) => {
    await writeFile(p, body, "utf8");
  },
  rename: async (from, to) => {
    await rename(from, to);
  },
  readFile: (p) => readFile(p, "utf8"),
  readdir: (dir) => readdir(dir),
  remove: async (p) => {
    await rm(p, { force: true });
  },
};

async function readManifestAt(root: string, sid: string) {
  return readManifest(realFs, root, sid);
}

describe("WriteManifestStore（U1 manifest 落盘）", () => {
  async function tmpRoot(): Promise<string> {
    return mkdtemp(join(tmpdir(), "wf-manifest-"));
  }

  it("notify 去抖 250ms 合并写；flush 立即落盘（原子写 tmp+rename）", async () => {
    const root = await tmpRoot();
    try {
      const store = new WriteManifestStore({ manifestRoot: () => root, fs: realFs });
      store.notify("sess-a", ["/w/p/f1.ts"]);
      store.notify("sess-a", ["/w/p/f1.ts", "/w/p/f2.ts"]); // 第二次重置计时
      await store.flush("sess-a");
      const m = await readManifestAt(root, "sess-a");
      expect(m?.sessionId).toBe("sess-a");
      expect([...(m?.paths ?? [])].sort()).toEqual(["/w/p/f1.ts", "/w/p/f2.ts"]);
      expect(store.pendingSessions()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drop 删 manifest + 取消在途去抖；readManifest 容错缺文件/坏 JSON", async () => {
    const root = await tmpRoot();
    try {
      const store = new WriteManifestStore({ manifestRoot: () => root, fs: realFs });
      store.notify("sess-a", ["/w/p/f1.ts"]);
      await store.drop("sess-a");
      expect(await readManifestAt(root, "sess-a")).toBeUndefined();
      expect(store.pendingSessions()).toEqual([]);

      await mkdir(root, { recursive: true });
      await writeFile(join(root, "bad.json"), "{not json", "utf8");
      expect(await readManifestAt(root, "bad")).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("flushAll 关停钩子：全部在途立即落盘", async () => {
    const root = await tmpRoot();
    try {
      const store = new WriteManifestStore({ manifestRoot: () => root, fs: realFs });
      store.notify("sess-a", ["/a"]);
      store.notify("sess-b", ["/b"]);
      await store.flushAll();
      expect((await readManifestAt(root, "sess-a"))?.paths).toEqual(["/a"]);
      expect((await readManifestAt(root, "sess-b"))?.paths).toEqual(["/b"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("manifestDir 路径约定：daemon home 下 write-facts", () => {
    expect(manifestDir("/Users/x/.helix")).toBe("/Users/x/.helix/write-facts");
  });
});

/** 真实 git fixture + 真 pre-commit hook 行为断言（TR-63 复现矩阵）。 */
describe("pre-commit hook 护栏（TR-63 场景）", () => {
  async function fixtureRepo(): Promise<{ repo: string; manifests: string; hook: string }> {
    const base = await mkdtemp(join(tmpdir(), "wf-hook-"));
    const repo = join(base, "repo");
    const manifests = join(base, "write-facts");
    await mkdir(repo, { recursive: true });
    await mkdir(manifests, { recursive: true });
    await $`git -C ${repo} init -q`;
    await $`git -C ${repo} config user.email t@t`;
    await $`git -C ${repo} config user.name t`;
    // 真 hook（从仓内拷贝，保真）——core.hooksPath 指入
    const hooksDir = join(base, "hooks");
    await mkdir(hooksDir, { recursive: true });
    const hook = join(hooksDir, "pre-commit");
    await writeFile(hook, await readFile(join(import.meta.dir, "../../../../../.githooks/pre-commit"), "utf8"));
    await $`chmod +x ${hook}`;
    await $`git -C ${repo} config core.hooksPath ${hooksDir}`;
    return { repo, manifests, hook };
  }

  async function commit(repo: string, env: Record<string, string>): Promise<{ ok: boolean; stderr: string }> {
    // TR-62 姊妹坑洗涮：测试进程自身携带 daemon 注入的 HELIX_* env（bash
    // 工具调用注入），...process.env 会泄漏给 hook——放行口①的「无 env（人类）」
    // 前提被真实 manifest 破坏。先全量剥除 HELIX_*（git 子进程零消费），
    // 再合入用例显式定义的键（测试自足：场景由显式传参定义）。
    const scrubbed = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("HELIX_")),
    );
    const proc = Bun.spawn(["git", "-C", repo, "commit", "-m", "t"], {
      env: { ...scrubbed, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderrText] = await Promise.all([new Response(proc.stderr).text()]);
    const code = await proc.exited;
    return { ok: code === 0, stderr: stderrText };
  }

  it("TR-63 复现：A 会话 commit 卷入 B 在制文件 → 拒绝；B 文件留工作区", async () => {
    const { repo, manifests } = await fixtureRepo();
    try {
      // B 会话（sess-b）写了 f-b.ts 但未提交；A 会话（sess-a）写 f-a.ts
      await writeFile(join(repo, "f-a.ts"), "a", "utf8");
      await writeFile(join(repo, "f-b.ts"), "b", "utf8");
      await writeFile(
        join(manifests, "sess-a.json"),
        JSON.stringify({ sessionId: "sess-a", updatedAt: Date.now(), paths: [join(repo, "f-a.ts")] }),
        "utf8",
      );
      await $`git -C ${repo} add .`; // A 的危险操作：全暂存（含 B 的在制文件）
      const r = await commit(repo, { HELIX_SESSION_ID: "sess-a", HELIX_WRITE_FACTS_DIR: manifests });
      expect(r.ok).toBe(false);
      expect(r.stderr).toContain("write-facts");
      expect(r.stderr).toContain("f-b.ts");
      // B 的文件留在工作区（未进提交）：首次提交被拒 = 仓无 HEAD（成功信号本身）；
      // 若有 HEAD（重试路径）则新提交不含 f-b.ts
      // HEAD 存在性经 rev-parse 输出判空（失败/无 HEAD 输出空串——绕开 exitCode 类型面）
      const headRef = (await $`git -C ${repo} rev-parse --verify -q HEAD`.nothrow().quiet().text()).trim();
      const headExists = headRef.length > 0;
      if (headExists) {
        const headFiles = (await $`git -C ${repo} ls-tree --name-only HEAD`.text()).trim();
        expect(headFiles).not.toContain("f-b.ts");
      } else {
        expect(r.ok).toBe(false); // 首次提交被拒——护栏生效的直接证据
      }
    } finally {
      await rm(join(repo, ".."), { recursive: true, force: true });
    }
  });

  it("正常流：本会话写过的文件提交畅通", async () => {
    const { repo, manifests } = await fixtureRepo();
    try {
      await writeFile(join(repo, "mine.ts"), "m", "utf8");
      await writeFile(
        join(manifests, "sess-a.json"),
        JSON.stringify({ sessionId: "sess-a", updatedAt: Date.now(), paths: [join(repo, "mine.ts")] }),
        "utf8",
      );
      await $`git -C ${repo} add mine.ts`;
      const r = await commit(repo, { HELIX_SESSION_ID: "sess-a", HELIX_WRITE_FACTS_DIR: manifests });
      // 注意：真 hook 会继续跑 typecheck-all.sh——fixture 仓没有该脚本。
      // hook 内 exec 失败会 exit 1，但护栏段本身已放行（stderr 无 write-facts 拒绝文案）。
      if (!r.ok) {
        expect(r.stderr).not.toContain("write-facts");
      }
    } finally {
      await rm(join(repo, ".."), { recursive: true, force: true });
    }
  });

  it("放行口①：无 HELIX_SESSION_ID（人类提交）→ 护栏不设防", async () => {
    const { repo, manifests } = await fixtureRepo();
    try {
      await writeFile(join(repo, "other.ts"), "o", "utf8"); // 无 manifest 覆盖
      await $`git -C ${repo} add other.ts`;
      const r = await commit(repo, {}); // 无 env
      if (!r.ok) {
        expect(r.stderr).not.toContain("write-facts"); // 护栏未拦（可能只是 typecheck 脚本缺）
      }
    } finally {
      await rm(join(repo, ".."), { recursive: true, force: true });
    }
  });

  it("放行口②：manifest 缺失（daemon 未跑）→ 放行 + 警示", async () => {
    const { repo, manifests } = await fixtureRepo();
    try {
      await writeFile(join(repo, "x.ts"), "x", "utf8");
      await $`git -C ${repo} add x.ts`;
      const r = await commit(repo, { HELIX_SESSION_ID: "sess-gone", HELIX_WRITE_FACTS_DIR: manifests });
      expect(r.stderr).toContain("manifest 缺失"); // 警示可见
      if (!r.ok) {
        expect(r.stderr).not.toContain("从未写过");
      }
    } finally {
      await rm(join(repo, ".."), { recursive: true, force: true });
    }
  });

  it("放行口④：allowlist 路径（.helix/ 过程产物）不拦", async () => {
    const { repo, manifests } = await fixtureRepo();
    try {
      await mkdir(join(repo, ".helix"), { recursive: true });
      await writeFile(join(repo, ".helix", "state.json"), "{}", "utf8");
      await $`git -C ${repo} add .helix/state.json`;
      const r = await commit(repo, { HELIX_SESSION_ID: "sess-a", HELIX_WRITE_FACTS_DIR: manifests });
      if (!r.ok) {
        expect(r.stderr).not.toContain(".helix/state.json"); // allowlist 未拦
      }
    } finally {
      await rm(join(repo, ".."), { recursive: true, force: true });
    }
  });
});
