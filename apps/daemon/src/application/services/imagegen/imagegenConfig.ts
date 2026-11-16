import type { ImageGenConfigPatch, ImageGenConfigPort, ImageGenConfigState } from "../../ports/outbound/ImageGenConfigPort";
import { IMAGEGEN_CHANNEL_IDS, IMAGEGEN_CONFIG_FIELDS } from "@helix/protocol";

/**
 * imagegenConfig —— 生图渠道配置域（多渠道生图批 v1）。
 *
 * 定位：3 字段（defaultChannel + openaiModel/googleModel）的配置语义单源
 * （默认值 + 部分更新合并 + KV 解析），照 voiceModelConfig.ts 单源先例。
 * 字段名契约单源在 @helix/protocol（IMAGEGEN_CONFIG_FIELDS——协议载荷、
 * KV JSON、store 合并遍历同一份）。
 *
 * 默认纪律：defaultChannel 默认 ""（= 自动：按渠道注册序取首个可用——
 * 注册序即优先级序）；模型字段默认 ""（= 渠道内置默认模型）。空串写入
 * 一律回落 ""（「恢复默认」语义）。
 */

export type { ImageGenConfigPatch, ImageGenConfigState };

/** 缺省值（全 "" = 自动渠道 + 渠道内置默认模型——零配置开箱即用）。 */
export const DEFAULT_IMAGE_GEN_CONFIG: ImageGenConfigState = {
  defaultChannel: "",
  openaiModel: "",
  googleModel: "",
};

/** defaultChannel 合法值域（IMAGEGEN_CHANNEL_IDS ∪ {""}——空串 = 自动）。 */
export function isValidImageGenChannel(value: string): boolean {
  return value === "" || (IMAGEGEN_CHANNEL_IDS as readonly string[]).includes(value);
}

/**
 * 部分更新合并：携带项写入（trim），未携带项保留现值；trim 后空串 = ""。
 * defaultChannel 非法值由 ws handler 层前置校验拦截（协议契约 invalid_payload）
 * ——纯函数不做拒绝，保持合并语义单一。
 */
export function applyImageGenPatch(current: ImageGenConfigState, patch: ImageGenConfigPatch): ImageGenConfigState {
  const next: Record<string, string> = { ...current };
  const patchRec = patch as Record<string, string | undefined>;
  for (const field of IMAGEGEN_CONFIG_FIELDS) {
    const value = patchRec[field];
    if (value === undefined) continue;
    next[field] = value.trim();
  }
  return { defaultChannel: next.defaultChannel, openaiModel: next.openaiModel, googleModel: next.googleModel };
}

/** KV JSON 原值 → 全量态（非法 JSON/非对象 → undefined 保持最近已知值；脏字段回落 ""）。 */
export function parseImageGenConfig(raw: string | undefined): ImageGenConfigState | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const rec = parsed as Record<string, unknown>;
  const out: Record<string, string> = { ...DEFAULT_IMAGE_GEN_CONFIG };
  for (const field of IMAGEGEN_CONFIG_FIELDS) {
    const value = rec[field];
    if (typeof value === "string" && value.trim() !== "") {
      out[field] = value.trim();
    }
  }
  return { defaultChannel: out.defaultChannel, openaiModel: out.openaiModel, googleModel: out.googleModel };
}
