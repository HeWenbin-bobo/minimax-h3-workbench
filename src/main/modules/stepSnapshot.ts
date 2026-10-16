/**
 * 每轮配置快照（移植 OpenAI Codex `core/src/session/step_context.rs` 的 TurnContext 冻结）。
 *
 * Codex 在每轮**进入时**冻结一份上下文（模型、审批策略、sandbox 策略、cwd），之后整轮的
 * 每一步都读这份冻结副本，而不是每次用到时再去读全局配置。
 *
 * 本应用的对应风险**不是**"settings 对象被就地改写"——`settingsStore.get()` 每次都从磁盘
 * 重建新对象，且在轮开始时只读一次、由闭包持有，这个不变量本来就成立。真正的漂移点是
 * **轮中途才去读的值**：搜索 API Key 原先在工具执行那一刻才 `getSecret()`，用户中途改 Key
 * 会让同一轮里前后两个工具用两个 Key；同理模型名、默认后端若读两次也会不一致。
 *
 * 所以这里冻结的是"这一轮用到的全部配置 + 中途本会去读的密钥"，工具回调只读快照。
 *
 * 与 Codex 的差异：它的 TurnContext 还冻结审批策略与 sandbox 策略——本应用没有这两样
 * （工具无破坏性、不跑本地代码），故不建空壳。
 */

export interface TurnSnapshot<T> {
  /** 冻结的本轮配置。工具回调只读这个，不读 live 设置。 */
  readonly value: T;
}

/**
 * 冻结本轮配置。
 *
 * @param value 进轮时读到的配置。**传新构造的对象**——传一个之后还会被改写的引用，
 *              冻结的就是那个引用，等于没冻结。嵌套对象不会被深冻结，故调用方
 *              必须保证不再改写它（现有代码从不改写 settings，安全）。
 */
export function freezeTurn<T extends Record<string, unknown>>(value: T): TurnSnapshot<T> {
  return { value: Object.freeze({ ...value }) };
}
