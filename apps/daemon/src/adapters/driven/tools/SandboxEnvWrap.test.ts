import { describe, expect, test } from "bun:test";

import {
  applyShellOutputUpdate,
  BACKGROUND_CONTEXT,
  FileError,
  truncateTail,
  type Context,
  type ExecutionError,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type ShellOutputMetadata,
  type ShellOutputView,
} from "../../../adapters/driven/tools/vendor/pi-harness";

import { parseSandboxConfig } from "../../../domain/sandbox/SandboxPolicy";
import { wrapEnvForSandbox, type SandboxEnvTarget, type SandboxRuntime } from "./SandboxEnvWrap";

const WS = "/Users/x/work";
const HOME = "/Users/x/.helix";
const CTX: Context = BACKGROUND_CONTEXT;

/** 文本 → 无截断输出元数据（与包装内 metadataOfText 同口径）。 */
function metadataOfText(text: string): ShellOutputMetadata {
  const { content: _content, ...truncation } = truncateTail(text);
  void _content;
  return { truncation };
}

/** 假 exec 受控产物（pi 0.85 形态：输出经 onUpdate 投递，结果只带 exitCode+元数据）。 */
interface FakeExecOutcome {
  readonly text: string;
  readonly exitCode: number;
}

/** mock base env（记录调用 + 受控返回；输出经 options.onUpdate 仿真投递）。 */
function mockEnv(outcome: FakeExecOutcome = { text: "", exitCode: 0 }): SandboxEnvTarget & {
  execCalls: string[];
  execOptions: (ShellExecOptions | undefined)[];
  writeCalls: string[];
} {
  const execCalls: string[] = [];
  const execOptions: (ShellExecOptions | undefined)[] = [];
  const writeCalls: string[] = [];
  return {
    cwd: WS,
    execCalls,
    execOptions,
    writeCalls,
    async exec(command: string, options: ShellExecOptions | undefined, context: Context) {
      execCalls.push(command);
      execOptions.push(options);
      const metadata = metadataOfText(outcome.text);
      options?.onUpdate?.({ kind: "replace", output: { text: outcome.text, ...metadata } }, context);
      const value: ShellExecResult = { exitCode: outcome.exitCode, ...metadata };
      return { ok: true as const, value };
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

/** caller 侧输出收集器（fold onUpdate 增量为最终视图——bash 工具同口径）。 */
function collectOutput(): { readonly onUpdate: NonNullable<ShellExecOptions["onUpdate"]>; readonly text: () => string } {
  let view: ShellOutputView | undefined;
  return {
    onUpdate: (update) => {
      view = applyShellOutputUpdate(view, update);
    },
    text: () => view?.text ?? "",
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
    const r = await w.writeFile(`${WS}/apps/x.ts`, "x", CTX);
    expect(r.ok).toBe(true);
    expect(env.writeCalls).toEqual([`${WS}/apps/x.ts`]);
  });

  test("writeFile 根外拒绝（permission_denied + 引导文案，不透传）", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, runtime());
    const r = await w.writeFile("/etc/hosts", "x", CTX);
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
    expect((await w.writeFile("apps/x.ts", "x", CTX)).ok).toBe(true); // → WS/apps/x.ts ✓
    const w2 = wrapEnvForSandbox(mockEnv(), runtime());
    // 相对路径逃逸（../outside）：绝对化 → /Users/x/outside ∉ roots
    const r = await w2.writeFile("../outside.txt", "x", CTX);
    expect(r.ok).toBe(false);
  });

  test("renameFile 双端判定 / remove/createDir 同面", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, runtime());
    expect((await w.renameFile(`${WS}/a`, "/etc/evil", CTX)).ok).toBe(false); // dst 越界
    expect((await w.remove("/etc/hosts", undefined, CTX)).ok).toBe(false);
    expect((await w.createDir(`${WS}/newdir`, undefined, CTX)).ok).toBe(true);
  });

  test("exec 改写形态：sandbox-exec 硬路径 + 单引号转义包裹原命令", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, runtime());
    await w.exec("echo 'hello world' > file.txt", { cwd: WS }, CTX);
    const cmd = env.execCalls[0]!;
    expect(cmd.startsWith("/usr/bin/sandbox-exec -f ")).toBe(true);
    expect(cmd).toContain("-- "); // 命令分隔
    expect(cmd).toContain(`-c 'echo '\\''hello world'\\'' > file.txt'`); // 内层 -c 单引号转义（POSIX '\'' 形态）
  });

  test("exec 结果透传（exitCode 不被吞）", async () => {
    const env = mockEnv({ text: "out", exitCode: 42 });
    const w = wrapEnvForSandbox(env, runtime());
    const r = await w.exec("whatever", undefined, CTX);
    expect(r.ok && r.value.exitCode).toBe(42);
  });

  test("exec 沙箱拒绝时输出尾部追加引导文案（原始输出保留，经 caller onUpdate 投递）", async () => {
    const env = mockEnv({ text: "sh: /etc/hosts: Operation not permitted", exitCode: 1 });
    const w = wrapEnvForSandbox(env, runtime());
    const out = collectOutput();
    const r = await w.exec("x", { onUpdate: out.onUpdate }, CTX);
    expect(r.ok && r.value.exitCode).toBe(1);
    expect(out.text()).toContain("Operation not permitted"); // 原始保留
    expect(out.text()).toContain("helix 沙箱"); // 引导追加
  });

  test("bounded capture：caller 未给 capture 时包装补默认 bounded capture（分类有源、输出不裸奔）", async () => {
    const env = mockEnv({ text: "hello", exitCode: 0 });
    const w = wrapEnvForSandbox(env, runtime());
    await w.exec("echo hello", undefined, CTX);
    const options = env.execOptions[0];
    expect(options?.capture?.limits.maxBytes).toBeGreaterThan(0);
    expect(options?.capture?.limits.maxLines).toBeGreaterThan(0);
    expect(typeof options?.onUpdate).toBe("function"); // 旁路收集器挂入
  });

  test("bounded capture：caller 显式 capture/onUpdate 原样透传（包装只旁路不替换）", async () => {
    const env = mockEnv({ text: "abc", exitCode: 0 });
    const w = wrapEnvForSandbox(env, runtime());
    const out = collectOutput();
    const capture = { limits: { maxBytes: 1024, maxLines: 10, retain: "head" as const }, spill: true };
    await w.exec("echo abc", { capture, onUpdate: out.onUpdate }, CTX);
    expect(env.execOptions[0]?.capture).toEqual(capture); // caller capture 不被覆盖
    expect(out.text()).toBe("abc"); // caller 仍收到投递
  });
});

