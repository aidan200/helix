/**
 * LISTEN_SURFACE 帧匹配谓词存在性测试（skill-content 批教训回归）。
 *
 * 背景：agent.skill_content.get.result 曾漏登 subscribeAgentConfigFrames
 * 谓词——页面测试 mock 了 subscribe 函数直通回调，真实谓词无测试，导致
 * daemon 回执到达但页面收不到（"正在读取" 卡死）。本测试钉住各域谓词的
 * 应转发/应拦截帧清单，新增点对点回执必须同步登谓词。
 */
import { describe, expect, it } from "vitest";
import { COMMAND_SURFACE, LISTEN_SURFACE } from "./command-surface";
import type { CommandSurfaceDeps } from "./command-surface";
import { topologyReducer } from "./model/topology";
import { createInitialTopologyState } from "./model/state";
import type { SessionAction, TopologyState } from "./model/state";
import type { SubscriptionLedger } from "./model/subscription-ledger";

describe("LISTEN_SURFACE.subscribeAgentConfigFrames", () => {
  const { match } = LISTEN_SURFACE.subscribeAgentConfigFrames;

  it("转发 agent.config 族全部点对点回执", () => {
    expect(match("agent.config.list.result")).toBe(true);
    expect(match("agent.config.set_enabled.result")).toBe(true);
    expect(match("agent.base_prompt.get.result")).toBe(true);
    expect(match("agent.skill_content.get.result")).toBe(true);
    expect(match("agent.skill.create.result")).toBe(true); // skills 添加批
    expect(match("agent.steward_profile.get.result")).toBe(true); // 管家公民权批
  });

  it("不转发 changed 广播与其他域帧", () => {
    expect(match("agent.config.changed")).toBe(false);
    expect(match("kg.search.result")).toBe(false);
    expect(match("task.list.result")).toBe(false);
    expect(match("trace.query.result")).toBe(false);
  });

  it("转发 connection.error（F5 批 #2：set_enabled 写面 daemon 失败回执清在途）", () => {
    expect(match("connection.error")).toBe(true);
  });
});

describe("LISTEN_SURFACE.subscribeKgFrames", () => {
  const { match } = LISTEN_SURFACE.subscribeKgFrames;

  it("转发 kg 族全部点对点回执 + code.review.create.result + connection.error", () => {
    expect(match("kg.list.result")).toBe(true);
    expect(match("kg.node.detail.result")).toBe(true);
    expect(match("kg.bootstrap.create.result")).toBe(true);
    expect(match("kg.review.create.result")).toBe(true);
    // F5 批 #5：code-review 回执挂既有 kg 通道（E-99）——漏登 = flight.codeReview
    // 永真发起钮永久禁用（TR-89 事故模式），本断言钉住双登记
    expect(match("code.review.create.result")).toBe(true);
    expect(match("connection.error")).toBe(true);
  });

  it("不转发命令帧/广播与其他域帧", () => {
    expect(match("code.review.create")).toBe(false); // 命令非回执
    expect(match("kg.projects")).toBe(false);
    expect(match("task.list.result")).toBe(false);
    expect(match("mcp.servers.list.result")).toBe(false);
  });
});

describe("LISTEN_SURFACE.subscribeConfigFrames", () => {
  const { match } = LISTEN_SURFACE.subscribeConfigFrames;

  it("转发 connection.error（M10 批：config.set_* daemon 失败回执清页面在途）", () => {
    expect(match("connection.error")).toBe(true);
  });

  it("不转发结果帧（config 族结果帧走 topology 消费者）与其他域帧", () => {
    expect(match("config.set_compaction.result")).toBe(false);
    expect(match("config.get_port.result")).toBe(false);
    expect(match("task.list.result")).toBe(false);
  });
});

describe("LISTEN_SURFACE.subscribeMcpFrames", () => {
  const { match } = LISTEN_SURFACE.subscribeMcpFrames;

  it("转发 mcp 族全部点对点回执 + 状态广播 + connection.error", () => {
    expect(match("mcp.servers.list.result")).toBe(true);
    expect(match("mcp.servers.add.result")).toBe(true);
    expect(match("mcp.servers.update.result")).toBe(true);
    expect(match("mcp.servers.remove.result")).toBe(true);
    expect(match("mcp.servers.test.result")).toBe(true);
    expect(match("mcp.tools.list.result")).toBe(true);
    expect(match("mcp.status.changed")).toBe(true);
    expect(match("connection.error")).toBe(true);
  });

  it("不转发其他域帧", () => {
    expect(match("web.status.changed")).toBe(false);
    expect(match("agent.config.list.result")).toBe(false);
    expect(match("task.list.result")).toBe(false);
  });
});

