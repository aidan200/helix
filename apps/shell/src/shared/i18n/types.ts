/** P-1 聊天页文案命名空间（AD-18：UI 文案全 key；领域数据不在此列）。 */
export interface ChatTranslations {
  header: {
    session: string;
    home: string;
  };
  conn: {
    connected: string;
    connecting: string;
    disconnected: string;
    error: string;
  };
  banner: {
    reconnecting: string;
    reconnectAttempt: string;
    reconnectingAddr: string;
  };
  overlay: {
    connecting: string;
    addr: string;
  };
  error: {
    title: string;
    desc: string;
    retry: string;
    retryOk: string;
    retryOkSub: string;
  };
  empty: {
    title: string;
    suggest: {
      read: string;
      test: string;
      grep: string;
    };
  };
  composer: {
    placeholder: string;
    placeholderConnecting: string;
    placeholderWaiting: string;
    send: string;
    /** 值内 [[x]] 标记渲染为 kbd 键帽（如 "[[Enter]] 发送"） */
    enterHint: string;
    projectionNote: string;
  };
  steer: {
    hint: string;
    queued: string;
    drained: string;
  };
  restore: {
    toast: string;
    toastSub: string;
  };
  msg: {
    you: string;
    agent: string;
  };
  tool: {
    running: string;
    done: string;
    error: string;
    args: string;
    result: string;
    resultFailed: string;
  };
  theme: {
    dark: string;
    light: string;
  };
  /** 时间戳格式（"HH:mm"） */
  tsFormat: string;
}

export interface Translations {
  chat: ChatTranslations;
}

export type Lang = "zh-CN" | "en-US";
