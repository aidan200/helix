import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { GrepBackend, GrepMatch, GrepQuery } from "../contract";
import { globToRegExp } from "./ts-backend";

/**
 * rg 后端 + 行为归一适配层（CL-3/F3.1，AD-2，architecture §4.5/§6.3）。
 *
 * 经 T1.1 resolve-rg 解析出的**注入路径** spawn 真 rg（本模块只接受注入
 * 路径，禁止 spawn("rg") 裸名直撞 PATH——R1 解析单点守护），把 rg 原生
 * 语义逐项对齐到内置 TS 后端语义（宁失速不失真）：
 * - 子串匹配 → `--fixed-strings` 恒在（TS includes 语义，非正则）；
 * - gitignore → `--no-ignore` 恒在（TS 遍历零 gitignore 概念，显式抵消 rg 默认）；
 * - 隐藏文件 → `--hidden` 恒在（TS walkDir 不跳隐藏文件）；
 * - 跳过目录 → `-g '!node_modules' -g '!.git'`（basename 匹配，等价 TS SKIP_DIRS）；
 * - glob 过滤 → **不传 rg**，rg 全量搜后由本适配层用与 TS 同一个
 *   `globToRegExp` 过滤命中行（单源语义，规避 rg glob 与 TS `*` 跨目录差异）；
 * - 大小写 → `ignoreCase=true` 时传 `-i`；
 * - 空 pattern → 与 TS 同语义抛错（spawn 前判定，零进程开销）；
 * - 结果顺序 → 按 (path, lineNumber) 字典序排序后返回（TS readdir 发现序
 *   不契约化；parity 断言排序后相等，见 T1.3）；
 * - MAX_FILES=1000 防爆 → **不复制**（TS 遍历保护；rg 侧由 RG_TIMEOUT_MS
 *   超时兜底，差异已记录，parity fixture 不构造 >1000 文件场景）。
 *
 * 执行面：以注入 ExecutionEnv 的 cwd 为子进程 cwd，传**相对** rootPath，
 * rg 输出路径即 cwd 相对投影（与 TS 后端 relativeToCwd 产物同口径）。
 * exit 1（零命中）归一为空数组，与 TS「零命中返回 []」同形状。
 */

/** 单次检索调用上限（超时即 kill 子进程并抛 RgTimeoutError）。 */
export const RG_TIMEOUT_MS = 10_000;

/** rg 执行失败：非零退出（≥2）或二进制不可执行（exitCode=-1）。 */
export class RgExecError extends Error {
  public constructor(
    public readonly exitCode: number,
    public readonly stderr: string,
    message?: string,
  ) {
    super(message ?? `rg 执行失败（exit ${exitCode}）：${stderr}`);
    this.name = "RgExecError";
  }
}

/** rg 检索超时（已 kill 子进程；门面降级分类用，T1.3 消费）。 */
export class RgTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RgTimeoutError";
  }
}

/**
 * rg argv 构造（纯函数，归一判据的机械投影）：恒带六个归一 flag +
 * SKIP_DIRS 排除；ignoreCase → -i；pattern 经 `-e` 传入（pattern 以 `-`
 * 开头不被吞成 flag）；rootPath 经 `--` 隔离。glob **不进** argv。
 */
export function buildRgArgv(query: GrepQuery, rootPath: string): string[] {
  const argv = [
    "--fixed-strings",
    "--no-ignore",
    "--hidden",
    "--line-number",
    "--with-filename",
    "--no-heading",
    "-g",
    "!node_modules",
    "-g",
    "!.git",
  ];
  if (query.ignoreCase === true) argv.push("-i");
  argv.push("-e", query.pattern, "--", rootPath);
  return argv;
}

/**
 * rg stdout → GrepMatch[]（纯函数）：逐行解析 `path:行号:内容`，glob 在
 * 本适配层过滤（与 TS 同一 globToRegExp），结果按 (path, lineNumber)
 * 字典序排序。行号段以「首个 :数字: 锚」切分——路径含冒号（非数字段）
 * 不误切，行内容含冒号原样保留（macOS only，Windows 盘符不适用）。
 * 路径投影归一：rg 对相对 rootPath（如 `.`）的输出带 `./` 前缀，剥除后
 * 与 TS relativeToCwd 产物同口径（`./src/a.ts` → `src/a.ts`）。
 */
export function parseRgStdout(stdout: string, glob?: string): GrepMatch[] {
  const globRe = glob === undefined ? undefined : globToRegExp(glob);
  const matches: GrepMatch[] = [];
  for (const rawLine of stdout.split("\n")) {
    if (rawLine === "") continue;
    const m = /^(.+?):(\d+):(.*)$/.exec(rawLine);
    if (m === null) continue; // 非命中行（防御：rg 告警混入 stdout 时不产幽灵行）
    let path = m[1] as string;
    if (path.startsWith("./")) path = path.slice(2); // rg 相对 rootPath 的 ./ 前缀归一
    if (globRe !== undefined && !globRe.test(path)) continue;
    matches.push({ path, lineNumber: Number(m[2]), line: m[3] as string });
  }
  return matches.sort((a, b) =>
    a.path === b.path ? a.lineNumber - b.lineNumber : a.path < b.path ? -1 : 1,
  );
}

/**
 * rg 后端：构造面注入 rg 绝对路径 + 执行环境（cwd）+ 相对 rootPath +
 * 超时上限；search 只消费查询，返回恒为排序后的 GrepMatch[]。
 */
export function createRgBackend(
  rgPath: string,
  env: ExecutionEnv,
  rootPath: string,
  opts: { timeoutMs: number },
  signal?: AbortSignal,
): GrepBackend {
  return {
    name: "rg",
    async search(query: GrepQuery): Promise<GrepMatch[]> {
      if (query.pattern === "") {
        // 与 TS 后端同语义（matchFiles 同款文案），spawn 前判定
        throw new Error("grep pattern 不能为空字符串（会命中所有行，属误用）");
      }
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn([rgPath, ...buildRgArgv(query, rootPath)], {
          cwd: env.cwd,
          stdout: "pipe",
          stderr: "pipe",
          signal,
        });
      } catch (e) {
        throw new RgExecError(-1, String(e), `rg 启动失败（二进制不可执行）：${rgPath}`);
      }
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, opts.timeoutMs);
      try {
        const stdout = proc.stdout as ReadableStream<Uint8Array>; // stdout/stderr 均 pipe（上文 spawn 选项）
        const stderrStream = proc.stderr as ReadableStream<Uint8Array>;
        const [stdoutText, stderr, exitCode] = await Promise.all([
          new Response(stdout).text(),
          new Response(stderrStream).text(),
          proc.exited,
        ]);
        if (timedOut) {
          throw new RgTimeoutError(`rg 检索超时（>${opts.timeoutMs}ms），已终止子进程：${rgPath}`);
        }
        if (exitCode === 1) return []; // rg 零命中语义 → TS「返回空数组」同形状
        if (exitCode !== 0) throw new RgExecError(exitCode, stderr.trim());
        return parseRgStdout(stdoutText, query.glob);
      } catch (e) {
        // spawn 异步失败（如部分运行时的 ENOENT 走 exited reject）同样归为 RgExecError
        if (e instanceof RgExecError || e instanceof RgTimeoutError) throw e;
        throw new RgExecError(-1, String(e), `rg 执行失败（进程面）：${rgPath}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
