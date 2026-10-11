/**
 * speech-floor 单测 —— 出声面发言协调器（播×播互斥；双声重叠修复批 ①④）。
 *
 * 断言面（fake control——零 React 零音频设备）：
 * - 对话起播（首个源进入）→ 通知 stopAndClear（最新对话优先——停在播+清队列）；
 *   嵌套源逐个进出只在「空 ↔ 首」边沿触发；
 * - 对话收口（末源退出）→ 通知 resume（延后队列串行放行）；
 * - dialogueSpeechActive 在场判别 + begin/end 幂等配对；
 * - stopNotificationSpeech 直停通知面（stopSpeaking 全轨停止的④入口）；
 *   未登记控制时全程 no-op（useVoiceBroadcast 未挂载形态）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginDialogueSpeech,
  beginNotificationPlayback,
  dialogueSpeechActive,
  endDialogueSpeech,
  endNotificationPlayback,
  micOccupied,
  notificationSpeechActive,
  onNotificationPlaybackChange,
  onNotificationQueueChange,
  registerNotificationSpeech,
  resetSpeechFloorForTest,
  setMicOccupied,
  setNotificationQueue,
  stopNotificationSpeech,
  type NotificationSpeechControl,
} from "./speech-floor";

function fakeControl(): NotificationSpeechControl & {
  stopAndClear: ReturnType<typeof vi.fn<() => void>>;
  resume: ReturnType<typeof vi.fn<() => void>>;
} {
  return { stopAndClear: vi.fn((): void => undefined), resume: vi.fn((): void => undefined) };
}

describe("通知队列深度镜像（TTS 队列计数双轨入账）", () => {
  afterEach(() => {
    resetSpeechFloorForTest();
  });

  it("setNotificationQueue 推深度、同深去重、退订即断", () => {
    const seen: number[] = [];
    const off = onNotificationQueueChange((d) => seen.push(d));
    setNotificationQueue(2);
    setNotificationQueue(2); // 同深去重
    setNotificationQueue(0);
    expect(seen).toEqual([2, 0]);
    off();
    setNotificationQueue(5);
    expect(seen).toEqual([2, 0]); // 退订后零推送
  });
});

describe("speech-floor（发言协调器：对话 > 通知，播×播互斥）", () => {
  afterEach(() => {
    resetSpeechFloorForTest();
  });

  it("对话起播（空 → 首源）→ 通知 stopAndClear（最新对话优先）；嵌套第二源不再触发", () => {
    const control = fakeControl();
    registerNotificationSpeech(control);
    beginDialogueSpeech("stream");
    expect(control.stopAndClear).toHaveBeenCalledTimes(1);
    beginDialogueSpeech("legacy"); // 嵌套（b 面叠在 a 面上）
    expect(control.stopAndClear).toHaveBeenCalledTimes(1); // 只在空→首边沿
    expect(dialogueSpeechActive()).toBe(true);
  });

  it("对话收口（末源退出）→ 通知 resume；中途退出单源不触发", () => {
    const control = fakeControl();
    registerNotificationSpeech(control);
    beginDialogueSpeech("stream");
    beginDialogueSpeech("legacy");
    endDialogueSpeech("stream"); // a 面收口——b 仍在场
    expect(control.resume).not.toHaveBeenCalled();
    endDialogueSpeech("legacy"); // 末源退出 → 放行
    expect(control.resume).toHaveBeenCalledTimes(1);
    expect(dialogueSpeechActive()).toBe(false);
  });

  it("begin/end 幂等：重复 begin 同源不叠、end 未登记源 no-op（不误触 resume）", () => {
    const control = fakeControl();
    registerNotificationSpeech(control);
    beginDialogueSpeech("round");
    beginDialogueSpeech("round"); // 幂等
    expect(control.stopAndClear).toHaveBeenCalledTimes(1);
    endDialogueSpeech("round");
    endDialogueSpeech("round"); // 二次 end no-op
    expect(control.resume).toHaveBeenCalledTimes(1); // 不重复放行
    endDialogueSpeech("unknown"); // 未登记源
    expect(control.resume).toHaveBeenCalledTimes(1);
  });

  it("stopNotificationSpeech（④ 全轨停止的通知面）：直停；未登记控制 no-op 不抛", () => {
    expect(() => stopNotificationSpeech()).not.toThrow(); // useVoiceBroadcast 未挂载
    const control = fakeControl();
    registerNotificationSpeech(control);
    stopNotificationSpeech();
    expect(control.stopAndClear).toHaveBeenCalledTimes(1);
    expect(control.resume).not.toHaveBeenCalled(); // 停止 = 弃播不续——零放行
  });

  it("registerNotificationSpeech(null) 卸载收位：后续对话边沿零回调（不留幽灵控制）", () => {
    const control = fakeControl();
    registerNotificationSpeech(control);
    registerNotificationSpeech(null);
    beginDialogueSpeech("stream");
    endDialogueSpeech("stream");
    expect(control.stopAndClear).not.toHaveBeenCalled();
    expect(control.resume).not.toHaveBeenCalled();
  });
});

describe("speech-floor（通知占用 + 麦克占用——打断不灵敏/重叠双修批）", () => {
  afterEach(() => {
    resetSpeechFloorForTest();
  });

  it("通知占用：begin/end 边沿镜像，notificationSpeechActive 供 barge-in 门武装", () => {
    expect(notificationSpeechActive()).toBe(false);
    beginNotificationPlayback();
    expect(notificationSpeechActive()).toBe(true);
    endNotificationPlayback();
    expect(notificationSpeechActive()).toBe(false);
    endNotificationPlayback(); // 幂等
    expect(notificationSpeechActive()).toBe(false);
  });

  it("通知占用订阅面（光球说话姿镜像驱动）：边沿通知，重复 begin/end 幂等零通知，抛错隔离", () => {
    const seen: boolean[] = [];
    const boom = () => {
      throw new Error("listener boom");
    };
    const off = onNotificationPlaybackChange((active) => seen.push(active));
    onNotificationPlaybackChange(boom);
    beginNotificationPlayback(); // → true 边沿（首监听者抛错不阻断第二者）
    expect(seen).toEqual([true]);
    beginNotificationPlayback(); // 幂等：零通知
    expect(seen).toEqual([true]);
    endNotificationPlayback(); // → false 边沿
    expect(seen).toEqual([true, false]);
    endNotificationPlayback(); // 幂等：零通知
    expect(seen).toEqual([true, false]);
    off();
    beginNotificationPlayback(); // 退订后零通知
    expect(seen).toEqual([true, false]);
    endNotificationPlayback();
  });

  it("麦克占用：置位/复位 + true→false 边沿触发通知 resume（收音期延后通知的放行面）", () => {
    const control = fakeControl();
    registerNotificationSpeech(control);
    setMicOccupied(true);
    expect(micOccupied()).toBe(true);
    expect(control.resume).not.toHaveBeenCalled(); // 占用不触发任何回调
    setMicOccupied(true); // 幂等
    expect(control.resume).not.toHaveBeenCalled();
    setMicOccupied(false); // 释放 → resume（延后队列串行放行）
    expect(micOccupied()).toBe(false);
    expect(control.resume).toHaveBeenCalledTimes(1);
    setMicOccupied(false); // 幂等：不再触发
    expect(control.resume).toHaveBeenCalledTimes(1);
  });

  it("reset 清位：占用态与麦克占用全复位（测试隔离零泄漏）", () => {
    beginNotificationPlayback();
    setMicOccupied(true);
    resetSpeechFloorForTest();
    expect(notificationSpeechActive()).toBe(false);
    expect(micOccupied()).toBe(false);
  });
});
