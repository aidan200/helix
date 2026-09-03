import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";

/**
 * TP-CL5-1（I 半）：core 四工具（bash/edit/read/write）经 CoreToolExecutor
 * **真实执行**于 tmp 沙箱 cwd（--home/tmp 均不触碰真实 home；相对路径
 * 全部落在 mkdtemp 沙箱内）。import 源与 bindToolContext 绑定的 A 半
 * 断言见 arch-guard（TP-CL5-1-A）。
 */

/** 本次进程创建的沙箱目录（afterAll 统一回收——TR-TEST-6 零残留，T4.3 补）。 */
const sandboxes: string[] = [];

/** 建一次性 tmp 沙箱（cwd 即沙箱根，工具用相对路径操作）。 */
function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "helix-t15-exec-"));
  sandboxes.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/** 宿主机 rg 定位（grep 为 rg 单后端：缺 rg 直接失败，不静默跳过）。 */
function hostRg(): string {
  const rg = Bun.which("rg");
  if (rg === null) throw new Error("测试前置失败：宿主机无 rg（brew install ripgrep）");
  return rg;
}

describe("TP-CL5-1（I）：四工具 tmp 沙箱真实执行", () => {
  test("bash：命令真实执行，stdout 回传", async () => {
    const ex = new CoreToolExecutor({ cwd: makeSandbox() });
    const r = await ex.execute({
      toolCallId: "t-bash-1",
      toolName: "bash",
      args: { command: "echo helix-bash-ok-42" },
    });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("helix-bash-ok-42");
  });

  test("write：文件真实落盘（含父目录创建）", async () => {
    const cwd = makeSandbox();
    const ex = new CoreToolExecutor({ cwd });
    const r = await ex.execute({
      toolCallId: "t-write-1",
      toolName: "write",
      args: { path: "out/written.txt", content: "HELIX-WRITE-43" },
    });
    expect(r.isError).toBe(false);
    expect(readFileSync(join(cwd, "out/written.txt"), "utf8")).toBe("HELIX-WRITE-43");
  });

  test("read：读回沙箱内既有文件内容", async () => {
    const cwd = makeSandbox();
    writeFileSync(join(cwd, "note.txt"), "HELIX-READ-44 演示文件\n", "utf8");
    const ex = new CoreToolExecutor({ cwd });
    const r = await ex.execute({
      toolCallId: "t-read-1",
      toolName: "read",
      args: { path: "note.txt" },
    });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("HELIX-READ-44");
  });

  test("edit：oldText→newText 替换真实生效于磁盘", async () => {
    const cwd = makeSandbox();
    writeFileSync(join(cwd, "target.txt"), "前缀\nTODO\n后缀\n", "utf8");
    const ex = new CoreToolExecutor({ cwd });
    const r = await ex.execute({
      toolCallId: "t-edit-1",
      toolName: "edit",
      args: { path: "target.txt", edits: [{ oldText: "TODO", newText: "DONE-45" }] },
    });
    expect(r.isError).toBe(false);
    expect(readFileSync(join(cwd, "target.txt"), "utf8")).toBe("前缀\nDONE-45\n后缀\n");
  });

  test("grep（自写工具）：目录遍历薄封装 + 纯匹配核，真实文件树命中", async () => {
    const cwd = makeSandbox();
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src/a.ts"), "export const marker = 'HELIX-GREP-77';\n", "utf8");
    writeFileSync(join(cwd, "src/b.md"), "# HELIX-GREP-77 手册\n", "utf8");
    const ex = new CoreToolExecutor({ cwd, grep: { rgPath: hostRg() } });
    const r = await ex.execute({
      toolCallId: "t-grep-1",
      toolName: "grep",
      args: { pattern: "HELIX-GREP-77", path: ".", glob: "*.ts" },
    });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("src/a.ts:1");
    expect(r.content).not.toContain("b.md"); // glob 过滤生效
  });

  test("bash 变体 exit≠0 → isError=true + 退出码错误信息（error 卡数据源）", async () => {
    const ex = new CoreToolExecutor({ cwd: makeSandbox() });
    const r = await ex.execute({
      toolCallId: "t-bash-err-1",
      toolName: "bash",
      args: { command: "echo boom >&2; exit 9" },
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("exited with code 9");
    expect(r.content).toContain("boom");
  });

  test("未知工具名 → 结构化 error 结果（不抛错、指明可用清单）", async () => {
    const ex = new CoreToolExecutor({ cwd: makeSandbox() });
    const r = await ex.execute({ toolCallId: "t-x", toolName: "no-such-tool", args: {} });
    expect(r.isError).toBe(true);
    for (const n of ["bash", "read", "write", "edit", "grep"]) {
      expect(r.content).toContain(n);
    }
  });

  test("resolveTools：按 profile 工具集装配五工具（bash/edit/read/write/grep）", async () => {
    const cwd = makeSandbox();
    const ex = new CoreToolExecutor({ cwd });
    const tools = ex.resolveTools(["bash", "read", "write", "edit", "grep"]);
    expect(tools.map((t) => t.name)).toEqual(["bash", "read", "write", "edit", "grep"]);
    for (const t of tools) {
      expect(typeof t.execute).toBe("function"); // AgentTool 形状（context 已闭包绑定）
    }
    // 装配出的工具（AgentTool，context 已绑定）直接执行：相对路径落沙箱
    const write = tools.find((t) => t.name === "write")!;
    const result = await write.execute("t-assembly-1", { path: "sandbox-probe.txt", content: "ok" } as never);
    expect(result.content.some((b) => (b as { type: string }).type === "text")).toBe(true);
    expect(readFileSync(join(cwd, "sandbox-probe.txt"), "utf8")).toBe("ok");
  });

  test("resolveTools：未注册的工具名 fail-fast（配置错误在装配期暴露）", () => {
    const ex = new CoreToolExecutor({ cwd: makeSandbox() });
    expect(() => ex.resolveTools(["bash", "find"])).toThrow(/find/);
  });
});
