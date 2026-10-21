---
name: codex-harness-port
description: 把 OpenAI Codex 的 harness 架构移植进 MiniMax H3 游乐场（7 个模块 + 界面骨架）
metadata:
  node_type: memory
  type: project
  originSessionId: 1c4638cd-2f4d-42ad-968c-46821651dae4
  modified: 2026-10-16T02:03:21.470Z
---

# Codex harness 移植（feature/agent-iteration，8 笔提交）

用户要求"codex 的 harness 架构全部抄过来，界面也融合到游乐场里"。三个前置决定：
抄**可落地**的（不建不适用模块的空壳）、界面保留品牌色 + 补暗色主题、`request_user_input` 要做。

**对比测试已取消**（用户 2026-10-16 明确："这个不对比了"）——不要再提这件事。

## 落地清单

| 模块 | 落点 | 提交 |
|---|---|---|
| 提示词分层（context fragment） | `src/shared/agentPrompt.ts` | `93ad965` |
| world state 差异注入 | `src/main/modules/worldState.ts` | `93ad965` / `65b4c9d` |
| 计划模式（含 plan.md 三段 + 方案块契约） | `src/shared/planMode.ts` + `App.tsx` + `markdown.tsx` | `93ad965` / `28545fe` |
| 工具描述规范 + `update_plan` / `request_user_input` | `llmService.ts` + `questionBridge.ts` | `2aa299a` |
| 历史规范化 | `src/main/modules/historyNormalize.ts` | `521f28b` |
| 每轮配置冻结（TurnContext） | `src/main/modules/stepSnapshot.ts` | `521f28b` / `28545fe` |
| 上游错误恢复三条 | `src/main/modules/errorRecovery.ts` | `521f28b` |
| token 层 + 暗色主题 + 骨架 | `styles.css` + `src/renderer/theme.ts` | `156d15b` |

前置已有：`contextBudget.ts`（AutoCompactWindow）、`compaction.ts`（摘要提示词 + 保留策略）。

## 明确不移植（及理由）

guardian 审批流 / sandbox / worktree —— 前提是本应用 agent 能跑 shell、写文件、执行本地代码，
三件都没有，其风险分类无一命中。turn 多阶段流水线 —— AI SDK `streamText` + `stopWhen` 已内建。
merge-patch 持久化 —— 不写 rollout，基线放内存即可。本地 tokenizer —— 字符比例估算够用。

**历史规范化只做了真正适用的部分**：Codex 的"每个 function_call 必有配对 output"在本宿主
**没有对应面**（AI SDK 的工具调用在 streamText 步循环内部，从不落进我们发出去的历史），
硬造只会是永不触发的死代码。实际做的是：剥不支持多模态的模型收到的图片、丢空 content 残留、
修非法的首条 assistant。

## 踩到的坑（都已写进代码注释）

1. **"建了模块"不等于"接线了"**。第一轮我声称抄完，实测发现三处断线：`guaranteeDelivery`
   零生产调用方、`freezeTurn` 只读了 `.value.model`、plan.md 三段完全没抄。
   **教训：声称完成前，用 `grep -r <符号> src/ | grep -v 测试` 确认有生产读取方。**
2. **`freezeTurn` 最初防错了对象**。以为要防"settings 被就地改写"——实测不成立
   （`settingsStore.get()` 每次从磁盘重建新对象）。真正会漂移的是**轮中途才去读的值**：
   搜索回调原先在工具执行那一刻才 `getSecret`，用户中途换 Key 会让同一轮用两个 Key。
   现在进轮时一次性冻结配置 + 密钥，agent 分支全部读快照。
3. **`shouldReinject: () => false` 是错的**（我引入的真 bug）。它让时间**永不重注入**，
   会话跨夜后模型一直拿昨天的日期，而提示词还说"时效问题以此为准"——比不给时间更糟。
   Codex `time_reminder.rs` 是按阈值重注入。改为跨天必重注入、同天内节流。
4. **提示词契约必须配套渲染器**。让模型输出 `<proposed_plan>` 却不改 `markdown.tsx`，
   尖括号会作为字面文本糊在气泡里。两块代码要一起改、一起测。
