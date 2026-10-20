/**
 * WorkspaceFsAdapter —— WorkspaceFsPort 的 node:fs 实现（W1 绑定闭环）。
 *
 * driven 适配器（application/services/workspace/WorkspaceService 的 IO
 * 注入面——application 层零直接 fs 纪律）：realpath 规范化（symlink 消解，
 * 失败归一 undefined）+ 可读目录探测（stat isDirectory + R_OK）+ 危险根
 * 判定输入（homedir / 文件系统根）。
 */
import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { osHomeDir } from "../../infrastructure/paths"; // AG-07：主目录展开单点
import type { WorkspaceFsPort } from "../../application/services/workspace/WorkspaceService";

export function createWorkspaceFs(): WorkspaceFsPort {
  return {
    realpath(p: string): string | undefined {
      try {
        return realpathSync(p);
      } catch {
        return undefined; // 不存在/不可解析（ENOENT/EACCES/ELOOP 等）统一 undefined
      }
    },
    isReadableDir(p: string): boolean {
      try {
        if (!statSync(p).isDirectory()) return false;
        accessSync(p, fsConstants.R_OK);
        return true;
      } catch {
        return false;
      }
    },
    homeDir(): string {
      return osHomeDir(); // AG-07：主目录展开单点（infrastructure/paths.ts）
    },
    isFsRoot(p: string): boolean {
      // 判据按被检路径取根（WIN32 盘符/UNC 同判）：不再用 process.cwd() 的根——
      // 多盘符下两边根不同，守卫会漏判（低危批）。
      return path.parse(path.resolve(p)).root === path.resolve(p);
    },
  };
}
