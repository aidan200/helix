import { describe, expect, test } from "bun:test";
import { COMMAND_TYPES, EVENT_TYPES, EVENT_CHANNELS, PROTOCOL_VERSION, isValidProxyUrl, type CommandEnvelope, type EventEnvelope } from "../src";

describe("network proxy wire contract", () => {
  test("commands and events belong to their envelope unions and catalogs", () => {
    const get: CommandEnvelope = { v: PROTOCOL_VERSION, type: "config.get_proxy", payload: {} };
    const set: CommandEnvelope = { v: PROTOCOL_VERSION, type: "config.set_proxy", payload: { enabled: true, url: "http://127.0.0.1:7890" } };
    const result: EventEnvelope = { v: PROTOCOL_VERSION, sessionId: "__system__", type: "config.set_proxy.result", channel: "model", payload: { enabled: true, url: "http://127.0.0.1:7890" } };
    expect(COMMAND_TYPES).toContain(get.type);
    expect(COMMAND_TYPES).toContain(set.type);
    expect(EVENT_TYPES).toContain(result.type);
    expect(EVENT_CHANNELS[result.type]).toBe("model");
  });
  test.each(["http://127.0.0.1:7890", "https://proxy.corp:8443", "http://u:p%40ss@proxy:8080/", "HTTP://proxy:7890"])("valid endpoint: %s", url => expect(isValidProxyUrl(url)).toBe(true));
  test.each(["", "http://", "socks5://proxy:1080", "ftp://proxy:21", "http://proxy:99999", "http://proxy/api", "http://proxy?x=1", "http://proxy#fragment", "http://white space", "http://host\n"])("reject invalid/unsupported endpoint: %s", url => expect(isValidProxyUrl(url)).toBe(false));
});
