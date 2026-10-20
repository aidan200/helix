/**
 * 沙箱 env 包装（零侵入装饰层——照 TurnDiffEnvWrap 的包装形态先例）。
 *
 * 包装面：
 * - exec（bash 唯一通道）：改写 command 为
 *   `/usr/bin/sandbox-exec -f <profile> -- <shell> -c <原命令>`（单引号转义，
 *   内层 shell 用 $SHELL 兜底 /bin/bash——shellPath 是 private 读不到取近似；
 *   macOS 26 实测 /bin/sh 在沙箱内 abort trap 6，禁用）。
 *   沙箱拒绝时在输出尾部追加引导文案（violation 归一）。
 * - 写方法族（writeFile/appendFile/renameFile/remove/createDir）：路径 TS 判定
 *   ∈ writableRoots，越界返回 FileError(permission_denied + 引导文案)。
 *   相对路径先经 base.absolutePath 按 env.cwd 绝对化再判定。
 *
 * 【pi 0.85 适配】ExecutionEnv 全方法末参为必传 chord Context；Shell.exec
 * 不再直返 stdout/stderr——合并输出经 options.onUpdate 增量投递（bounded
 * capture）。本包装旁路 caller 的 onUpdate 折叠最终视图（applyShellOutputUpdate）
 * 供违规分类；拒绝/违规引导文案以 append/replace update 经 caller onUpdate
 * 投递（输出唯一通道——无 onUpdate 的调用方本就声明丢弃输出）。
 *
 * 零侵入保证：runtime 未注入或 mode=off → 返回原 env（引用不变、零包装）。
 * 包装形态：Object.assign(Object.create(proto), ownProps)——原型方法继承存活
 * （cleanup 等透传），写方法以自有属性遮蔽（E-127 spread 陷阱防御同源）。
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile as fsWriteFile } from "node:fs/promises";
import {
  applyShellOutputUpdate,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
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

import { buildSeatbeltProfile } from "../../../domain/sandbox/seatbeltProfile";
import { isPathWritable, writeDeniedMessage, type SandboxPolicy } from "../../../domain/sandbox/SandboxPolicy";
import { classifyBashOutput } from "../../../domain/sandbox/violation";
import { classifyBashWrites, fallbackDeniedMessage } from "../../../domain/sandbox/ruleFallback";

/** 沙箱运行时注入面（装配层构造；CoreToolExecutor 可选槽）。 */
export interface SandboxRuntime {
  readonly policy: SandboxPolicy;
  /** profile 文件落盘目录（.helix 下会话无关目录即可；懒写、内容寻址）。 */
  readonly profileDir: string;
  /** 执行器形态：seatbelt = macOS 内核级；helper = Windows 受限 token（exe）；fallback = 全平台规则级（静态判定）。 */
  readonly enforcer: "seatbelt" | "helper" | "fallback";
  /** 工具链缓存重定向 env（sandboxSetup.toolCacheEnv 产物）：exec 时 merge 进
   * options.env（显式传入优先）——包管理器用户级缓存写指向可写根内。 */
  readonly cacheEnv?: Record<string, string>;
  /** helper.exe 绝对路径（仅 enforcer=helper 时消费；探测见 sandboxSetup）。 */
  readonly helperPath?: string;
}

/** 包装目标的最小结构面（NodeExecutionEnv 的 exec/写方法/absolutePath 切片，pi 0.85 签名）。 */
export interface SandboxEnvTarget {
  cwd: string;
  exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>>;
  absolutePath(path: string, context: Context): Promise<Result<string, FileError>>;
  writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>>;
  appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>>;
  renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>>;
  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>>;
  createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>>;
}

/** 单引号 shell 转义（POSIX 标准形态）。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** roots 内容寻址指纹（roots 变更 → 新 profile 文件，天然幂等）。
 *  F2 #19：指纹取全长 SHA-256（不是 32 位循环哈希）——32 位碰撞会让两个
 *  不同可写根集合落同一 profile 文件，而 ensureProfileFile 每次覆写，
 *  并发 exec 交错就可能让 sandbox-exec 引到另一套可写根。key 用 JSON
 *  序列化（列表结构自带分隔，杜绝串拼接歧义）。 */
