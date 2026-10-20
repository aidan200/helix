import type { RuntimeConfigPort } from "../../../application/ports/outbound/RuntimeConfigPort";
import type { SummaryConfigPatch, SummaryConfigPort } from "../../../application/ports/outbound/SummaryConfigPort";
import {
  SUMMARY_ENABLED_KEY,
  SUMMARY_EVERY_TURNS_KEY,
  SUMMARY_MODEL_KEY,
  SUMMARY_TASK_ENABLED_KEY,
  SUMMARY_TASK_MODEL_KEY,
  readSummaryConfig,
  type SummaryConfigState,
} from "../../../application/summary/summaryConfig";

/**
 * 分层口径（低危批备案，TR-13 张力面）：本文件的 application import 指向
 * **纯函数 + 键常量单源**（KgConfigStore = application/services/kg/kgConfig，
 * SummaryConfigStore = application/summary/summaryConfig，
 * VoiceModelConfigStore = application/voice/voiceModelConfig），不是服务——
 * 键位/解析/合并判据全仓只允许一份，端口层（port 文件）目前不承载纯函数，
 * 各处复制键常量即制造双源。口径：驱动适配器可 import application 的纯常量/
 * 纯函数单元，禁 import 带依赖构造的服务类（越界即以端口/domain 落位替代）。
 * 机械守护见 test/unit/adapter-layer-pure-imports.test.ts。
 */
/**
 * SummaryConfigStore —— 总结配置域的读写实现（会话总结器独立化批①；
 * TopicConfigStore 前身的五键形态，与 memory.* 通用域同构）。RuntimeConfig
 * KV 五键直接读写（键位/解析单源 ../summary/summaryConfig.ts——本存储只做
 * 写入路由，值语义在读面兜底）。写面经 RuntimeConfigPort → WriteQueue 单写
 * 通道（AG-06）。
 *
 * 生效语义：运行期即热——锚点判定前实时读（SessionSummaryService），设置
 * 保存后下一次锚点即按新配置执行，无需重启。槽位写入 ""/null = 清空回
 * 未配置态（无默认纪律——清空是真实业务态而非无效写）。
 */
export class SummaryConfigStore implements SummaryConfigPort {
  private readonly runtimeConfig: RuntimeConfigPort;

  constructor(runtimeConfig: RuntimeConfigPort) {
    this.runtimeConfig = runtimeConfig;
  }

  /** 当前配置（生效值读面；db 已关闭 → get 缓存语义由 RuntimeConfigPort 自决）。 */
  current(): SummaryConfigState {
    return readSummaryConfig(this.runtimeConfig);
  }

  /** 部分更新写入（携带项写入，未携带项保留现值；落盘完成即返回 + 回读新现态）。 */
  async set(patch: SummaryConfigPatch): Promise<SummaryConfigState> {
    if (patch.enabled !== undefined) {
      await this.runtimeConfig.set(SUMMARY_ENABLED_KEY, patch.enabled ? "1" : "0");
    }
    if (patch.everyTurns !== undefined) {
      await this.runtimeConfig.set(SUMMARY_EVERY_TURNS_KEY, String(patch.everyTurns));
    }
    if (patch.model !== undefined) {
      await this.runtimeConfig.set(SUMMARY_MODEL_KEY, slotValue(patch.model));
    }
    if (patch.task?.enabled !== undefined) {
      await this.runtimeConfig.set(SUMMARY_TASK_ENABLED_KEY, patch.task.enabled ? "1" : "0");
    }
    if (patch.task?.model !== undefined) {
      await this.runtimeConfig.set(SUMMARY_TASK_MODEL_KEY, slotValue(patch.task.model));
    }
    return this.current();
  }
}

/** 槽位归一（null/空串 = 清空回未配置态；非空写 trim 后原值）。 */
function slotValue(model: string | null): string {
  return model === null ? "" : model.trim();
}