5. **`request_user_input` 必须有超时，且超时必须 reject 而非 resolve 空值**。没有超时的话
   用户关窗走开会让该会话的取消器永久占着，那条会话再也发不出消息。
6. **`llm:abort` 必须先 `questionBridge.cancelSession()`**，否则工具循环还在等回答，取消器摘不掉。
7. **硬编码色是主题的敌人**：`#b8155a` 在浅底过 AA、在深底只有 2.71:1。主题相关颜色必须走
   语义 token（如 `--brand-ink`）。系统跟随块（`prefers-color-scheme`）也要给全部 token。
8. **品牌渐变白字只有 3.64:1**（既有问题，探针实测）。用户确认调深色标至 4.71:1。
9. **探针里 `location.reload()` 会换掉 CDP 执行上下文**，之后所有 evaluate 静默打不到新文档，
   探针挂死只能 taskkill。改用外层 `Page.navigate` + 轮询等元素出现。
10. **`querySelector(".pg-bubble")` 命中的是第一个气泡（用户那条）**，选器要精确到
    `.pg-msg.assistant .pg-bubble`。**渐变背景的 `backgroundColor` 是透明的**，对比度探针
    要读 `background-image` 取色标。
11. **React setState 要等下一帧**：点击后同 tick 读 `className` 必然还是旧值，探针要等一拍。
12. **「建了模块 ≠ 接线了」在错误恢复上又中了一次（2026-10-22）**。
    `errorRecovery.retryDelayMs` / `parseRetryAfter`（对齐 Codex `responses_retry.rs`）
    早就写好并带单测，但**两条重试路径的判据都不放行**：普通对话与智能体原先都只判
    `isNetworkError`，于是上游明确回 `429 + retry-after: 2` 时一次都不等就失败——
    明明等两秒就能成功。判据不放行，退避函数再正确也永远不会被调用。
    **教训：接入"重试/退避/降级"这类策略时，先确认"什么情况下会走到这里"的判据，而不只是实现动作本身。**
13. **AI SDK 的重试用尽后抛的是 `AI_RetryError`，它自己不带状态码**（直连 SDK 复现）。
    形状：`name=AI_RetryError, statusCode=undefined, lastError={ name:"AI_APICallError",
    statusCode:429, responseHeaders:{ "retry-after":"2" } }`。
    只在顶层找 `status`/`statusCode`/`responseHeaders` 会全部拿到 undefined，
    于是"429 该重试"这个判断**永远不成立**、`parseRetryAfter` 也永远读不到冷却时长。
    修法：`shared/errors.ts` 的 `httpStatusOf` / `retryAfterHeaderOf` 统一下钻
    `lastError` → `errors[]` 末项（带自引用保护）。
    **教训：判定"这个异常是什么"的代码，必须先在真实 SDK 上打印一次形状，不要凭 `instanceof` 或字段名猜。**
14. **同一个"值得重试"判据，两条路径的口径可以不同**。普通对话放行 429 + 5xx，
    智能体只放行 429：因为智能体的 SDK 已设 `maxRetries: 1`，5xx 在 SDK 层就重试过一次，
    整轮再重试 3 次 × 3 秒退避会把"服务端 500"拖到十几秒才报错（E2E test-02 实测
    从 6 秒等到 12 秒仍未收尾）。429 不同——它有冷却窗口，SDK 的瞬时重试注定撞在窗口里。
    **教训：别把"看起来同类"的判据无差别共享；先看每条路径上游已经做过什么。**

## 验证方式

- 三件套：`npm test`（222 项）→ `npm run typecheck` → `npm run build`。
- 界面/链路改动**跑探针不靠肉眼**（改完必须先 `npm run build`，探针载 dist 产物）：
  - `_scratch/probes/probe-codex-ui.mjs`：浅/深两主题截图 + 机器测 11 个元素对比度，
    WCAG AA 4.5:1 硬门槛。它抓出 6 项真实不达标。
  - `_scratch/probes/probe-plan-mode.mjs`：10/10。含"提示词契约 → 渲染器 .md-plan → 按钮亮起"完整链路。
  - `_scratch/probes/probe-user-input.mjs`：8/8。含工具挂起 → 弹卡 → 点选 → 答案回填进历史。
  - `.e2e/probe-preview.mjs`：22/22，确认 CSS 改动没破坏分栏几何。
