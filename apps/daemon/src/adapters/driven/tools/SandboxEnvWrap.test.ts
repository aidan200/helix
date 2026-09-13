import { describe, expect, test } from "bun:test";

import { FileError } from "@earendil-works/pi-agent-core/node";

import { parseSandboxConfig } from "../../../domain/sandbox/SandboxPolicy";
import { wrapEnvForSandbox, type SandboxEnvTarget, type SandboxRuntime } from "./SandboxEnvWrap";

const WS = "/Users/x/work";
const HOME = "/Users/x/.helix";

/** mock base env（记录调用 + 受控返回）。 */
function mockEnv(): SandboxEnvTarget & {
  execCalls: string[];
  writeCalls: string[];
} {
  const execCalls: string[] = [];
  const writeCalls: string[] = [];
  return {
    cwd: WS,
    execCalls,
    writeCalls,
    async exec(command: string) {
      execCalls.push(command);
      return { ok: true as const, value: { stdout: "", stderr: "", exitCode: 0 } };
    },
    async absolutePath(p: string) {
      // 近似 NodeExecutionEnv.resolvePath：拼接 + 段折叠（与 domain foldPathSegments 同语义）
      const joined = p.startsWith("/") ? p : `${WS}/${p}`;
      const out: string[] = [];
      for (const seg of joined.split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") {
          if (out.length > 0) out.pop();
          continue;
        }
        out.push(seg);
      }
      return { ok: true as const, value: `/${out.join("/")}` };
    },
    async writeFile(path: string) {
      writeCalls.push(path);
      return { ok: true as const, value: undefined };
    },
    async appendFile() {
      return { ok: true as const, value: undefined };
    },
    async renameFile() {
      return { ok: true as const, value: undefined };
    },
    async remove() {
      return { ok: true as const, value: undefined };
    },
    async createDir() {
      return { ok: true as const, value: undefined };
    },
  };
}

function runtime(): SandboxRuntime {
  return { policy: parseSandboxConfig({ enabled: true }, WS, HOME), profileDir: "/tmp/sandbox-test-profiles", enforcer: "seatbelt" };
}

function fallbackRuntime(): SandboxRuntime {
  return { ...runtime(), enforcer: "fallback" };
}

describe("wrapEnvForSandbox 透传语义（零侵入保证）", () => {
  test("runtime 未注入 → 原 env 引用（零包装零差）", () => {
    const env = mockEnv();
    expect(wrapEnvForSandbox(env, undefined)).toBe(env);
  });

  test("mode=off → 原 env 引用", () => {
    const env = mockEnv();
    const off = { policy: parseSandboxConfig(null, WS, HOME), profileDir: "/tmp/x", enforcer: "seatbelt" as const };
    expect(wrapEnvForSandbox(env, off)).toBe(env);
  });
});

