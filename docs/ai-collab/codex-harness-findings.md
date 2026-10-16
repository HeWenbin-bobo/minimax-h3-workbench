# Codex harness 源码考古结论（不入库，仅供实现参考）

来源：`github.com/openai/codex@main`（Apache-2.0）。下载副本在本目录 `*.rs` / `tpl-*.md`。

## 一句话结论

Codex 的压缩不是一条路径，是三条（本地模型摘要 / 服务端远程摘要 v2 / token-budget 直接换窗），
三者共用同一套骨架：**替换历史 + 保留策略 + 窗口记账**。我们要移植的是这套骨架，
不是三条路径——我们只有一个后端，走本地模型摘要。

## 1. 触发（context_window.rs:96-117）

```rust
let full_context_window_limit = resolved_context_window * effective_context_window_percent / 100;  // 默认 95%
let buffered_auto_compact_limit = auto_compact_scope_limit + fallback_buffer_tokens;
let token_limit_reached = scope_tokens >= buffered_auto_compact_limit || active >= full_limit;
```

- 自动压缩限额默认 `context_window * 9 / 10`（90%），openai_models.rs:529-540
- 另有 4 个非 token 触发源：comp hash 变化、模型降配、上游直接报 `ContextWindowExceeded`、显式请求

## 2. 计入量双模式（config_types.rs:49-55）

```rust
pub enum AutoCompactTokenLimitScope {
    #[default] Total,          // 整段活动上下文都算
    BodyAfterPrefix,           // 只算基线之后的增量
}
```

**我们实现成了按窗口自动切换**：首个窗口用 Total（否则"从未压缩过 + 历史已超窗"永不触发，
实测探针抓到的就是这个 bug），压缩过的窗口用 BodyAfterPrefix（避免压完立刻又压）。

## 3. 窗口记账（auto_compact_window.rs）

- `prefill_input_tokens`：当前窗口的输入基线。**首个服务端 usage 锁定后，估算不得覆盖**（同名单测断言）
- `advance()`：窗口号 +1，**不清 prefill**（等下一个服务端样本覆盖）
- 我们简化：显式清空基线，下一轮由估算/usage 立即重建（我们没有消息复用的保底路径）

## 4. 保留策略（compact.rs:715-819）

```rust
const COMPACT_USER_MESSAGE_MAX_TOKENS: usize = 20_000;
for message in user_messages.iter().rev() {      // 反向：优先保最近
    if remaining == 0 { break; }
    let tokens = approx_token_count(&message.message);
    let preserve_content = tokens <= remaining && content.iter().all(|p| matches!(p, InputText { .. }));
    // 预算够 → 整条保留；不够 → 只留文本 + 标注（图片/音频丢弃）
}
history.push(CompactionSummary::new(summary_text));   // 摘要置末，role = "user"
```

- 摘要 role 是 `user`，markers 为空 → **不做任何包裹**（fragment.rs:90-98）
- 既有摘要消息被排除，避免"摘要套摘要"（`is_summary_message` 按前缀判定）

## 5. 两段提示词（逐字移植，见 compaction.ts）

- `SUMMARIZATION_PROMPT`：8 行，`templates/compact/prompt.md`
- `SUMMARY_PREFIX`：`templates/compact/summary_prefix.md`

埋给摘要模型的是一条普通 user 消息；**没有结构化输出 schema**（`output_schema: None`），
结果按普通 assistant 文本消费（`get_last_assistant_message_from_turn`）。

## 6. 失败与回退

- 上游报超窗时**从最老往前丢一项**再重试（`history.remove_first_item`，同时移除配对的 call/output）
- 摘要为空 → `"(no summary available)"` 占位，不崩（compact.rs:808-816）
- PostTurn 压缩失败**不毁掉已完成的回答**（`warn!("Post-turn compaction failed; preserving the completed turn")`）
- 每个模型步最多重试一次，防止无效压缩无限循环（`guardian_budget_compacted`）

## 7. 我们没有移植的部分（以及为什么）

| Codex 机制 | 不移植的理由 |
|---|---|
| 服务端远程摘要 v2（加密 blob） | 上游没有这个能力 |
| token-budget 直接换窗（无摘要） | 丢证据，对"用户要的文件/参数"场景风险高 |
| world state / goal 保留 | 我们没有 goal 与结构化 world state |
| `RetainClientToolOutputs` | 我们的工具输出不进历史（在渲染端） |
| 本地 tokenizer 精确截断 | 引入 tokenizer 依赖不划算，按字符比例截断够用 |
| `fallback_buffer_tokens` | 我们没有 fallback prompt 机制，留参数位 |
