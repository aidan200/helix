/**
 * useStewardVoiceEarMeter —— 耳 meter 采样副作用装配（P2 体量门 ④ 轻拆批：
 * 从 useStewardVoice.ts 机械迁出，hook 体逐字未改；调用点原位——effect
 * 注册序与迁出前一致）。
 *
 * 双工会话活跃期（duplex × 语音模式）建一路 RMS 采集：getUserMedia → meter
 * 工厂 → onLevel 逐帧回调（底噪校准采样 + barge-in 门消费在组合根注入）；
 * mic 不可用/被拒静默降级关闭（语音主链不受影响），收口 track.stop 即刻。
 */
import { useEffect, useRef } from "react";
import { createWorkletRmsMeter } from "@/shared/lib/rms-meter";
import type { MeterFrame, RmsMeter, RmsMeterFactory } from "@/shared/lib/rms-meter";
import type { StewardInputMode } from "./steward-voice-machine";

// ── B2 barge-in 耳朵：双工会话期 RMS 采样（duplex 活跃 × 语音模式；
//    meter 注入面从「面板活跃」平移「双工会话活跃」——语义同构，判据
//    零改动 E-200；duplex 落即刻 track.stop。mic 不可用/被拒 → barge-in
//    降级关闭，语音主链不受影响）──
/** 耳 meter 装配的注入面（设备面可注入 fake meter——测试缝）。 */
export interface StewardVoiceEarMeterDeps {
  readonly active: boolean;
  readonly mode: StewardInputMode;
  readonly onEarFrame: (frame: MeterFrame) => void;
  readonly createMeter?: RmsMeterFactory;
}

export function useStewardVoiceEarMeter(deps: StewardVoiceEarMeterDeps): void {
  const { active: duplexActive, mode, onEarFrame, createMeter } = deps;
  const earMeterFactoryRef = useRef(createMeter ?? createWorkletRmsMeter);
  earMeterFactoryRef.current = createMeter ?? createWorkletRmsMeter;
  useEffect(() => {
    if (!duplexActive || mode !== "voice") return;
    if (typeof navigator === "undefined" || navigator.mediaDevices === undefined) return;
    let cancelled = false;
    let meter: RmsMeter | null = null;
    let stream: MediaStream | null = null;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        const created = await earMeterFactoryRef.current(stream);
        if (created === null || cancelled) {
          created?.close();
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        meter = created;
        created.onLevel((frame) => {
          if (cancelled) return;
          onEarFrame(frame);
        });
      } catch {
        // 麦不可用/被拒：barge-in 降级关闭（环境面——语音主链不受影响）
      }
    })();
    return () => {
      cancelled = true;
      meter?.close();
      if (stream !== null) for (const track of stream.getTracks()) track.stop();
    };
  }, [duplexActive, mode, onEarFrame]);
}