describe("wrapEnvForSandbox fallback 态（规则级执行器——U0c 二期）", () => {
  test("重定向写 workspace 外 → 拒执行（exitCode 126 + 出路文案经 onUpdate 投递，不透传）", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, fallbackRuntime());
    const out = collectOutput();
    const r = await w.exec("echo x > /etc/hosts", { onUpdate: out.onUpdate }, CTX);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.exitCode).toBe(126);
    }
    expect(out.text()).toContain("规则级防护");
    expect(out.text()).toContain("/etc/hosts");
    expect(out.text()).toContain("write/edit");
    expect(env.execCalls).toEqual([]); // 未执行
  });

  test("workspace 内重定向 → 放行原样透传（命令未改写）", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, fallbackRuntime());
    const r = await w.exec("echo x > out.txt", undefined, CTX);
    expect(r.ok && r.value.exitCode).toBe(0);
    expect(env.execCalls).toEqual(["echo x > out.txt"]); // 无 sandbox-exec 改写
  });

  test("cd-aware 相对路径越界（cd /etc && touch hosts）→ 拒", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, fallbackRuntime());
    const r = await w.exec("cd /etc && echo x > hosts", undefined, CTX);
    expect(r.ok && r.value.exitCode).toBe(126);
    expect(env.execCalls).toEqual([]);
  });

  test("不可判定类（python -c / make / test）→ 无候选放行", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, fallbackRuntime());
    expect((await w.exec("python3 -c 'open(\"/etc/x\",\"w\")'", undefined, CTX)).ok).toBe(true);
    expect(env.execCalls.length).toBe(1); // 放行（L2 感知对账兜底——明知的取舍）
  });

  test("只读命令零候选 → 放行", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, fallbackRuntime());
    await w.exec("ls -la | grep foo; cat README.md", undefined, CTX);
    expect(env.execCalls.length).toBe(1);
  });

  test("cacheEnv merge：缺省键兑底注入 + options.env 显式值优先", async () => {
    const env = mockEnv();
    const rt: SandboxRuntime = {
      ...fallbackRuntime(),
      cacheEnv: { UV_CACHE_DIR: "/h/tool-cache/uv", npm_config_cache: "/h/tool-cache/npm" },
    };
    const w = wrapEnvForSandbox(env, rt);
    await w.exec("ls", undefined, CTX);
    expect(env.execOptions[0]?.env).toEqual({ UV_CACHE_DIR: "/h/tool-cache/uv", npm_config_cache: "/h/tool-cache/npm" });
    await w.exec("ls", { env: { UV_CACHE_DIR: "/custom" } }, CTX);
    expect(env.execOptions[1]?.env).toEqual({ UV_CACHE_DIR: "/custom", npm_config_cache: "/h/tool-cache/npm" });
  });

  test("cacheEnv 缺省（runtime 未携带）→ options 原样透传", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, fallbackRuntime());
    await w.exec("ls", { timeout: 5 }, CTX);
    expect(env.execOptions[0]).toEqual({ timeout: 5 });
  });

  test("工具写判定与 seatbelt 同构（fallback 下写方法族照常）", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, fallbackRuntime());
    expect((await w.writeFile("/etc/hosts", "x", CTX)).ok).toBe(false);
    expect(env.writeCalls).toEqual([]);
  });
});

describe("wrapEnvForSandbox helper 态（Windows 受限 token——U0c 二期②接线）", () => {
  const helperRt = (): SandboxRuntime => ({ ...fallbackRuntime(), enforcer: "helper", helperPath: "C:\\tools\\helix-sandbox-helper.exe" });

  test("exec 改写为 helper 调用（--writable 逐根 + bash -c 原命令）", async () => {
    const env = mockEnv();
    const w = wrapEnvForSandbox(env, helperRt());
    await w.exec("echo x > out.txt", undefined, CTX);
    const call = env.execCalls[0] ?? "";
    expect(call).toContain("helix-sandbox-helper.exe");
    expect(call).toContain("--writable");
    expect(call).toContain("-- bash -c");
    expect(call).toContain("echo x > out.txt");
  });

  test("violation 归一附加（helper 非零 + Access is denied → 引导文案经 onUpdate 追加）", async () => {
    const env = mockEnv({ text: "Access is denied. (os error 5)", exitCode: 1 });
    const w = wrapEnvForSandbox(env, helperRt());
    const out = collectOutput();
    const r = await w.exec("echo x > C:\\Windows\\evil.txt", { onUpdate: out.onUpdate }, CTX);
    expect(r.ok && r.value.exitCode).toBe(1);
    expect(out.text()).toContain("helix 沙箱");
  });
});
