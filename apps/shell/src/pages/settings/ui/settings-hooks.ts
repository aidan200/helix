/**
 * 设置页配置卡共用 hook（M10 批⑤：三卡状态机/两段式删除同构复制一处承载）。
 *
 * - useConfigField：config 族输入卡状态机——脏态门控（M46：用户未保存编辑
 *   不被结果帧回填覆盖）+ 在途对账（M44：「已保存」由结果帧驱动，非乐观
 *   置位）+ connection.error 在途失败收口（M10 批②：config.set_* daemon
 *   失败无结果帧——清 pending + 行内错误交代，不假「已保存」、不永锁
 *   在途致后续读帧被误当保存回执）。compaction/scheduling/port 三卡同构。
 * - useArmedConfirm：两段式删除（首击 armed → 超时复原；同 id 二击执行
 *   action）——Models/Mcp 两区同构复制退役。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EventEnvelope } from "@helix/protocol";
import { useI18n } from "@/shared/i18n";
import { useSession } from "@/entities/session/SessionContext";
import { commandOfConnectionError } from "@/shared/lib/command-error";

/** config 族输入卡控制器（输入文本组 + 保存反馈 + 在途失败交代）。 */
export interface ConfigFieldController {
  /** 输入框文本组（与 toInputs 映射同形；未拉取到配置前为空组）。 */
  readonly inputs: readonly string[];
  /** 输入变更（脏态置位 + 清「已保存」/失败交代）。 */
  readonly setInput: (index: number, value: string) => void;
  /** 「已保存」反馈（M44：结果帧在途对账驱动，非乐观置位）。 */
  readonly saved: boolean;
  /** 在途失败交代（connection.error 清 pending 后行内展示；再输入/再保存清）。 */
  readonly saveError: string | null;
  /**
   * 保存入口：send = 校验通过后的命令发送（显式返回 false = 未连接未发出
   *  ——不置在途 + saveError 行内交代，code-review H8：不假「已保存」、
   *  不永锁在途致后续读帧被误当保存回执；既有 void 返回视为已发）。
   * 仅发送成功才置在途——未发出不锁对账（F5 批 TR-84 同纪律）。
   */
  readonly submit: (send: () => unknown) => boolean;
}

/**
 * config 族输入卡状态机（三卡同构单点）：
 * - config = topology 配置块（null = 未拉取到）；toInputs = 配置块 → 输入
 *   框文本组映射（回填/对账落值）；
 * - 结果帧对账：在途（pending）→ 落值 + 「已保存」；非在途且脏 → 不回填
 *   覆盖（M46 门控）；
 * - 在途失败：connection.error（subscribeConfigFrames 域）清 pending +
 *   saveError 行内交代——尾缀归因（TR-84/族B：「（命令 <type>）」单一构
 *   造点 WsServerAdapter）——带尾缀时仅本卡写面命令消费（他卡/页面外
 *   命令族的拒绝不误清本卡在途、不误显示他卡错误；否则本卡真实结果帧
 *   随后到达会被 dirty 门控跳过回填，「已保存」永失）；无尾缀旧 daemon
 *   容忍按可能本卡处理（宁误交代不静默）。
 */
