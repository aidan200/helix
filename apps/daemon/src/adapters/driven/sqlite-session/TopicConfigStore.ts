import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";
import type { TopicConfig, TopicConfigPort } from "../../../application/ports/outbound/TopicConfigPort";
import { makeKvConfigStore } from "./KvConfigStore";

/**
 * TopicConfigStore —— 动态主题配置的语义包装（动态主题批，2026-09-24；
 * SandboxConfigStore/SchedulingConfigStore 同构模板：RuntimeConfigPort KV
 * 上 topic_config 单键 JSON 读写，缺省回落全关——失败安全方向是「不演进」
 * 而非「意外花钱」）。写面经 RuntimeConfigPort → WriteQueue 单写通道（AG-06）。
 *
 * 单键 JSON 而非多布尔键：四字段同源同读（开关+模型+分类开关+端点是同一
 * 决策面），部分更新合并逻辑在 handler 侧单点，本存储只整存整取。
 *
 * 生效语义：运行期即热——锚点判定前实时读（SessionTitleService），设置
 * 保存后下一次锚点即按新配置执行，无需重启。
 */
export class TopicConfigStore implements TopicConfigPort {
  private readonly store: ReturnType<typeof makeKvConfigStore<TopicConfig>>;

  constructor(runtimeConfig: RuntimeConfigPort) {
    this.store = makeKvConfigStore<TopicConfig>(runtimeConfig, {
      key: "topic_config",
      parse: parseTopicConfig,
      fallback: { enabled: false, model: null, classifyEnabled: false, classifyEndpointId: null },
      clone: (v) => ({ enabled: v.enabled, model: v.model, classifyEnabled: v.classifyEnabled, classifyEndpointId: v.classifyEndpointId }),
      serialize: (v) => JSON.stringify(v),
      warnLabel: "TopicConfigStore",
    });
  }

  /** 当前配置（存储值 ?? 缺省全关；db 已关闭 → 最近已知值）。 */
  current(): TopicConfig {
    return this.store.current();
  }

  /** 写入（单写通道，落盘完成即返回；同步观测缓存）。 */
  set(config: TopicConfig): Promise<void> {
    return this.store.set(config);
  }
}

/** 解析 KV JSON 值 → TopicConfig；非法/缺失 → undefined（调用方保缺省全关）。
 * 逐字段防御：enabled/classifyEnabled 布尔顿判（缺省 false）、model 与
 * classifyEndpointId 字符串或 null（非字符串视为 null）。 */
function parseTopicConfig(raw: string | undefined): TopicConfig | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
    return {
      enabled: parsed["enabled"] === true,
      model: str(parsed["model"]),
      classifyEnabled: parsed["classifyEnabled"] === true,
      classifyEndpointId: str(parsed["classifyEndpointId"]),
    };
  } catch {
    return undefined;
  }
}
