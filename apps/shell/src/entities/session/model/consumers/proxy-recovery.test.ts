import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, SYSTEM_SESSION_ID, type EventEnvelope } from "@helix/protocol";
import { topologyReducer } from "../topology";
import { createInitialTopologyState } from "../state";

const error = (command: string): EventEnvelope => ({ v: PROTOCOL_VERSION, sessionId: SYSTEM_SESSION_ID,
  type: "connection.error", payload: { code: "command.invalid_payload", message: `rejected（命令 ${command}）` } });

describe("proxy flight ownership and disconnect", () => {
  it("unrelated model/auth failures must not clear proxy save flight", () => {
    let topo = createInitialTopologyState();
    topo = topologyReducer(topo, { type: "model/proxy-save-started" });
    topo = topologyReducer(topo, { type: "event", event: error("auth.verify"), ts: 0 });
    expect(topo.modelConfig.proxyInflight).toBe(true);
  });
  it("proxy failure must not clear unrelated model/auth save flight", () => {
    let topo = createInitialTopologyState();
    topo = topologyReducer(topo, { type: "model/proxy-save-started" });
    topo.modelConfig.setKeyInflight = "provider-test";
    topo = topologyReducer(topo, { type: "event", event: error("config.set_proxy"), ts: 0 });
    expect(topo.modelConfig.proxyInflight).toBe(false);
    expect(topo.modelConfig.setKeyInflight).toBe("provider-test");
  });
  it("disconnect clears saved feedback even when no save is in flight", () => {
    const topo = createInitialTopologyState();
    topo.modelConfig.proxySaved = true;
    expect(topologyReducer(topo, { type: "conn/disconnected" }).modelConfig.proxySaved).toBe(false);
  });
});