// ── F5 批 #1：model/auth 五写面 send 失败回滚（TR-84——send 返回 false 必收口
// 在途态；旧实现 dispatch started 后丢弃返回值 → in-flight 永锁）──────────

/** 假 deps：send 返回可控；dispatch 走真 topologyReducer（回滚断言读真拓扑）。 */
function fakeDeps(sendOk: boolean): {
  deps: CommandSurfaceDeps;
  topo: () => TopologyState;
} {
  let topo = createInitialTopologyState();
  // 预置凭据条目/旧默认（回滚恢复面数据源）
  topo = {
    ...topo,
    modelConfig: {
      ...topo.modelConfig,
      defaultModel: "anthropic/old-default",
      auth: {
        anthropic: { providerId: "anthropic", configured: true, keyMasked: "····7f3a", verifyStatus: "ok", latencyMs: 120 },
      },
    },
  };
  const deps: CommandSurfaceDeps = {
    send: () => sendOk,
    dispatch: (a: SessionAction) => {
      topo = topologyReducer(topo, a);
    },
    getTopology: () => topo,
    getLedger: () => {
      throw new Error("本批写面不触订阅簿记");
    },
    isGenerating: () => false,
    retryConnection: () => {},
  };
  return { deps, topo: () => topo };
}

describe("COMMAND_SURFACE model/auth 写面 send 失败回滚（F5 批 #1 / TR-84）", () => {
  it("refreshModelCatalog：send false → 返回 false + catalogRefreshing 回滚", () => {
    const { deps, topo } = fakeDeps(false);
    const refresh = COMMAND_SURFACE.refreshModelCatalog(deps);
    expect(refresh()).toBe(false);
    expect(topo().modelConfig.catalogRefreshing).toBe(false);
  });

  it("refreshModelCatalog：send true → 返回 true + catalogRefreshing 置位（结果帧清）", () => {
    const { deps, topo } = fakeDeps(true);
    const refresh = COMMAND_SURFACE.refreshModelCatalog(deps);
    expect(refresh()).toBe(true);
    expect(topo().modelConfig.catalogRefreshing).toBe(true);
  });

  it("setDefaultModel：send false → 乐观值回滚旧默认 + setDefaultInflight 清", () => {
    const { deps, topo } = fakeDeps(false);
    const setDefault = COMMAND_SURFACE.setDefaultModel(deps);
    expect(setDefault("openai/gpt-x")).toBe(false);
    expect(topo().modelConfig.defaultModel).toBe("anthropic/old-default");
    expect(topo().modelConfig.setDefaultInflight).toBeNull();
  });

  it("verifyProvider：send false → verifyInflight 清 + 凭据条目恢复发送前快照", () => {
    const { deps, topo } = fakeDeps(false);
    const verify = COMMAND_SURFACE.verifyProvider(deps);
    expect(verify("anthropic")).toBe(false);
    const mc = topo().modelConfig;
    expect(mc.verifyInflight).toBeNull();
    expect(mc.auth["anthropic"]).toEqual({
      providerId: "anthropic",
      configured: true,
      keyMasked: "····7f3a",
      verifyStatus: "ok",
      latencyMs: 120,
    });
  });

  it("setProviderKey / deleteProviderKey：send false → in-flight 清位", () => {
    const { deps, topo } = fakeDeps(false);
    expect(COMMAND_SURFACE.setProviderKey(deps)("anthropic", "sk-x")).toBe(false);
    expect(topo().modelConfig.setKeyInflight).toBeNull();
    expect(COMMAND_SURFACE.deleteProviderKey(deps)("anthropic")).toBe(false);
    expect(topo().modelConfig.deleteKeyInflight).toBeNull();
  });

  it("setProviderKey：send true → in-flight 保持（结果帧归属锁定不动）", () => {
    const { deps, topo } = fakeDeps(true);
    expect(COMMAND_SURFACE.setProviderKey(deps)("anthropic", "sk-x")).toBe(true);
    expect(topo().modelConfig.setKeyInflight).toBe("anthropic");
  });
});

// ── M9 #2.18：submit 消费 send 返回值（TR-84——conn=connected 但 socket 断线
// 窗口内 send=false 不得静默丢消息：草稿未清 = 恢复 + 返回 false 供 toast）──

