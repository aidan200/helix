/**
 * install-skeleton —— 外部二进制/bundle 资产获取的共享安装骨架（W4 归一）。
 *
 * fetch-rg（单文件 rg）与 fetch-codegraph（bundle 目录树）五段安装骨架
 * （幂等检查 → 下载 → sha256 → 解压 → tmp 落位 + 守护 → rename，含
 * --from 解析与 main 入口）原为逐行平行复制、平行演化——改一处忘另一处
 * 的风险实在（rg 先有 copy 抛错清理、codegraph 先有 tmp 预清，正是漂移
 * 实例）。本模块收束共性为单点，差异经 InstallSkeletonSpec 参数化：
 * - 落位形态（destIsTree：文件 = rename 原子替换 / 目录树 = rm 旧树再 rename）；
 * - 守护断言函数（isInstalledAt / place 内断言）；
 * - 资产解析函数（assetFor：pin 版本 + 分平台 sha256）；
 * - 源校验（assertSource）与解压后定位（locateInArchive）。
 *
 * 网络防护纪律（TR-104）单点：downloadToFile（连接超时 + 停滞检测单定时器
 * 循环重置 + 指数退避 + 进度日志；确定性 4xx 免重试）自 fetch-rg.ts 迁入
 * 本模块——fetch-rg.ts 保 re-export 兼容面，新消费方直接 import 本模块。
 *
 * 工程层脚本，不被 apps 任何层 import（架构 §5.2）。
 */
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { resolvePlatformArg, type DesktopPlatform } from "./desktop-platform";

// ── 下载面（TR-104 单点；fetch-rg.ts re-export 保既有消费方）──────────

/** downloadToFile 可调参数（测试注小值用）。 */
export interface DownloadOptions {
  /** 连接/响应头总限（AbortSignal.timeout），缺省 60s。 */
  connectTimeoutMs?: number;
  /** 单次读流无数据停滞限，缺省 30s（TCP 半死检测——连着但不传数据）。 */
  stallTimeoutMs?: number;
  /** 重试次数上限（含首次），缺省 4。 */
  retries?: number;
  /** 重试退避基数（第 n 次失败等 n×backoff），缺省 5s。 */
  backoffMs?: number;
  /** 日志前缀（"fetch-rg" / "fetch-codegraph"）。 */
  label?: string;
}

/**
 * 下载面单点（裸 fetch 曾在 CI 挂死半小时：零超时遇 TCP 半死即永久挂起）：
 * 连接超时 + 读流停滞检测 + 指数退避重试 + 进度日志（每 8MB 一行），
 * 半成品失败即删。redirect 默认跟随（GitHub release 资产 302 到 CDN）。
 * 确定性 4xx（404/410…除 408/429）不重试直接抛——版本 pin 错配/资产改名
 * 场景重试必然同果，白等退避 30s 只会延误报错。
 */
export async function downloadToFile(
  url: string,
  dest: string,
  opts: DownloadOptions = {},
): Promise<void> {
  const {
    connectTimeoutMs = 60_000,
    stallTimeoutMs = 30_000,
    retries = 4,
    backoffMs = 5_000,
    label = "download",
  } = opts;
  let lastErr: unknown = "unknown";
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await downloadOnce(url, dest, { connectTimeoutMs, stallTimeoutMs, label, attempt });
      return;
    } catch (e) {
      lastErr = e;
      rmSync(dest, { force: true }); // 半成品不残留（sha256 兜底之外的第二道卫生）
      if (e instanceof HttpError && isDeterministic4xx(e.status)) {
        throw new Error(
          `${label}: 下载失败（HTTP ${e.status} 确定性错误，不重试）：${url}：${e2msg(e)}`,
        );
      }
      if (attempt === retries) break;
      const wait = attempt * backoffMs;
      console.warn(
        `${label}: 下载失败（第 ${attempt}/${retries} 次）：${e instanceof Error ? e.message : String(e)}；${wait / 1000}s 后重试`,
      );
      await Bun.sleep(wait);
    }
  }
  throw new Error(
    `${label}: 下载重试耗尽（${retries} 次）：${url}：${e2msg(lastErr)}`,
  );
}

