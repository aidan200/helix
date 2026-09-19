/**
 * daemon 源码新鲜度自检（stale-indicator 批，§17.15）——driven 读面。
 *
 * 事故背景：一天内四次「daemon 合入后未重启吃到旧代码」差拍事故——本模块
 * 让 daemon 握手时自报「我在跑的代码是否已落后于磁盘」：max(mtime of
 * apps/daemon/src 与 packages/protocol/src 下全部 .ts 文件) 晚于进程启动
 * 时刻 → stale=true（前端连接状态区琥珀 chip「建议重启」）。
 *
 * 形态约束（范围钳制）：
 * - 只在握手时同步算一次（welcome 每连接恰一帧 = 天然每连接一次；几百文件
 *   stat 量级可接受）——不做文件 watch / 轮询 / 自动重启（零新依赖）；
 * - 打包态（源码目录不存在）恒 stale=false 且 welcome 可缺省字段 →
 *   computeDaemonFreshness 返回 undefined，adapter 不携带；
 * - 计算体是纯函数 + 注入文件树读面（FreshnessFs）——单测注入假文件树，
 *   无 fs mock 库依赖。
 *
 * 装配：组合根豁免面（infrastructure/assembly/buildDrivingAdapters.ts）经
 * createDaemonFreshnessProvider 装配后注入 WsServerAdapterDeps.freshness
 * （driving 不 import driven，AG-02③/AG-12；本模块不 import driving）。
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { DaemonFreshnessDto } from "@helix/protocol";

/** 扫描面单源：daemon 自身源码 + 协议包源码（改 daemon/protocol 任一即「代码已更新」）。 */
export const FRESHNESS_SCAN_ROOTS = ["apps/daemon/src", "packages/protocol/src"] as const;

/**
 * 文件树读面（测试注入缝）：listDir = 目录全部后代相对路径（含子目录行，
 * node:fs readdirSync { recursive: true } 语义；目录不存在 → undefined）；
 * mtimeOf = 文件 mtime（epoch ms；stat 失败 → undefined 跳过）。
 */
export interface FreshnessFs {
  listDir(dir: string): string[] | undefined;
  mtimeOf(file: string): number | undefined;
}

/** 真 fs 读面（Bun/Node 内建；目录缺失 catch → undefined）。 */
const realFs: FreshnessFs = {
  listDir(dir) {
    try {
      return readdirSync(dir, { recursive: true }).map(String);
    } catch {
      return undefined; // 目录不存在 / 不可读（打包态 / 权限）→ 该根缺席
    }
  },
  mtimeOf(file) {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return undefined; // 竞态删除等：跳过不炸
    }
  },
};

export interface ComputeFreshnessDeps {
  /** daemon 进程启动时刻（epoch ms；组合根 bootedAtMs 单源）。 */
  readonly startedAt: number;
  /** 仓库根（内含 FRESHNESS_SCAN_ROOTS 各相对根）。 */
  readonly repoRoot: string;
  /** 文件树读面（缺省真 fs；单测注入假文件树）。 */
  readonly fs?: FreshnessFs;
}

/**
 * 计算新鲜度（纯函数，无 Date.now / 无隐藏 IO——fs 读面全注入）。
 * 返回 undefined = 扫描根全部不存在（打包态）——welcome 缺省字段；
 * 任一根存在即进入判定：max .ts mtime 严格大于 startedAt → stale=true。
 */
export function computeDaemonFreshness(deps: ComputeFreshnessDeps): DaemonFreshnessDto | undefined {
  const fs = deps.fs ?? realFs;
  let anyRootPresent = false;
  let stale = false;
  for (const root of FRESHNESS_SCAN_ROOTS) {
    const absRoot = path.join(deps.repoRoot, root);
    const entries = fs.listDir(absRoot);
    if (entries === undefined) continue; // 该根缺席（打包态/裁剪形态）
    anyRootPresent = true;
    for (const rel of entries) {
      if (!rel.endsWith(".ts")) continue; // 只扫 .ts（规格：**/*.ts）
      const mtime = fs.mtimeOf(path.join(absRoot, rel));
      if (mtime !== undefined && mtime > deps.startedAt) {
        stale = true;
        break; // 命中即定论（无更早返回路径——全量遍历只为缺省态）
      }
    }
    if (stale) break;
  }
  if (!anyRootPresent) return undefined; // 打包态：恒不 stale 且可缺省字段
  return { startedAt: deps.startedAt, stale };
}

/**
 * 握手 freshness 读面工厂（组合根装配用）：repoRoot 缺省从本模块位置推导
 * （apps/daemon/src/adapters/driven/freshness → 上溯 6 级 = 仓根；打包态
 * 该推导落点无源码目录 → listDir 缺席 → undefined）。每次调用现算
 * （welcome 每连接一帧 = 每连接一次；不缓存跨连接）。
 */
export function createDaemonFreshnessProvider(deps: {
  readonly startedAt: number;
  /** 仓库根覆盖（缺省 = 本模块位置上溯推导；测试注入 nonexistent 路径模拟打包态）。 */
  readonly repoRoot?: string;
}): () => DaemonFreshnessDto | undefined {
  const repoRoot = deps.repoRoot ?? path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..");
  return () => computeDaemonFreshness({ startedAt: deps.startedAt, repoRoot });
}