/** submit 专用假 deps：活跃 store connected+ready；send 可控并捕获出站帧。 */
function submitDeps(sendOk: boolean, opts: { sessionId: string | null; generating: boolean }) {
  let topo = createInitialTopologyState();
  topo = {
    ...topo,
    active: {
      ...topo.active,
      conn: "connected",
      view: "ready",
      sessionId: opts.sessionId,
      draft: "草稿内容",
      attachments: ["data:image/png;base64,AAAA"],
    },
  };
  const frames: unknown[] = [];
  const deps: CommandSurfaceDeps = {
    send: (cmd) => {
      frames.push(cmd);
      return sendOk;
    },
    dispatch: (a: SessionAction) => {
      topo = topologyReducer(topo, a);
    },
    getTopology: () => topo,
    getLedger: () => {
      throw new Error("submit 不触订阅簿记");
    },
    isGenerating: () => opts.generating,
    retryConnection: () => {},
  };
  return { deps, topo: () => topo, frames };
}

describe("COMMAND_SURFACE submit send 返回值消费（M9 #2.18 / TR-84）", () => {
  it("turn 模式 send false → 返回 false + 草稿/附件原样保留（未清 = 恢复）+ 零 ui/send echo", () => {
    const { deps, topo, frames } = submitDeps(false, { sessionId: "s1", generating: false });
    expect(COMMAND_SURFACE.submit(deps)("你好")).toBe(false);
    expect(frames).toHaveLength(1); // 帧已尝试发出（daemon 未达）
    expect(topo().active.draft).toBe("草稿内容"); // 草稿保留待重发
    expect(topo().active.attachments).toHaveLength(1);
    expect(topo().active.steerQueue).toHaveLength(0);
  });

  it("steer 模式 send false → 返回 false + echo 不入队列坞 + 草稿保留", () => {
    const { deps, topo } = submitDeps(false, { sessionId: "s1", generating: true });
    expect(COMMAND_SURFACE.submit(deps)("补一句")).toBe(false);
    expect(topo().active.steerQueue).toHaveLength(0); // echo 未入坞（零假排队）
    expect(topo().active.draft).toBe("草稿内容");
  });

  it("turn 模式 send true → 返回 true + 草稿/附件清空（既有行为零变更）", () => {
    const { deps, topo, frames } = submitDeps(true, { sessionId: "s1", generating: false });
    expect(COMMAND_SURFACE.submit(deps)("你好")).toBe(true);
    expect(frames[0]).toMatchObject({ type: "chat.send", sessionId: "s1", payload: { text: "你好" } });
    expect(topo().active.draft).toBe("");
    expect(topo().active.attachments).toHaveLength(0);
  });

  it("steer 模式 send true → 返回 true + echo 入队列坞（TR-105 queued 观察面）", () => {
    const { deps, topo, frames } = submitDeps(true, { sessionId: "s1", generating: true });
    expect(COMMAND_SURFACE.submit(deps)("补一句")).toBe(true);
    expect(frames[0]).toMatchObject({ type: "chat.steer", sessionId: "s1", payload: { text: "补一句" } });
    expect(topo().active.steerQueue).toHaveLength(1);
    expect(topo().active.steerQueue[0]!.text).toBe("补一句");
    expect(topo().active.draft).toBe("");
  });

  it("steer 模式草稿防御分支（无活跃会话）→ chat.steer 信封省略 sessionId（构造器收编，零裸帧）", () => {
    const { deps, frames } = submitDeps(true, { sessionId: null, generating: true });
    COMMAND_SURFACE.submit(deps)("防御注入");
    const frame = frames[0] as { type: string; sessionId?: string; payload: unknown };
    expect(frame.type).toBe("chat.steer");
    expect("sessionId" in frame).toBe(false);
    expect(frame.payload).toEqual({ text: "防御注入" });
  });

  it("空文本 → 返回 false 且零帧零动作", () => {
    const { deps, topo, frames } = submitDeps(true, { sessionId: "s1", generating: false });
    expect(COMMAND_SURFACE.submit(deps)("   ")).toBe(false);
    expect(frames).toHaveLength(0);
    expect(topo().active.draft).toBe("草稿内容");
  });
});

describe("COMMAND_SURFACE agent 实例三命令（M9 #2.18：构造器收编零裸帧字面）", () => {
  it("killInstance / subscribeInstance / unsubscribeInstance 出站帧形状 = commands 构造器", () => {
    const { deps, frames } = submitDeps(true, { sessionId: "s1", generating: false });
    COMMAND_SURFACE.killInstance(deps)("a1");
    COMMAND_SURFACE.subscribeInstance(deps)("a2");
    COMMAND_SURFACE.unsubscribeInstance(deps)("a3");
    expect(frames).toEqual([
      { v: expect.any(String), type: "agent.kill", payload: { agentId: "a1" } },
      { v: expect.any(String), type: "agent.subscribe", payload: { agentId: "a2" } },
      { v: expect.any(String), type: "agent.unsubscribe", payload: { agentId: "a3" } },
    ]);
  });
});