/** HTTP 状态错误（携 status；downloadToFile 按确定性 4xx 免重试分道）。 */
class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** 确定性 4xx：重试必然同果（版本 pin 错配/资产改名即 404/410），免退避白等；408/429 为瞬态例外仍重试。 */
function isDeterministic4xx(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function e2msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function downloadOnce(
  url: string,
  dest: string,
  o: { connectTimeoutMs: number; stallTimeoutMs: number; label: string; attempt: number },
): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(o.connectTimeoutMs) });
  if (!res.ok || !res.body) {
    throw new HttpError(res.status, `HTTP ${res.status} ${res.statusText}`);
  }
  const total = Number(res.headers.get("content-length") ?? 0);
  console.log(
    `${o.label}: 下载开始（第 ${o.attempt} 次）${total ? `，共 ${(total / 1024 / 1024).toFixed(1)}MB` : ""}：${url}`,
  );
  const reader = res.body.getReader();
  const writer = Bun.file(dest).writer();
  let received = 0;
  let nextLog = 8 * 1024 * 1024;
  // 停滞检测：单一定时器循环重置（每块数据到达后 clearTimeout 重排），
  // 循环结束/出错 finally 清理——不可每轮新建 Bun.sleep 竞速后不取消：
  // 赢竞速的悬挂定时器持有事件循环，下载成功后进程仍挂起 stallTimeoutMs 才退出。
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let stallReject: ((e: Error) => void) | undefined;
  const stall = new Promise<never>((_, reject) => {
    stallReject = reject;
  });
  stall.catch(() => {}); // 竞速输家 promise 显式吞掉防 unhandled rejection
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(
      () => stallReject?.(new Error(`数据流停滞超过 ${o.stallTimeoutMs / 1000}s（连接半死）`)),
      o.stallTimeoutMs,
    );
  };
  armStall();
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), stall]);
      if (chunk.done) break;
      await writer.write(chunk.value);
      received += chunk.value.byteLength;
      if (received >= nextLog) {
        console.log(
          `${o.label}: 进度 ${(received / 1024 / 1024).toFixed(1)}MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)}MB` : ""}`,
        );
        nextLog += 8 * 1024 * 1024;
      }
      armStall();
    }
    await writer.end();
    console.log(`${o.label}: 下载完成 ${(received / 1024 / 1024).toFixed(1)}MB → ${dest}`);
  } catch (e) {
    await writer.end().catch(() => {});
    throw e;
  } finally {
    clearTimeout(stallTimer);
  }
}

// ── 共性工具（sha256 / 解压）─────────────────────────────────

export function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 解压单点：tar.gz / zip 统一走 bsdtar `tar -xf`（mac 与 Windows 10+ 系统 tar 均支持 zip 自嗅探）。 */
export async function extractArchive(archive: string, destDir: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["tar", "-xf", archive, "-C", destDir],
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`解压失败：${archive}：${err.trim()}`);
  }
}

// ── 五段安装骨架（差异全经 spec 注入）──────────────────────────

export interface InstallResult {
  /** true = 幂等跳过（已存在且校验通过）。 */
  skipped: boolean;
  path: string;
}

/**
 * 安装骨架差异面（fetch-rg / fetch-codegraph 的全部参数化点）：
 * 落位形态（destIsTree）、守护断言（isInstalledAt/place）、资产解析
 * （assetFor）、源校验（assertSource）、解压后定位（locateInArchive）。
 */
export interface InstallSkeletonSpec {
  /** 日志/报错前缀，兼下载进度 label（"fetch-rg" / "fetch-codegraph"）。 */
  readonly label: string;
  /** 下载/解压暂存 mkdtemp 前缀（"helix-rg-" / "helix-codegraph-"）。 */
  readonly tmpPrefix: string;
  /** 落位形态：false = 单文件（rename 原子替换既有 dest）；true = 目录树（rm 旧树再 rename——rename 落非空目录会失败）。 */
  readonly destIsTree: boolean;
  /** 平台档 → release 资产（pin 版本 + 分平台 sha256）。 */
  readonly assetFor: (platform: DesktopPlatform) => {
    readonly name: string;
    readonly url: string;
    readonly sha256: string;
  };
  /** 平台档 → 落位路径（单文件路径 / 目录树根）。 */
  readonly destFor: (platform: DesktopPlatform) => string;
  /** 幂等判据：落位存在且守护断言通过。 */
  readonly isInstalledAt: (dest: string, platform: DesktopPlatform) => Promise<boolean>;
  /** --from 源校验（不存在/形态不符即抛错；在幂等检查之前）。 */
  readonly assertSource: (src: string) => void;
  /**
   * 源 → tmp 落位 + 守护断言（落位形态差异面：单文件 copyFileSync+chmod /
   * 目录树 cpSync recursive）。失败（含 copy 自身抛错——盘满/权限）必须
   * 自清理 tmp，不落位半成品。
   */
  readonly place: (src: string, tmp: string, platform: DesktopPlatform) => Promise<void>;
  /** 解压目录 → 待安装源路径（固定包内路径 / 顶层目录动态探测；找不到即抛错）。 */
  readonly locateInArchive: (extractDir: string, platform: DesktopPlatform) => string;
  /** --from 参数缺值时的报错文案（如「本地 rg 路径」/「本地 bundle 目录」）。 */
  readonly fromArgHint: string;
}

/** makeInstallers 产物：三形态安装函数（默认参数 = darwin-arm64 缺省档兼容面）。 */
export interface InstallerSet {
  /** `--from <path>` 形态：本地源拷贝 → 守护断言 → 落位（幂等跳过）。 */
  installFromLocal(src: string, dest?: string, platform?: DesktopPlatform): Promise<InstallResult>;
  /** 校验 + 解压安装：sha256 不符即删档抛错；通过则解出源走 installFromLocal 同一落位面。 */
  installFromArchive(archive: string, dest?: string, platform?: DesktopPlatform): Promise<InstallResult>;
  /** 默认形态：固定版本下载（downloadToFile 带超时/停滞/重试）→ sha256 → 解压落位（幂等跳过）。 */
  installFromRelease(dest?: string, platform?: DesktopPlatform): Promise<InstallResult>;
}

/**
 * 五段安装骨架单点：幂等检查 →（下载 →）sha256 → 解压 → tmp 落位 + 守护
 * → rename。tmp 落位前预清同名残留（`.tmp-<pid>` 同 pid 复用窗口），
 * 失败路径由 place 自清理；解压/下载暂存目录 finally 兜底删除。
 */
export function makeInstallers(spec: InstallSkeletonSpec): InstallerSet {
  const defaultDest = spec.destFor("darwin-arm64");

  async function installFromLocal(
    src: string,
    dest: string = defaultDest,
    platform: DesktopPlatform = "darwin-arm64",
  ): Promise<InstallResult> {
    spec.assertSource(src);
    if (await spec.isInstalledAt(dest, platform)) {
      console.log(`✓ ${spec.label}: 已存在且校验通过（${platform}），幂等跳过：${dest}`);
      return { skipped: true, path: dest };
    }
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true }); // 同名 tmp 残留预清（同 pid 复用窗口）
    await spec.place(src, tmp, platform);
    if (spec.destIsTree) rmSync(dest, { recursive: true, force: true }); // 目录树：旧落位整体替换
    renameSync(tmp, dest);
    console.log(`✓ ${spec.label}: --from 拷贝完成：${src} → ${dest}`);
    return { skipped: false, path: dest };
  }

  async function installFromArchive(
    archive: string,
    dest: string = defaultDest,
    platform: DesktopPlatform = "darwin-arm64",
  ): Promise<InstallResult> {
    const asset = spec.assetFor(platform);
    const actual = sha256OfFile(archive);
    if (actual !== asset.sha256) {
      rmSync(archive, { force: true });
      throw new Error(
        `sha256 校验失败（已删除 ${archive}）：期望 ${asset.sha256}，实际 ${actual}`,
      );
    }
    const extractDir = mkdtempSync(join(tmpdir(), `${spec.tmpPrefix}extract-`));
    try {
      await extractArchive(archive, extractDir);
      const extracted = spec.locateInArchive(extractDir, platform);
      return await installFromLocal(extracted, dest, platform);
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
    }
  }

  async function installFromRelease(
    dest: string = defaultDest,
    platform: DesktopPlatform = "darwin-arm64",
  ): Promise<InstallResult> {
    if (await spec.isInstalledAt(dest, platform)) {
      console.log(`✓ ${spec.label}: 已存在且校验通过（${platform}），幂等跳过：${dest}`);
      return { skipped: true, path: dest };
    }
    const asset = spec.assetFor(platform);
    const archive = join(mkdtempSync(join(tmpdir(), `${spec.tmpPrefix}dl-`)), asset.name);
    try {
      await downloadToFile(asset.url, archive, { label: spec.label });
      return await installFromArchive(archive, dest, platform);
    } finally {
      rmSync(dirname(archive), { recursive: true, force: true });
    }
  }

  return { installFromLocal, installFromArchive, installFromRelease };
}

/**
 * main 入口骨架：argv --platform/env 解析 + --from 分路（src 缺值/以 -
 * 开头 → 一行 ✗ 文案 exit(1)）。返回最终落位与平台档供入口打印各自的
 * 成功行（rg 报体积 / codegraph 报版本）。
 */
export async function runInstallMain(
  spec: InstallSkeletonSpec,
  installers: InstallerSet,
): Promise<{ dest: string; platform: DesktopPlatform }> {
  const platform = resolvePlatformArg(process.argv, process.env);
  const dest = spec.destFor(platform);
  const fromIdx = process.argv.indexOf("--from");
  if (fromIdx !== -1) {
    const src = process.argv[fromIdx + 1];
    if (!src || src.startsWith("-")) {
      console.error(`✗ ${spec.label}: --from 需要${spec.fromArgHint}参数`);
      process.exit(1);
    }
    await installers.installFromLocal(src, dest, platform);
    return { dest, platform };
  }
  await installers.installFromRelease(dest, platform);
  return { dest, platform };
}
