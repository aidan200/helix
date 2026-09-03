import type { ExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { globToRegExp } from "../contract";
import type { GrepBackend, GrepMatch, GrepQuery } from "../contract";

/**
 * rg 后端 + 行为归一适配层（CL-3/F3.1，AD-2，architecture §4.5/§6.3）。
 *
 * 经 resolve-rg 解析出的**注入路径** spawn 真 rg（本模块只接受注入
 * 路径，禁止 spawn("rg") 裸名直撞 PATH——R1 解析单点守护），把 rg 原生
 * 语义逐项对齐到 grep 契约语义（contract.ts 为语义基准，宁失速不失真）：
 * - 子串匹配 → `--fixed-strings` 恒在（includes 语义，非正则）；
 * - gitignore → `--no-ignore` 恒在（契约遍历零 gitignore 概念，显式抵消 rg 默认）；
 * - 隐藏文件 → `--hidden` 恒在（契约遍历不跳隐藏文件）；
 * - 跳过目录 → `-g '!node_modules' -g '!.git'`（basename 匹配，契约既定排除集）；
 * - glob 过滤 → **不传 rg**，rg 全量搜后由本适配层用契约单源
 *   `globToRegExp` 过滤命中行（规避 rg glob 与契约 `*` 跨目录差异）；
 * - 大小写 → `ignoreCase=true` 时传 `-i`；
 * - 空 pattern → spawn 前判定抛错（零进程开销）；
 * - 结果顺序 → 按 (path, lineNumber) 字典序排序后返回；
 * - 无文件数上限（历史 TS 遍历的 MAX_FILES=1000 保护已随 TS 后端删除；
 *   rg 侧由 RG_TIMEOUT_MS 超时兜底，超大目录以「收窄 path/glob」引导）。
 *
 * 输出消费 `--json` 结构化事件流（非 `path:行号:` 文本切分）：只取 match
 * 事件的 path/lines/line_number 三字段——Windows 盘符（`C:\...:42:`）与
 * 路径/行内容含冒号的边角在文本协议下必错切，JSON 协议天然免疫。
 * 执行面：以注入 ExecutionEnv 的 cwd 为子进程 cwd，传**相对** rootPath，
 * rg 输出路径即 cwd 相对投影（`./` 前缀在解析层剥除）。
 * exit 1（零命中）归一为空数组。
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

/** rg 检索超时（已 kill 子进程；门面透传为工具错误，文案含收窄引导）。 */
export class RgTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RgTimeoutError";
  }
}

/**
 * rg argv 构造（纯函数，归一判据的机械投影）：恒带 `--json` 结构化输出 +
 * 三个归一 flag + SKIP_DIRS 排除；ignoreCase → -i；pattern 经 `-e` 传入
 * （pattern 以 `-` 开头不被吞成 flag）；rootPath 经 `--` 隔离。glob **不进**
 * argv。
 */
export function buildRgArgv(query: GrepQuery, rootPath: string): string[] {
  const argv = [
    "--fixed-strings",
    "--no-ignore",
    "--hidden",
    "--json",
    "-g",
    "!node_modules",
    "-g",
    "!.git",
  ];
  if (query.ignoreCase === true) argv.push("-i");
  argv.push("-e", query.pattern, "--", rootPath);
  return argv;
}

/** rg --json 事件流的最小消费形状（只取 match 事件三字段；begin/end/summary 忽略）。 */
interface RgJsonMessage {
  readonly type: string;
  readonly data?: {
    readonly path?: { readonly text?: string };
    readonly lines?: { readonly text?: string };
    readonly line_number?: number;
  };
}

/**
 * rg --json stdout → GrepMatch[]（纯函数）：逐行 JSON.parse，只消费 match
 * 事件；glob 在本适配层过滤（与 TS 同一 globToRegExp）；结果按
 * (path, lineNumber) 字典序排序。
 * 跳过规则：非 match 事件（begin/end/summary）与 JSON 解析失败行（防御：
 * rg 告警混入不产幽灵行）；path/lines 为 bytes 形态（非 UTF-8）跳过——
 * 对齐 TS readTextFile 解码失败跳过整文件的语义。
 * 路径投影归一：rg 对相对 rootPath（如 `.`）的输出带 `./` 前缀，剥除后
 * 与 TS relativeToCwd 产物同口径（`./src/a.ts` → `src/a.ts`）。
 * 行文本剥尾换行（rg lines.text 含行终止符；CRLF 一并剥除）。
 */
export function parseRgJson(stdout: string, glob?: string): GrepMatch[] {
  const globRe = glob === undefined ? undefined : globToRegExp(glob);
  const matches: GrepMatch[] = [];
  for (const rawLine of stdout.split("\n")) {
    if (rawLine === "") continue;
    let msg: RgJsonMessage;
    try {
      msg = JSON.parse(rawLine) as RgJsonMessage;
    } catch {
      continue; // 防御：非 JSON 行（告警混入）不产幽灵命中
    }
    if (msg.type !== "match") continue;
    const pathText = msg.data?.path?.text;
    const lineText = msg.data?.lines?.text;
    const lineNumber = msg.data?.line_number;
    if (pathText === undefined || lineText === undefined || typeof lineNumber !== "number") continue;
    let path = pathText;
    if (path.startsWith("./")) path = path.slice(2); // rg 相对 rootPath 的 ./ 前缀归一
    if (globRe !== undefined && !globRe.test(path)) continue;
    matches.push({ path, lineNumber, line: lineText.replace(/\r?\n$/, "") });
  }
  return matches.sort((a, b) =>
    a.path === b.path ? a.lineNumber - b.lineNumber : a.path < b.path ? -1 : 1,
  );
}

/**
 * rg 后端：构造面注入 rg 绝对路径 + 执行环境（cwd）+ 相对 rootPath +
 * 超时上限；search 只消费查询，返回恒为排序后的 GrepMatch[]。
 * 单后端定位：rg 为 grep 工具唯一实现（无 TS 兜底），执行失败
 * （RgExecError/RgTimeoutError）原样上抛由门面透传为工具错误。
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
        // 契约语义（grep pattern 为空会命中所有行，属误用），spawn 前判定
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
          throw new RgTimeoutError(
            `rg 检索超时（>${opts.timeoutMs}ms），已终止子进程——请收窄 path 或加 glob 过滤后重试`,
          );
        }
        if (exitCode === 1) return []; // rg 零命中语义 → 返回空数组
        if (exitCode !== 0) throw new RgExecError(exitCode, stderr.trim());
        return parseRgJson(stdoutText, query.glob);
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
