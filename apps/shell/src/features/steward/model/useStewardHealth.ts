/**
 * useStewardHealth —— 管家子系统健康面（光球健康角标批）。
 *
 * 消费 steward.health 帧（daemon 侧状态变化才发：判官降级/恢复、TTS 合成
 * 失败/恢复、LLM run 失败/恢复——EventStream.reportStewardHealth 同态去重），
 * 维护各组件最近状态供光球角标呈现。缺省 = 全 ok（未收到任何帧 = 无故障
 * 证据，不是未知——帧是事件驱动，daemon 重启后首个状态变化即重新对齐）。
 */
import { useEffect, useMemo, useState } from "react";
import type { EventEnvelope } from "@helix/protocol";
import { useSession } from "@/entities/session/SessionContext";

/** 故障组件（协议 steward.health.component 同构）。 */
export type StewardHealthComponent = "judge" | "tts" | "stt" | "llm";

/** 单组件健康态。 */
export interface StewardHealthEntry {
  readonly status: "degraded" | "ok";
  readonly reason?: string;
  /** 最近一次状态时刻（Date.now()）。 */
  readonly at: number;
}

export interface UseStewardHealth {
  /** 组件 → 最近状态（缺省 ok）。 */
  readonly health: Partial<Record<StewardHealthComponent, StewardHealthEntry>>;
  /** 当前降级清单（呈现序固定 judge/tts/stt/llm）。 */
  readonly degraded: readonly { readonly component: StewardHealthComponent; readonly reason?: string }[];
}

const COMPONENT_ORDER: readonly StewardHealthComponent[] = ["judge", "tts", "stt", "llm"];

export function useStewardHealth(): UseStewardHealth {
  const { subscribeStewardFrames } = useSession() as {
    subscribeStewardFrames?: (listener: (e: EventEnvelope) => void) => () => void;
  };
  const [health, setHealth] = useState<Partial<Record<StewardHealthComponent, StewardHealthEntry>>>({});

  useEffect(() => {
    if (subscribeStewardFrames === undefined) return;
    return subscribeStewardFrames((event: EventEnvelope) => {
      if (event.type !== "steward.health") return;
      const p = event.payload as { component?: unknown; status?: unknown; reason?: unknown };
      const component = p.component;
      const status = p.status;
      if (
        (component !== "judge" && component !== "tts" && component !== "stt" && component !== "llm") ||
        (status !== "degraded" && status !== "ok")
      ) {
        return;
      }
      const entry: StewardHealthEntry =
        typeof p.reason === "string" && p.reason !== ""
          ? { status, reason: p.reason, at: Date.now() }
          : { status, at: Date.now() };
      setHealth((prev) => ({ ...prev, [component]: entry }));
    });
  }, [subscribeStewardFrames]);

  const degraded = useMemo(
    () =>
      COMPONENT_ORDER.flatMap((component) => {
        const entry = health[component];
        if (entry === undefined || entry.status !== "degraded") return [];
        return [{ component, ...(entry.reason !== undefined ? { reason: entry.reason } : {}) }];
      }),
    [health],
  );

  return { health, degraded };
}
