import path from "node:path";
import { statSync } from "node:fs";

/**
 * StaticServe —— 前端静态产物驱动侧（architecture.md §3.5）。
 *
 * serve 前端构建产物目录（config.json 的 staticDir，可配置）：
 * - dev 期前端直连 vite dev server，不经本 adapter；
 * - 生产形态（Tauri 壳内 / standalone）由 daemon 自己 serve 构建产物；
 * - 目录未配置或不存在：daemon 照常启动（前无产物属正常），
 *   handle 一律返回 null（HTTP 404 由 ws-server 兜底）。
 *
 * 零依赖：Bun.file + 扩展名自动 Content-Type；路径穿越（..）拒绝。
 *
 * 信任边界声明（code-review 低危组7）：穿越守卫是**词法比对**（join 后
 * 前缀校验），不解析符号链接——root 下若存在指向 root 外的 symlink，
 * Bun.file 会跟随读出。现实风险可忽略：staticDir 来自 daemon 侧
 * config.json（运维面，非用户请求输入），且构建产物目录（vite build
 * 输出）不应含 symlink；若部署形态变更（staticDir 可被低信任方写入），
 * 需升级为 realpath 后比对。
 */
export class StaticServe {
  private readonly root: string | undefined;

  constructor(staticDir?: string) {
    this.root = staticDir !== undefined && staticDir.trim() !== "" ? path.resolve(staticDir) : undefined;
  }

  /** 是否激活（目录已配置且存在且是目录）。 */
  get active(): boolean {
    if (this.root === undefined) return false;
    try {
      return statSync(this.root).isDirectory();
    } catch {
      return false;
    }
  }

  /** 未命中（未激活/路径穿越/文件不存在/非 GET）返回 null。 */
  async handle(req: Request): Promise<Response | null> {
    if (!this.active || req.method !== "GET") return null;
    const root = this.root!;

    const pathname = safeDecode(new URL(req.url).pathname);
    if (pathname === null) return null;
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const abs = path.join(root, rel);

    // 路径穿越守卫：解析后必须仍在 root 内
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;

    const file = Bun.file(abs);
    if (!(await file.exists())) return null;
    // Bun.file 依扩展名自动设置 Content-Type（html/js/css/png…）
    return new Response(file);
  }
}

/** 解码 URL 路径；畸形百分号序列拒绝（null = 不服务）。 */
function safeDecode(p: string): string | null {
  try {
    return decodeURIComponent(p);
  } catch {
    return null;
  }
}
