/**
 * 沙箱 env 包装（零侵入装饰层——照 TurnDiffEnvWrap 的包装形态先例）。
 *
 * 包装面：
 * - exec（bash 唯一通道）：改写 command 为
 *   `/usr/bin/sandbox-exec -f <profile> -- <shell> -c <原命令>`（单引号转义，
 *   内层 shell 用 $SHELL 兜底 /bin/bash——shellPath 是 private 读不到取近似；
 *   macOS 26 实测 /bin/sh 在沙箱内 abort trap 6，禁用）。
 *   沙箱拒绝时 stderr 尾部追加引导文案（violation 归一）。
 * - 写方法族（writeFile/appendFile/renameFile/remove/createDir）：路径 TS 判定
 *   ∈ writableRoots，越界返回 FileError(permission_denied + 引导文案)。
 *   相对路径先经 base.absolutePath 按 env.cwd 绝对化再判定。
 *
 * 零侵入保证：runtime 未注入或 mode=off → 返回原 env（引用不变、零包装）。
 * 包装形态：Object.assign(Object.create(proto), ownProps)——原型方法继承存活
 * （cleanup 等透传），写方法以自有属性遮蔽（E-127 spread 陷阱防御同源）。
 */

import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { FileError, type Result } from "@earendil-works/pi-agent-core/node";

import { buildSeatbeltProfile } from "../../../domain/sandbox/seatbeltProfile";
import { isPathWritable, writeDeniedMessage, type SandboxPolicy } from "../../../domain/sandbox/SandboxPolicy";
import { classifyBashOutput } from "../../../domain/sandbox/violation";
import { classifyBashWrites, fallbackDeniedMessage } from "../../../domain/sandbox/ruleFallback";

/** 沙箱运行时注入面（装配层构造；CoreToolExecutor 可选槽）。 */
export interface SandboxRuntime {
  readonly policy: SandboxPolicy;
  /** profile 文件落盘目录（.helix 下会话无关目录即可；懒写、内容寻址）。 */
  readonly profileDir: string;
  /** 执行器形态：seatbelt = macOS 内核级；fallback = 全平台规则级（静态判定）。 */
  readonly enforcer: "seatbelt" | "fallback";
}

/** 包装目标的最小结构面（NodeExecutionEnv 的 exec/写方法/absolutePath 切片）。 */
export interface SandboxEnvTarget {
  cwd: string;
  exec(command: string, options?: Record<string, unknown>): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, Error>>;
  absolutePath(path: string): Promise<Result<string, FileError>>;
  writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
  appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>>;
  renameFile(sourcePath: string, destinationPath: string, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<Result<void, FileError>>;
  createDir(path: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>>;
}

/** 单引号 shell 转义（POSIX 标准形态）。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** roots 内容寻址指纹（roots 变更 → 新 profile 文件，天然幂等）。 */
function profileFileName(policy: SandboxPolicy): string {
  let h = 0;
  const key = policy.writableRoots.join("\u0000");
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return `seatbelt-${(h >>> 0).toString(16)}.sbpl`;
}

/** 懒落盘 profile（首次 exec 时；同 roots 并发写同文件内容相同，安全）。 */
async function ensureProfileFile(runtime: SandboxRuntime): Promise<string> {
  const file = `${runtime.profileDir}/${profileFileName(runtime.policy)}`;
  try {
    await mkdir(runtime.profileDir, { recursive: true });
    await fsWriteFile(file, buildSeatbeltProfile(runtime.policy), "utf-8");
  } catch {
    // 落盘失败让 sandbox-exec 自己报错（响亮失败优于静默裸奔）
  }
  return file;
}

function deny(path: string, policy: SandboxPolicy): Result<void, FileError> {
  return {
    ok: false,
    error: new FileError("permission_denied", writeDeniedMessage(path, policy), path),
  };
}

/** 包装 env：沙箱 exec 改写 + 写方法族判定。runtime 缺省/off → 原 env。 */
export function wrapEnvForSandbox<T extends SandboxEnvTarget>(base: T, runtime: SandboxRuntime | undefined): T {
  if (runtime === undefined || runtime.policy.mode !== "on") return base;
  const policy = runtime.policy;

  /** 相对路径绝对化 + 判定（相对路径按 env.cwd 解析）。 */
  const writable = async (path: string): Promise<boolean> => {
    if (path.startsWith("/")) return isPathWritable(path, policy);
    const abs = await base.absolutePath(path);
    if (!abs.ok) return false;
    return isPathWritable(abs.value, policy);
  };

  const wrapped = Object.assign(Object.create(Object.getPrototypeOf(base)) as T, base);
  const w = wrapped as T & SandboxEnvTarget;

  w.exec = async (command: string, options?: Record<string, unknown>) => {
    if (runtime.enforcer === "fallback") {
      // 规则级执行器：静态写候选判定（U0c 二期——Windows / 自检失败降级）。
      // 拒绝形态 = ok:true + exitCode 126 + 出路文案（与 violation 归一兼容）。
      const verdict = classifyBashWrites(command, base.cwd, policy);
      if (!verdict.allowed) {
        return { ok: true as const, value: { stdout: "", stderr: fallbackDeniedMessage(verdict.violations), exitCode: 126 } };
      }
      return base.exec(command, options);
    }
    const profileFile = await ensureProfileFile(runtime);
    const shell =
      process.env.SHELL !== undefined && process.env.SHELL.startsWith("/") ? process.env.SHELL : "/bin/bash"; // macOS 26 实测：/bin/sh 在沙箱内 abort，bash/zsh 正常
    const sandboxed =
      `/usr/bin/sandbox-exec -f ${shellQuote(profileFile)} -- ${shellQuote(shell)} -c ${shellQuote(command)}`;
    const result = await base.exec(sandboxed, options);
    if (result.ok) {
      const v = classifyBashOutput(result.value.exitCode, result.value.stderr);
      if (v.isViolation) {
        return { ok: true, value: { ...result.value, stderr: `${result.value.stderr}\n${v.message}` } };
      }
    }
    return result;
  };

  w.writeFile = async (path, content, abortSignal) => {
    if (!(await writable(path))) return deny(path, policy);
    return base.writeFile(path, content, abortSignal);
  };

  w.appendFile = async (path, content) => {
    if (!(await writable(path))) return deny(path, policy);
    return base.appendFile(path, content);
  };

  w.renameFile = async (sourcePath: string, destinationPath: string, abortSignal?: AbortSignal) => {
    if (!(await writable(sourcePath)) || !(await writable(destinationPath))) return deny(destinationPath, policy);
    return base.renameFile(sourcePath, destinationPath, abortSignal);
  };

  w.remove = async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
    if (!(await writable(path))) return deny(path, policy);
    return base.remove(path, options);
  };

  w.createDir = async (path: string, options?: { recursive?: boolean }) => {
    if (!(await writable(path))) return deny(path, policy);
    return base.createDir(path, options);
  };

  return wrapped;
}
