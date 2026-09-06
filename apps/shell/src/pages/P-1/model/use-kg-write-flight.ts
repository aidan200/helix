/**
 * P-1 KgViewer 写面单飞 hook（M9 #2.31 修复：五写面在途收敛为单一带类型
 * flight——一次一个在途，connection.error 归因零顺序链张冠李戴；发起 /
 * 回执 / 错误 / 超时一处收口）。
 *
 * 旧形态（F-02/F-03 滋生面）：create/purge/indexDelete/review/codeReview 五个
 * 布尔位各自单飞 + 固定顺序 if 归因链——多写面并发在途时一条 connection.error
 * 只被首个命中分支消费（错误归因错位），其余在途位永不清除（按钮永久禁用）。
 *
 * 语义：
 * - launch(kind, send)：在途去重（非空闲静默忽略——UI 侧按钮已在在途时禁用）；
 *   send 返回 false（未连接）立即清位 + onSendFail；
 * - settle(kind)：结果帧回执归因——flight 匹配 kind 才消费（清位 + true），
 *   非本视图发起（或已被错误/超时清位）不消费（false）；
 * - notifyError(message)：connection.error 转发——在途才消费，kind 归因自
 *   单飞位（零顺序链）；
 * - 超时兜底：发起后 FLIGHT_TIMEOUT_MS 无回执自动清位 + onTimeout（结果帧
 *   丢失按钮不永久禁用）。
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** 写面种类（KgViewer 五个发起入口）。 */
export type KgWriteKind = "create" | "purge" | "indexDelete" | "review" | "codeReview";

/** 在途兜底超时（结果帧丢失时清在途位；远长于正常回执时延）。 */
export const KG_WRITE_FLIGHT_TIMEOUT_MS = 60_000;

export interface KgWriteFlightHandlers {
  /** send 返回 false（未连接）——发起即失败交代。 */
  readonly onSendFail: () => void;
  /** connection.error 命中在途 flight（kind 归因自单飞位）。 */
  readonly onConnError: (kind: KgWriteKind, message: string) => void;
  /** 在途超时兜底（结果帧丢失）。 */
  readonly onTimeout: (kind: KgWriteKind) => void;
}

export interface KgWriteFlight {
  /** 当前在途写面（null = 空闲）；驱动全部写入口按钮禁用。 */
  readonly flight: KgWriteKind | null;
  /** 发起写面（在途去重；send false 立即清位 + onSendFail）。 */
  readonly launch: (kind: KgWriteKind, send: () => boolean) => void;
  /** 结果帧回执归因（flight 匹配 kind 才消费：清位 + true）。 */
  readonly settle: (kind: KgWriteKind) => boolean;
  /** connection.error 转发（在途才消费：清位 + onConnError(kind 归因)）。 */
  readonly notifyError: (message: string) => void;
}

export function useKgWriteFlight(handlers: KgWriteFlightHandlers): KgWriteFlight {
  const [flight, setFlight] = useState<KgWriteKind | null>(null);
  // ref 镜像供 listener 闭包读取（listener 不随重渲染重建）；state 驱动渲染。
  const flightRef = useRef<KgWriteKind | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const clearTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  const clear = () => {
    flightRef.current = null;
    setFlight(null);
    clearTimer();
  };
  const arm = (kind: KgWriteKind) => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      if (flightRef.current === kind) {
        clear();
        handlersRef.current.onTimeout(kind);
      }
    }, KG_WRITE_FLIGHT_TIMEOUT_MS);
  };

  const launch = useCallback((kind: KgWriteKind, send: () => boolean) => {
    if (flightRef.current !== null) return; // 一次一个在途（按钮已禁用，防御）
    flightRef.current = kind;
    setFlight(kind);
    if (!send()) {
      flightRef.current = null;
      setFlight(null);
      handlersRef.current.onSendFail();
      return;
    }
    arm(kind);
  }, []);

  const settle = useCallback((kind: KgWriteKind): boolean => {
    if (flightRef.current !== kind) return false; // 非本视图发起 / 已清位
    clear();
    return true;
  }, []);

  const notifyError = useCallback((message: string) => {
    const kind = flightRef.current;
    if (kind === null) return; // 非在途不消费
    clear();
    handlersRef.current.onConnError(kind, message);
  }, []);

  // 卸载清定时器（防卸载后 setState 警告）
  useEffect(() => clearTimer, []);

  return { flight, launch, settle, notifyError };
}
