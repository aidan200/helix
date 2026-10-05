/**
 * SurfaceActionService —— 管家消费面表面能力执行体（M2 四泛型工具的
 * StewardSurfacePort 实现）。
 *
 * 组合面：SurfaceRegistry（act 同一动作管道——D8 不另开通道；seq 回执
 * D7-1）+ browser adapter 读面（snapshot/read/listSurfaces）。shell/cli
 * 连接型表面的 snapshot/read 为描述符占位（M2 范围钳制：shell act 实际
 * 动词不做）；act 对连接型表面照常经 Registry 发 surface.action 帧（回执
 * 远端异步销账，settled 即刻 resolve）。
 */
import type {
  StewardSurfaceActRequest,
  StewardSurfaceActResult,
  StewardSurfaceInfo,
  StewardSurfacePort,
  StewardSurfaceReadResult,
} from "../ports/outbound/StewardSurfacePort";
import type { SurfaceRegistry } from "./SurfaceRegistry";

/** browser 读面（BrowserSurfaceAdapter 实现——组合根注入）。 */
export interface SurfaceBrowserFace {
  listSurfaces(): Promise<readonly { surfaceId: string; kind: "browser"; label: string; capabilities: readonly string[] }[]>;
  snapshot(surfaceId: string): Promise<{ ok: boolean; text: string }>;
  read(surfaceId: string, opts: { selector?: string; maxChars?: number }): Promise<{ ok: boolean; text: string }>;
}

export interface SurfaceActionServiceDeps {
  readonly registry: SurfaceRegistry;
  readonly browser?: SurfaceBrowserFace;
}

export class SurfaceActionService implements StewardSurfacePort {
  constructor(private readonly deps: SurfaceActionServiceDeps) {}

  /** 表面清单：连接型（Registry describe）+ browser 动态 tab 面。 */
  async list(): Promise<readonly StewardSurfaceInfo[]> {
    const out: StewardSurfaceInfo[] = this.deps.registry.describe().map((d) => ({
      surfaceId: d.surfaceId,
      kind: d.kind,
      label: d.surfaceId,
      capabilities: d.capabilities,
    }));
    if (this.deps.browser !== undefined) {
      for (const b of await this.deps.browser.listSurfaces()) out.push(b);
    }
    return out;
  }

  async snapshot(surfaceId: string): Promise<StewardSurfaceReadResult> {
    return this.readFace(surfaceId, (browser) => browser.snapshot(surfaceId));
  }

  async read(
    surfaceId: string,
    opts: { selector?: string; maxChars?: number } = {},
  ): Promise<StewardSurfaceReadResult> {
    return this.readFace(surfaceId, (browser) => browser.read(surfaceId, opts));
  }

  /** act 执行（同一动作管道：Registry act 路由 → settled 回执带序列号回流）。 */
  async act(request: StewardSurfaceActRequest): Promise<StewardSurfaceActResult> {
    const outcome = this.deps.registry.act(request.verb, request.args, {
      risk: request.risk,
      surfaceId: request.surfaceId,
    });
    const receipt = await outcome.settled;
    if (outcome.rejected === true) {
      return { ok: false, seq: outcome.seq, detail: outcome.reason ?? "动作被拒" };
    }
    const detail =
      receipt.results.length === 0
        ? (outcome.reason ?? "已派发（回执待 surface.action.result 销账）")
        : receipt.results
            .map((r) => `${r.target}：${r.ok ? "成功" : "失败"}${r.detail !== undefined ? `（${r.detail}）` : ""}`)
            .join("；");
    return { ok: receipt.results.length === 0 ? outcome.delivered > 0 : receipt.results.every((r) => r.ok), seq: outcome.seq, detail };
  }

  /** 读面路由（browser 表面进 adapter；连接型表面描述符占位）。 */
  private async readFace(
    surfaceId: string,
    run: (browser: SurfaceBrowserFace) => Promise<StewardSurfaceReadResult>,
  ): Promise<StewardSurfaceReadResult> {
    if (surfaceId.startsWith("browser:")) {
      if (this.deps.browser === undefined) return { ok: false, text: "browser 表面未接入（组合根缺 adapter 读面）" };
      return run(this.deps.browser);
    }
    const entry = this.deps.registry.describe().find((d) => surfaceId === d.surfaceId || surfaceId.startsWith(`${d.surfaceId}:`));
    if (entry === undefined) return { ok: false, text: `未知表面：${surfaceId}（先用 surface_list 发现）` };
    return {
      ok: true,
      text: `表面 ${entry.surfaceId}（${entry.kind}；能力：${entry.capabilities.join("/") || "无"}）——快照/内容读取面仅 browser 表面接入（shell/cli 占位，M2 范围钳制）`,
    };
  }
}