export function useConfigField<T>(
  config: T | null,
  toInputs: (config: T) => readonly string[],
  /** 本卡写面命令名（connection.error 尾缀归因判据——每卡一条写命令）。 */
  command: string,
): ConfigFieldController {
  const { subscribeConfigFrames } = useSession();
  const { t } = useI18n();
  const [inputs, setInputs] = useState<readonly string[]>([]);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 用户未保存编辑（M46 脏态门控）。 */
  const dirtyRef = useRef(false);
  /** 保存在途（M44：结果帧对账锚；connection.error 收口清位）。 */
  const pendingRef = useRef(false);

  // 结果帧到达：保存在途对账 → 落「已保存」（M44 真实反馈）；
  // 非在途且用户有未保存编辑 → 不回填覆盖（M46 dirty 门控）
  useEffect(() => {
    if (config === null) return;
    if (pendingRef.current) {
      pendingRef.current = false;
      dirtyRef.current = false;
      setInputs(toInputs(config));
      setSaved(true);
      setSaveError(null);
      return;
    }
    if (dirtyRef.current) return;
    setInputs(toInputs(config));
    // toInputs 为页面内联映射（随 render 新鲜闭包）——依赖仅钉配置块本体
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  // M10 批②/族B：config 族在途错误经 connection.error 收口——尾缀归因 +
  // 单飞门控：非本卡写面命令不消费（他卡在途不被误摘）；清 pending +
  // 行内错误（不假「已保存」；在途不永锁，后续读帧不被误当保存回执）
  useEffect(
    () =>
      subscribeConfigFrames((e: EventEnvelope) => {
        if (e.type !== "connection.error") return;
        if (!pendingRef.current) return; // 单飞门控：非本卡在途不消费
        const message =
          (e.payload as { message?: string } | undefined)?.message ?? "connection.error";
        const cmd = commandOfConnectionError(message);
        if (cmd !== undefined && cmd !== command) return; // 族B 尾缀归因：他命令不归本卡
        pendingRef.current = false;
        setSaved(false);
        setSaveError(message);
      }),
    [subscribeConfigFrames, command],
  );

  const setInput = useCallback((index: number, value: string) => {
    dirtyRef.current = true;
    setSaved(false);
    setSaveError(null);
    // 配置未拉取前 inputs 为空组——按位补齐，不丢拉取前输入（M44 链路：
    // 结果帧到达后非脏才回填；脏态门控保护用户已输入值）
    setInputs((prev) => {
      const next = [...prev];
      while (next.length <= index) next.push("");
      next[index] = value;
      return next;
    });
  }, []);

  const submit = useCallback(
    (send: () => unknown): boolean => {
      if (send() === false) {
        // 未发出（未连接）——不置在途 + 行内交代（code-review H8：不静默、
        // 不假「已保存」、不永锁在途致后续读帧被误当保存回执）
        setSaved(false);
        setSaveError(t("chat.settings.general.sendFail"));
        return false;
      }
      pendingRef.current = true;
      setSaved(false);
      setSaveError(null);
      return true;
    },
    [t],
  );

  return { inputs, setInput, saved, saveError, submit };
}

/** 端点「设为默认」写面命令（向量/分类两 tab 共用；尾缀归因判据单点）。 */
const ENDPOINT_SET_DEFAULT_COMMAND = "embedding.set_default";

/** 端点设默认写面控制器（向量/分类两 tab 同构单点）。 */
export interface DefaultEndpointSetter {
  /** 在途端点 id（null = 无在途；面板不乐观关——等 list 回执对账）。 */
  readonly pendingId: string | null;
  /** daemon 拒绝原因（connection.error 尾缀归因收口；下次发起/回执成功清）。 */
  readonly error: string | null;
  /**
   * 发起设默认：send 返回 false = 未发出（不置在途，调用方 toast 交代）；
   * 发出即置在途——**不乐观关面板**（daemon 三拒无结果帧，乐观关会吞掉输入面）。
   */
  readonly request: (id: string, send: () => unknown) => boolean;
  /**
   * 回执对账（调用方在 embedding.list.result 到达时调）：新默认 = 本 tab 在途
   * id → 收口（清在途/清错误）返回 true（调用方据此关修改口面板）。
   */
  readonly settle: (defaultId: string | null) => boolean;
}

/**
 * 端点设默认写面状态机（向量/分类两 tab 同构单点；评审 Embedding/Classifier
 * ModelsTab:229）：daemon 三拒（不存在/kind 不吻合/未 verify）走 connection.error
 * 而无结果帧——①按「（命令 <type>）」尾缀归因只消费本命令（他命令拒绝不误显示），
 * ②拒绝原因行内交代，③面板收场改结果帧驱动（list 回执新默认才关）。
 */
export function useDefaultEndpointSetter(): DefaultEndpointSetter {
  const { subscribeEmbeddingFrames } = useSession();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 在途 id 镜像（订阅 effect 真挂载一次——listener 读 ref 不进 deps）。 */
  const pendingRef = useRef<string | null>(null);

  useEffect(
    () =>
      subscribeEmbeddingFrames((e: EventEnvelope) => {
        if (e.type !== "connection.error") return;
        if (pendingRef.current === null) return; // 单飞门控：本 tab 无在途不消费
        const message =
          (e.payload as { message?: string } | undefined)?.message ?? "connection.error";
        const cmd = commandOfConnectionError(message);
        // 尾缀归因（族B）：他命令拒绝不归本卡；无尾缀旧 daemon 容忍也交代
        if (cmd !== undefined && cmd !== ENDPOINT_SET_DEFAULT_COMMAND) return;
        pendingRef.current = null;
        setPendingId(null);
        setError(message);
      }),
    [subscribeEmbeddingFrames],
  );

  const request = useCallback((id: string, send: () => unknown): boolean => {
    setError(null);
    if (send() === false) return false;
    pendingRef.current = id;
    setPendingId(id);
    return true;
  }, []);

  const settle = useCallback((defaultId: string | null): boolean => {
    if (pendingRef.current === null || defaultId !== pendingRef.current) return false;
    pendingRef.current = null;
    setPendingId(null);
    setError(null);
    return true;
  }, []);

  return { pendingId, error, request, settle };
}

/**
 * 两段式删除确认（首击 armed → timeoutMs 后复原；同 id 二击执行 action）。
 * armed = 当前 armed 行 id（按钮变确认态的数据源；null = 无 armed）。
 */
// B2：useArmedConfirm 提升至 shared/lib（记忆页跨 slice 复用——AG-15 同层
// 互引防线）；本文件 re-export 保持既有 import 兼容。
export { useArmedConfirm } from "@/shared/lib/useArmedConfirm";