// ── code-review H8（shell #8）：config 四设值面吞 send false → 在途永锁
//    （useConfigField.submit 把未发出当已发置 pending）——设值面必须回传
//    boolean（setProviderKey 先例），false 由 submit 面消费。──
describe("COMMAND_SURFACE config 设值面 send 返回值（code-review H8）", () => {
  it("setCompaction/Scheduling/Port/Sandbox：send false → false；send true → true", () => {
    const { deps: bad } = fakeDeps(false);
    expect(COMMAND_SURFACE.setCompactionConfig(bad)(1000, 2000)).toBe(false);
    expect(COMMAND_SURFACE.setSchedulingConfig(bad)(4, 8)).toBe(false);
    expect(COMMAND_SURFACE.setPortConfig(bad)(7333)).toBe(false);
    expect(COMMAND_SURFACE.setSandboxConfig(bad)({ enabled: true })).toBe(false);
    const { deps: good } = fakeDeps(true);
    expect(COMMAND_SURFACE.setCompactionConfig(good)(1000, 2000)).toBe(true);
    expect(COMMAND_SURFACE.setSchedulingConfig(good)(4, 8)).toBe(true);
    expect(COMMAND_SURFACE.setPortConfig(good)(7333)).toBe(true);
    expect(COMMAND_SURFACE.setSandboxConfig(good)({ enabled: true })).toBe(true);
  });
});

// ── code-review M 族：setThinkingDefault 乐观值回滚 + steerInstance 先 send
//    后 echo（TR-168 挂靠——send 返回值必消费；setDefaultModel/submit 先例）。──
describe("COMMAND_SURFACE setThinkingDefault send 消费（code-review M，TR-168）", () => {
  it("send false → aborted 回滚乐观值 + 返回 false；send true → 乐观值保持", () => {
    const { deps, topo } = fakeDeps(false);
    deps.dispatch({ type: "model/set-thinking-default-started", level: "low" }); // 基线默认档
    expect(COMMAND_SURFACE.setThinkingDefault(deps)("high")).toBe(false);
    expect(topo().modelConfig.defaultThinking).toBe("low"); // 回滚（未发出不留假反馈）
    const { deps: good, topo: topoGood } = fakeDeps(true);
    expect(COMMAND_SURFACE.setThinkingDefault(good)("high")).toBe(true);
    expect(topoGood().modelConfig.defaultThinking).toBe("high"); // 乐观保持（回执确认）
  });
});

describe("COMMAND_SURFACE steerInstance 先 send 后 echo（code-review M，TR-168）", () => {
  it("send false → 零幽灵 echo（entries 不变）+ 返回 false；send true → echo 投影在场", () => {
    const { deps, topo } = submitDeps(false, { sessionId: "s1", generating: false });
    const before = topo().active.entries.length;
    expect(COMMAND_SURFACE.steerInstance(deps)("定向指令", "agent-x")).toBe(false);
    expect(topo().active.entries.length).toBe(before); // 未发出零投影（幽灵回声消除）
    const { deps: good, topo: topoGood } = submitDeps(true, { sessionId: "s1", generating: false });
    expect(COMMAND_SURFACE.steerInstance(good)("定向指令", "agent-x")).toBe(true);
    expect(topoGood().active.entries.length).toBe(1); // echo 在场（双投影其一）
  });
});

describe("COMMAND_SURFACE setSessionModel 返回值（code-review 族A，TR-168）", () => {
  it("会话态透传 send 返回值（false=未发出）；草稿态本地暂存恒 true", () => {
    const bad = submitDeps(false, { sessionId: "s1", generating: false });
    // 现行行为红：返回 void（undefined）——send 返回值被丢弃
    expect(COMMAND_SURFACE.setSessionModel(bad.deps)("anthropic/claude-x")).toBe(false);
    const good = submitDeps(true, { sessionId: "s1", generating: false });
    expect(COMMAND_SURFACE.setSessionModel(good.deps)("anthropic/claude-x")).toBe(true);
    const draft = submitDeps(false, { sessionId: null, generating: false });
    expect(COMMAND_SURFACE.setSessionModel(draft.deps)("anthropic/claude-x")).toBe(true); // 草稿本地暂存恒成
  });
});
