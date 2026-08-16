/**
 * Mock mode 注入脚本（首迭代直替方案；T4.4 起退役为兼容路径）。
 *
 * 【退役备注（T4.4）】标准入口 = VITE_HELIX_FAKE_TRANSPORT / ?fakeTransport
 * → SessionProvider 经既有 TransportFactory 接缝装配应用侧 fake 模块
 * （apps/shell/src/shared/api/fake-transport.ts，控制面 API 与本脚本逐字
 * 对齐）；fixtures.ts 已切标准入口。本文件保留作兼容路径/降级备注，不再
 * 挂默认 fixture。
 *
 * 原理（直替方案）：生产 HelixWsClient 经 browserTransportFactory 持有
 * `new WebSocket(url)` ——本脚本在应用任何代码执行前替换 window.WebSocket：
 *   - daemon 地址（ws://127.0.0.1:7333）→ 剧本回放 fake transport（等价于
 *     TransportFactory 注入 fake transport；连接状态机/退避/握手全部真实跑）；
 *   - 其余地址（vite HMR 等）→ 透传原生 WebSocket，不影响 dev server。
 *
 * 帧结构严格符合 @helix/protocol v0（e2e/harness/protocol.ts 构造）。
 * 控制面 window.__helixMock 由 spec 经 page.evaluate 驱动（open/emit/netClose/...）。
 */
export const DAEMON_WS_URL = "ws://127.0.0.1:7333";
export const DAEMON_PORT = 7333;

export const MOCK_INIT_SCRIPT = String.raw`
(() => {
  const RealWS = window.WebSocket;
  const DAEMON_URL = "ws://127.0.0.1:7333";

  const instances = [];        // 全部 fake 实例（按创建序）
  const clientFrames = [];     // C→S 帧（JSON 解析后；断言 hello/chat.send/chat.steer）
  const commandWaiters = [];   // waitForCommand 等待队列
  const instanceWaiters = [];  // 等待下一存活实例的队列

  function activeInstance() {
    const alive = instances.filter((i) => i.readyState !== 3);
    return alive.length ? alive[alive.length - 1] : null;
  }
  function nextActive() {
    return new Promise((resolve) => {
      const inst = activeInstance();
      if (inst) resolve(inst);
      else instanceWaiters.push(resolve);
    });
  }
  function fireOpen(inst) {
    inst.readyState = 1;
    if (inst.onopen) inst.onopen({ type: "open" });
  }
  function fireMessage(inst, frame) {
    if (inst.onmessage) inst.onmessage({ data: JSON.stringify(frame) });
  }
  function fireClose(inst, code) {
    inst.readyState = 3;
    if (inst.onclose) inst.onclose({ code: code, reason: "", wasClean: false });
  }

  function FakeWebSocket(url) {
    if (typeof url !== "string" || url.indexOf(DAEMON_URL) !== 0) {
      return new RealWS(url); // vite HMR 等非 daemon 地址透传
    }
    const inst = {
      url: url,
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data) {
        let frame = null;
        try { frame = JSON.parse(data); } catch (e) { frame = null; }
        clientFrames.push(frame);
        const hit = [];
        const rest = [];
        for (const w of commandWaiters) (w.type === (frame && frame.type) ? hit : rest).push(w);
        commandWaiters.length = 0;
        for (const w of rest) commandWaiters.push(w);
        for (const w of hit) w.resolve(frame);
      },
      close() { inst.readyState = 3; }, // stop()/retry() 主动关闭：不出网络事件
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return true; },
    };
    instances.push(inst);
    for (const w of instanceWaiters.splice(0)) w(inst);
    return inst;
  }
  // WebSocket 静态常量必须保留：browserTransportFactory.send 以
  // 'ws.readyState === WebSocket.OPEN' 门控透传，缺失会导致帧被静默吞掉
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;
  window.WebSocket = FakeWebSocket;

  window.__helixMock = {
    async open() { fireOpen(await nextActive()); },
    async emit(frame) { fireMessage(await nextActive(), frame); },
    async emitAll(frames) {
      const inst = await nextActive();
      for (const f of frames) fireMessage(inst, f);
    },
    async netClose(code) { fireClose(await nextActive(), code == null ? 1006 : code); },
    async failHandshake() {
      const inst = await nextActive();
      if (inst.onerror) inst.onerror({ type: "error" });
      fireClose(inst, 1006);
    },
    clientFrames() { return clientFrames.slice(); },
    activeCount() { return instances.filter((i) => i.readyState !== 3).length; },
  };
})();
`;
