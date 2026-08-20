/**
 * Mock mode 直替注入脚本退役残件（N1，M6 工程卫生批删除）。
 *
 * 原 MOCK_INIT_SCRIPT（addInitScript 直替 window.WebSocket）与 DAEMON_WS_URL
 * 已删除——全仓零消费（F-7 同法：grep 证明 + 纯删除）。标准入口 =
 * VITE_HELIX_FAKE_TRANSPORT / ?fakeTransport → SessionProvider 经
 * TransportFactory 装配应用侧 fake 模块（apps/shell/src/shared/api/
 * fake-transport.ts，控制面 API 与已删脚本逐字对齐）。
 *
 * 本文件仅存 DAEMON_PORT（fixtures.ts 离线兜底路由拦截在用）。
 */
export const DAEMON_PORT = 7333;
