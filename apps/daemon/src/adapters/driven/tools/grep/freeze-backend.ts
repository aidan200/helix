import type { RgResolution } from "./resolve-rg";

/**
 * 启动定格（AF-1 权威口径，CL-3/F3.2，architecture §4.5）：组合根装配
 * 工具集时一次性执行「resolve-rg 二级解析 + 轻量可用性探针」，结果内存
 * 定格——进程生命周期内不重新解析、不升级。
 *
 * 两半：
 * - **freezeGrepBackend = 纯函数**（framework-free）：resolution ×
 *   probeOutcome → 定格结果（可单测；保守语义同 resolve-rg——探针结果
 *   缺失不臆造可用性）。
 * - **probeRgVersion = 探针**（唯一 spawn 点）：仅 `rg --version`、2s
 *   超时、退出码 0 三要素；任何失败形态（不可执行/非零退出/超时/进程面
 *   异常）归一为 { ok: false, reason }，不抛裸错。
 *
 * 运行期消费面在 GrepTool 门面（只读定格结果选后端；unavailable 定格
 * 时工具响亮失败，无 TS 兜底——rg 为唯一后端）。
 */

/** 探针结果（ok=true 时 reason 为空串）。 */
export interface RgProbeOutcome {
  readonly ok: boolean;
  readonly reason: string;
}

/** 启动定格结果：rg（路径 + 来源级）或 unavailable（失败原因清单，供启动 warn 日志与工具响亮失败文案）。 */
export type GrepBackendFreeze =
  | { readonly kind: "rg"; readonly rgPath: string; readonly source: "bundle" | "config" }
  | { readonly kind: "unavailable"; readonly reasons: readonly string[] };

/** 探针默认超时（AF-1：2s）。 */
export const RG_PROBE_TIMEOUT_MS = 2_000;

/**
 * 定格判定（纯函数）：resolution 为 unavailable → unavailable（reasons 透传）；
 * resolved + 探针通过 → rg；resolved + 探针失败/缺失 → unavailable（探针原因入
 * reasons，含 rg 路径，供启动日志与工具失败文案定位）。rg 为唯一后端，
 * unavailable ≠ 装配失败（门面注册响亮失败工具，daemon 照常启动）。
 */
export function freezeGrepBackend(resolution: RgResolution, probe?: RgProbeOutcome): GrepBackendFreeze {
  if (resolution.kind === "unavailable") {
    return { kind: "unavailable", reasons: resolution.reasons };
  }
  if (probe === undefined) {
    return { kind: "unavailable", reasons: [`探针：可用性探针未执行（${resolution.path}）`] };
  }
  if (!probe.ok) {
    return { kind: "unavailable", reasons: [`探针：${probe.reason}（${resolution.path}）`] };
  }
  return { kind: "rg", rgPath: resolution.path, source: resolution.source };
}

/**
 * 可用性探针（AF-1 三要素）：spawn `<rgPath> --version`，timeoutMs 内退出
 * 码 0 才 ok。超时 kill 子进程；任何异常归一为 { ok: false, reason }。
 */
export async function probeRgVersion(
  rgPath: string,
  timeoutMs: number = RG_PROBE_TIMEOUT_MS,
): Promise<RgProbeOutcome> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([rgPath, "--version"], { stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return { ok: false, reason: `探针启动失败（二进制不可执行）：${e}` };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const stdout = proc.stdout as ReadableStream<Uint8Array>;
    const stderrStream = proc.stderr as ReadableStream<Uint8Array>;
    const [, stderr, exitCode] = await Promise.all([
      new Response(stdout).text(),
      new Response(stderrStream).text(),
      proc.exited,
    ]);
    if (timedOut) return { ok: false, reason: `探针超时（>${timeoutMs}ms），已终止` };
    if (exitCode !== 0) return { ok: false, reason: `rg --version 退出码 ${exitCode}：${stderr.trim()}` };
    return { ok: true, reason: "" };
  } catch (e) {
    return { ok: false, reason: `探针执行失败（进程面）：${e}` };
  } finally {
    clearTimeout(timer);
  }
}
