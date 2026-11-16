import type {
  ImageGenChannel,
  ImageGenPort,
  ImageGenRequest,
  ImageGenResult,
} from "../../ports/outbound/ImageGenPort";

/**
 * ImageGenService —— 生图渠道注册表与路由（多渠道生图批 v1）。
 *
 * 纯逻辑零 IO（渠道实现才碰网络）：注册序 = 缺省路由优先级序。
 * 路由语义：
 * - channel 显式指定 → 定向路由；未知 id 报错列已知渠道；已知但不可用
 *   报错含原因（教配置，不静默降级换渠道——用户/模型点名要的渠道）。
 * - channel 缺省 → 第一个可用渠道；全不可用报错附各渠道原因清单
 *   （一段可行动的配置指引文案）。
 *
 * 为什么存在：generate_image 工具不该知道渠道清单与优先级；渠道增减
 * 只动组合根装配，路由语义单点可测。
 */

export function createImageGenService(channels: readonly ImageGenChannel[]): ImageGenPort {
  return {
    channels,
    availableChannelIds: () => channels.filter((c) => c.available().ok).map((c) => c.id),
    async generate(request: ImageGenRequest & { channel?: string }): Promise<ImageGenResult> {
      const target = resolveChannel(channels, request.channel);
      return target.generate(request);
    },
  };
}

/** 渠道路由（缺省 = 首个可用；不可用报错文案可行动）。 */
function resolveChannel(
  channels: readonly ImageGenChannel[],
  channel: string | undefined,
): ImageGenChannel {
  if (channel !== undefined) {
    const hit = channels.find((c) => c.id === channel);
    if (hit === undefined) {
      throw new Error(
        `未知生图渠道 "${channel}"（已知：${channels.map((c) => c.id).join("、") || "无"}）`,
      );
    }
    const availability = hit.available();
    if (!availability.ok) {
      throw new Error(`生图渠道 ${hit.id} 不可用：${availability.reason}`);
    }
    return hit;
  }
  const firstAvailable = channels.find((c) => c.available().ok);
  if (firstAvailable !== undefined) return firstAvailable;
  const reasons = channels
    .map((c) => `${c.id}（${c.available().ok ? "可用" : c.available().ok ? "" : reasonOf(c)}）`)
    .join("；");
  throw new Error(
    channels.length === 0
      ? "未装配任何生图渠道"
      : `无可用生图渠道：${reasons}。请在设置中为任一渠道配置 API key 后重试`,
  );
}

function reasonOf(channel: ImageGenChannel): string {
  const availability = channel.available();
  return availability.ok ? "" : availability.reason;
}