describe("wrapEnvForSandbox on 态", () => {
  test("writeFile 根内放行（透传 base）", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, runtime());
    const r = await w.writeFile(`${WS}/apps/x.ts`, "x");
    expect(r.ok).toBe(true);
    expect(env.writeCalls).toEqual([`${WS}/apps/x.ts`]);
  });

  test("writeFile 根外拒绝（permission_denied + 引导文案，不透传）", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, runtime());
    const r = await w.writeFile("/etc/hosts", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect((r.error as FileError).code).toBe("permission_denied");
      expect(r.error.message).toContain("沙箱拒绝写入");
    }
    expect(env.writeCalls).toEqual([]); // 未落盘
  });

  test("相对路径按 cwd 绝对化后判定", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, runtime());
    expect((await w.writeFile("apps/x.ts", "x")).ok).toBe(true); // → WS/apps/x.ts ✓
    const w2 = wrapEnvForSandbox(mockEnv(), runtime());
    // 相对路径逃逸（../outside）：绝对化 → /Users/x/outside ∉ roots
    const r = await w2.writeFile("../outside.txt", "x");
    expect(r.ok).toBe(false);
  });

  test("renameFile 双端判定 / remove/createDir 同面", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, runtime());
    expect((await w.renameFile(`${WS}/a`, "/etc/evil")).ok).toBe(false); // dst 越界
    expect((await w.remove("/etc/hosts")).ok).toBe(false);
    expect((await w.createDir(`${WS}/newdir`)).ok).toBe(true);
  });

  test("exec 改写形态：sandbox-exec 硬路径 + 单引号转义包裹原命令", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, runtime());
    await w.exec("echo 'hello world' > file.txt", { cwd: WS });
    const cmd = env.execCalls[0]!;
    expect(cmd.startsWith("/usr/bin/sandbox-exec -f ")).toBe(true);
    expect(cmd).toContain("-- "); // 命令分隔
    expect(cmd).toContain(`-c 'echo '\\''hello world'\\'' > file.txt'`); // 内层 -c 单引号转义（POSIX '\'' 形态）
  });

  test("exec 结果透传（exitCode/stderr 不被吞）", async () => {
    const env = mockEnv();
    env.exec = async () => ({
      ok: true as const,
      value: { stdout: "out", stderr: "err", exitCode: 42 },
    });
    const w = wrapEnvForSandbox(env, runtime());
    const r = await w.exec("whatever");
    expect(r.ok && r.value.exitCode).toBe(42);
  });

  test("exec 沙箱拒绝时 stderr 追加引导文案（原始输出保留）", async () => {
    const env = mockEnv();
    env.exec = async () => ({
      ok: true as const,
      value: { stdout: "", stderr: "sh: /etc/hosts: Operation not permitted", exitCode: 1 },
    });
    const w = wrapEnvForSandbox(env, runtime());
    const r = await w.exec("x");
    expect(r.ok && r.value.stderr).toContain("Operation not permitted"); // 原始保留
    expect(r.ok && r.value.stderr).toContain("Seatbelt"); // 引导追加
  });
});

describe("wrapEnvForSandbox fallback 态（规则级执行器——U0c 二期）", () => {
  test("重定向写 workspace 外 → 拒执行（exitCode 126 + 出路文案，不透传）", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, fallbackRuntime());
    const r = await w.exec("echo x > /etc/hosts");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.exitCode).toBe(126);
      expect(r.value.stderr).toContain("规则级防护");
      expect(r.value.stderr).toContain("/etc/hosts");
      expect(r.value.stderr).toContain("write/edit");
    }
    expect(env.execCalls).toEqual([]); // 未执行
  });

  test("workspace 内重定向 → 放行原样透传（命令未改写）", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, fallbackRuntime());
    const r = await w.exec("echo x > out.txt");
    expect(r.ok && r.value.exitCode).toBe(0);
    expect(env.execCalls).toEqual(["echo x > out.txt"]); // 无 sandbox-exec 改写
  });

  test("cd-aware 相对路径越界（cd /etc && touch hosts）→ 拒", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, fallbackRuntime());
    const r = await w.exec("cd /etc && echo x > hosts");
    expect(r.ok && r.value.exitCode).toBe(126);
    expect(env.execCalls).toEqual([]);
  });

  test("不可判定类（python -c / make / test）→ 无候选放行", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, fallbackRuntime());
    expect((await w.exec("python3 -c 'open(\"/etc/x\",\"w\")'")).ok).toBe(true);
    expect(env.execCalls.length).toBe(1); // 放行（L2 感知对账兜底——明知的取舍）
  });

  test("只读命令零候选 → 放行", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, fallbackRuntime());
    await w.exec("ls -la | grep foo; cat README.md");
    expect(env.execCalls.length).toBe(1);
  });

  test("工具写判定与 seatbelt 同构（fallback 下写方法族照常）", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, fallbackRuntime());
    expect((await w.writeFile("/etc/hosts", "x")).ok).toBe(false);
    expect(env.writeCalls).toEqual([]);
  });
});
