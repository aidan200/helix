import path from "node:path";
import { statSync } from "node:fs";

/**
 * StaticServe —— 前端静态产物驱动侧（architecture.md §3.5；CL-6 / F(6).3）。
 *
 * serve 前端构建产物目录（config.json 的 staticDir，可配置）：
 * - dev 期前端直连 vite dev server，不经本 adapter；
 * - 生产形态（Tauri 壳内 / standalone）由 daemon 自己 serve 构建产物；
 * - 目录未配置或不存在：daemon 照常启动（T1.7 前无产物属正常），
 *   handle 一律返回 null（HTTP 404 由 ws-server 兜底）。
 *
 * 零依赖：Bun.file + 扩展名自动 Content-Type；路径穿越（..）拒绝。
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
