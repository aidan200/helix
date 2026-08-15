/**
 * en-US 词条包（结构随迁；内容不在首迭代范围，AD-18 / brief「不做 en-US 词条内容」）。
 * 键集合与 zh-CN 一致性由 zh-CN.test.ts 守护。
 */
import type { Translations } from "../types";

export const enUS: Translations = {
  chat: {
    header: {
      session: "main-session",
      home: "~/.helix",
    },
    conn: {
      connected: "Connected",
      connecting: "Connecting",
      disconnected: "Disconnected",
      error: "Failed",
    },
    banner: {
      reconnecting: "Connection lost · reconnecting",
      reconnectAttempt: "Attempt {n}",
      reconnectingAddr: "Reconnecting to daemon",
    },
    overlay: {
      connecting: "Connecting to daemon",
      addr: "{addr}",
    },
    error: {
      title: "Cannot connect to daemon",
      desc: "Connection refused after {n} automatic retries.",
      retry: "Retry",
      retryOk: "Connected",
      retryOkSub: "Session projection rebuilt from daemon snapshot",
    },
    empty: {
      title: "Awaiting first instruction",
      suggest: {
        read: "Inspect packages/protocol structure",
        test: "Run workspace tests",
        grep: "Search handshake TODOs",
      },
    },
    composer: {
      placeholder: "Type a message, Enter to send",
      placeholderConnecting: "Establishing connection…",
      placeholderWaiting: "Waiting for connection…",
      send: "Send",
      enterHint: "[[Enter]] send · [[Shift+Enter]] newline",
      projectionNote: "main-session · projection rebuilt from daemon snapshots",
    },
    steer: {
      hint: "Agent generating · queued messages inject after this turn",
      queued: "STEER · queued",
      drained: "Injected · turn ended",
    },
    restore: {
      toast: "Session restored",
      toastSub: "daemon snapshot + event replay · {n} entries rebuilt",
    },
    msg: {
      you: "You",
      agent: "Main session",
    },
    tool: {
      running: "Running",
      done: "Done",
      error: "Failed",
      args: "Args",
      result: "Result",
      resultFailed: "Result · exit {code}",
    },
    theme: {
      dark: "DARK",
      light: "LIGHT",
    },
    tsFormat: "HH:mm",
  },
};
