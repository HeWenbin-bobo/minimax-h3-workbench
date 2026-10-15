/**
 * 每轮配置快照（移植 OpenAI Codex `core/src/session/step_context.rs` 的 TurnContext 冻结）。
 *
 * Codex 在每轮**进入时**冻结一份上下文（模型、审批策略、sandbox 策略、cwd），之后整轮的
 * 每一步都读这份冻结副本——而不是每次用到时再去读全局配置。
 *
 * 为什么值得移植：本应用的工具回调（generateVideo / createFile / openPage …）跑在一整轮
 * 多步循环里，一轮实测可达 15–25 秒。用户完全可能在这期间改设置（换后端、换模型、改搜索开关）。
 * 若不冻结：
 * - 同一轮里前一个工具按旧配置跑、后一个按新配置跑，产出自相矛盾且无法解释；
 * - 更糟的是**计划模式**：本轮开头摘掉了 generate_video，中途用户一改设置触发
 *   `invalidateLlmSessions()`，若工具表重新求值就可能把副作用工具放回来——
 *   计划模式的保证当场失效。
 *
 * 做法：进轮时快照 + `Object.freeze`（浅冻结即可，字段都是原始类型）。工具回调只读快照。
 */

export interface TurnSnapshot<T> {
  /** 冻结的本轮配置。工具回调只读这个，不读 live 设置。 */
  readonly value: T;
  /** 本轮开始时的时间戳，用于诊断与日志。 */
  readonly startedAt: number;
  /**
   * 该轮是否仍与 live 配置一致。UI 可据此提示"设置已变更，下一轮生效"——
   * 如实告知比让用户困惑于"为什么我改了没生效"要好。
   */
  staleAgainst: (live: T) => boolean;
  /** 与 live 的差异字段名（用于提示文案）。无差异时为空数组。 */
  changedFields: (live: T) => string[];
}

/** 比较两个平铺配置对象的差异字段。值为对象时按引用比较——够用，且不会误报。 */
function diffFields<T extends Record<string, unknown>>(a: T, b: T): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (a[key] !== b[key]) changed.push(key);
  }
  return changed;
}

/**
 * 冻结本轮配置。
 *
 * @param value 进轮时读到的配置。**传新构造的对象**——传一个之后还会被改写的引用，
 *              冻结的就是那个引用，等于没冻结。
 */
export function freezeTurn<T extends Record<string, unknown>>(value: T): TurnSnapshot<T> {
  const frozen = Object.freeze({ ...value });
  return {
    value: frozen,
    startedAt: Date.now(),
    staleAgainst: (live: T) => diffFields(frozen, live).length > 0,
    changedFields: (live: T) => diffFields(frozen, live)
  };
}

/**
 * 早退路径的兜底：确保用户消息一定被处理，不会因某个分支提前 return 而静默丢弃。
 *
 * Codex 的对应物是 `run_turn` 的 `must_deliver` 语义——一轮要么产出回答，要么明确报错，
 * 不存在"什么都没有"。
 *
 * 用法：早退分支包进 `guaranteeDelivery`，回调返回"是否已交付"；返回 false 时补一条可见说明。
 */
export function guaranteeDelivery(
  delivered: () => boolean,
  deliver: (message: string) => void,
  fallbackMessage: string
): void {
  if (delivered()) return;
  deliver(fallbackMessage);
}