function profileFileName(policy: SandboxPolicy): string {
  const key = JSON.stringify(policy.writableRoots);
  return `seatbelt-${createHash("sha256").update(key).digest("hex")}.sbpl`;
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

/** 文本 → 无截断输出元数据（truncateTail 复用行/字节计数口径，去 content 副本）。 */
function metadataOfText(text: string): ShellOutputMetadata {
  const { content: _content, ...truncation } = truncateTail(text);
  void _content;
  return { truncation };
}

/**
 * 合并输出旁路收集（pi 0.85：exec 输出只经 onUpdate 投递）：在 caller 的
 * onUpdate 前挂一级折叠（applyShellOutputUpdate），caller 未给 capture 时
 * 补默认 bounded capture（否则输出被源端丢弃、分类无源）。
 */
function tapOutput(options: ShellExecOptions | undefined): {
  readonly options: ShellExecOptions;
  readonly text: () => string;
} {
  const callerOnUpdate = options?.onUpdate;
  let view: ShellOutputView | undefined;
  return {
    options: {
      ...options,
      capture: options?.capture ?? { limits: { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES } },
      onUpdate: (update, ctx) => {
        view = applyShellOutputUpdate(view, update);
        callerOnUpdate?.(update, ctx);
      },
    },
    text: () => view?.text ?? "",
  };
}

/** 包装 env：沙箱 exec 改写 + 写方法族判定。runtime 缺省/off → 原 env。 */
export function wrapEnvForSandbox<T extends SandboxEnvTarget>(base: T, runtime: SandboxRuntime | undefined): T {
  if (runtime === undefined || runtime.policy.mode !== "on") return base;
  const policy = runtime.policy;

  /** 相对路径绝对化 + 判定（相对路径按 env.cwd 解析）。 */
  const writable = async (path: string, context: Context): Promise<boolean> => {
    if (path.startsWith("/")) return isPathWritable(path, policy);
    const abs = await base.absolutePath(path, context);
    if (!abs.ok) return false;
    return isPathWritable(abs.value, policy);
  };

  const wrapped = Object.assign(Object.create(Object.getPrototypeOf(base)) as T, base);
  const w = wrapped as T & SandboxEnvTarget;

  /** exec options merge 缓存重定向 env（options.env 显式值优先——agent 自设覆盖兑底）。 */
  const withCacheEnv = (options: ShellExecOptions | undefined): ShellExecOptions | undefined => {
    if (runtime.cacheEnv === undefined) return options;
    return { ...options, env: { ...runtime.cacheEnv, ...(options?.env ?? {}) } };
  };

  /** seatbelt/helper 违规统一后处理：分类命中则经 caller onUpdate 追加引导文案。 */
  const classifyAndAnnotate = (
    result: Result<ShellExecResult, ExecutionError>,
    outputText: string,
    callerOnUpdate: ShellExecOptions["onUpdate"],
    context: Context,
  ): void => {
    if (!result.ok) return;
    const v = classifyBashOutput(result.value.exitCode, outputText);
    if (!v.isViolation) return;
    const { exitCode: _exitCode, ...metadata } = result.value;
    void _exitCode;
    callerOnUpdate?.({ kind: "append", text: `\n${v.message}`, metadata }, context);
  };

  w.exec = async (command, options, context) => {
    if (runtime.enforcer === "fallback") {
      // 规则级执行器：静态写候选判定（U0c 二期——Windows / 自检失败降级）。
      // 拒绝形态 = ok:true + exitCode 126 + 拒绝文案经 onUpdate 投递（与 violation 归一兼容；
      // pi 0.85 exec 结果不再携带 stdout/stderr，onUpdate 是输出唯一通道）。
      const verdict = classifyBashWrites(command, base.cwd, policy);
      if (!verdict.allowed) {
        const message = fallbackDeniedMessage(verdict.violations);
        const metadata = metadataOfText(message);
        options?.onUpdate?.({ kind: "replace", output: { text: message, ...metadata } }, context);
        return { ok: true as const, value: { exitCode: 126, ...metadata } };
      }
      return base.exec(command, withCacheEnv(options), context);
    }
    if (runtime.enforcer === "helper") {
      // Windows 受限 token 执行器（U0c 二期②）：与 seatbelt 同构的命令改写——
      // pi 引擎 Windows 亦用 bash（Git Bash/MSYS2 探测），包装形态不变；
      // helper 走 PATH 解析（pi 已确保 bash 在 PATH 是既定前提）。
      const writables = policy.writableRoots.map((r) => `--writable ${shellQuote(r)}`).join(" ");
      const rewritten = `${shellQuote(runtime.helperPath ?? "helix-sandbox-helper.exe")} ${writables} -- bash -c ${shellQuote(command)}`;
      const tap = tapOutput(withCacheEnv(options));
      const result = await base.exec(rewritten, tap.options, context);
      classifyAndAnnotate(result, tap.text(), options?.onUpdate, context);
      return result;
    }
    const profileFile = await ensureProfileFile(runtime);
    const shell =
      process.env.SHELL !== undefined && process.env.SHELL.startsWith("/") ? process.env.SHELL : "/bin/bash"; // macOS 26 实测：/bin/sh 在沙箱内 abort，bash/zsh 正常
    const sandboxed =
      `/usr/bin/sandbox-exec -f ${shellQuote(profileFile)} -- ${shellQuote(shell)} -c ${shellQuote(command)}`;
    const tap = tapOutput(withCacheEnv(options));
    const result = await base.exec(sandboxed, tap.options, context);
    classifyAndAnnotate(result, tap.text(), options?.onUpdate, context);
    return result;
  };

  w.writeFile = async (path, content, context) => {
    if (!(await writable(path, context))) return deny(path, policy);
    return base.writeFile(path, content, context);
  };

  w.appendFile = async (path, content, context) => {
    if (!(await writable(path, context))) return deny(path, policy);
    return base.appendFile(path, content, context);
  };

  w.renameFile = async (sourcePath, destinationPath, context) => {
    // 逐端判定、拒在越界那一端（低危批）：源越界却报目标路径，会让「目标在可写根
    // 内」的调用方按错误方向排障（文案说目标不可写，实际是源越界）。
    if (!(await writable(sourcePath, context))) return deny(sourcePath, policy);
    if (!(await writable(destinationPath, context))) return deny(destinationPath, policy);
    return base.renameFile(sourcePath, destinationPath, context);
  };

  w.remove = async (path, options, context) => {
    if (!(await writable(path, context))) return deny(path, policy);
    return base.remove(path, options, context);
  };

  w.createDir = async (path, options, context) => {
    if (!(await writable(path, context))) return deny(path, policy);
    return base.createDir(path, options, context);
  };

  return wrapped;
}
