---
name: relay-capabilities
description: <relay-host> 中转的实测能力边界：46 个模型全无内置联网、搜索端点不存在、可用的免 key 搜索源
metadata:
  node_type: memory
  type: reference
  originSessionId: e2d1a939-aefd-47be-bc44-ecb868f1b022
  modified: 2026-10-13T01:43:39.895Z
---

2026-10-12 用真实 Key 实测中转 `<relay-host>`（游乐场 LLM 的上游）能力边界：

**没有任何模型自带可用的联网搜索**。全部 46 个模型分两类：
- 36 个：带 `tools:[{type:"web_search"}]` 直接 500 `unsupported type "web_search" without a native payload`。
- 10 个（gpt-5.6-terra / gpt-6-sol / gpt-6-astra / gpt-5.6-luna / gpt-5.6-sol / codex-auto-review / gpt-6.1-sol 等，含 `-openai-compact` 变体）：中转不校验该参数（"accepted"），但被问时事时依然自述"无联网。"——**只是参数被静默忽略，并不会真的去搜**。

**中转也没有搜索端点**：`/v1/search`、`/v1/web_search`、`/v1/websearch`、`/v1/tools/search`、`GET /v1/search` 全部 404；`/search` 返回的是前端 HTML 页面。模型列表里无 `search|sonar|perplex` 类模型。

**结论**：要让游乐场联网，只能靠软件自己抓取（已实现：搜索 API → Chromium 渲染 Bing → HTTP 抓 Bing → 渲染/HTTP 抓搜狗）或配第三方搜索 API（博查/Tavily 转接，POST `/search`）。模型自身提供不了。

**免 key 直抓搜索页的可行性**：Bing `https://www.bing.com/search?q=` 与搜狗 `https://www.sogou.com/web?query=` 直连可用、返回可解析结果标记；百度返回反爬标记页、DuckDuckGo(html/lite) 直连超时。

**关键：Bing 对纯 fetch 会返回"降级 SERP"**（2026-10-12 实测，同一 URL 同一查询）：
- `fetch` 直抓 → 查"iPhone 18 Pro 1TB 京东自营 价格"却返回 **Apple 官网/百度百科**等泛化结果（0/6 含京东/1TB）。
- 应用自带 Chromium 渲染同一 URL → **京东商品页**、价格 15499 元（6/6 含京东/1TB）。
- 降级**不可预测**（同一查询时好时坏），且 HTTP 只要"返回非空"就算成功，会让准确的渲染永远轮不到执行——这正是智能体"查不到价格"的根因，已修：免 key 路径改为**渲染优先、HTTP 兜底**。

**「浏览器搜索」可选联网项已落地**（2026-10-12）：游乐场新增「🖥 浏览器搜索」chip（与「🌐 联网」互斥）。语义：只允许应用自带 Chromium 渲染抓取，明确跳过搜索 API 与 HTTP 直抓（`searchWeb` 的 `browserOnly` 标志），失败时直接报错不降级。

**踩过的坑（修了才通）**：`chatAgent(..., enableWebSearch)` 是"本轮允许联网"的总开关，而 `browserOnly` 只改搜索执行方式——两者必须同时传（`webSearch || browserOnly`）。只传后者时 `web_search` 工具不暴露给模型，模型凭旧知识回答"iPhone 18 Pro 尚未发布、无法查价"（UI 实测抓到）。回落分支的 `service.chat` 同样要带 `browserOnly`，否则回落路径丢掉浏览器搜索语义。修复后真机验证：同一查询回答从"未发布"变为"约 ¥15,499（京东自营，银色）"。

**教训**：不要用 bash heredoc 追加含中文/反引号的记忆文件——编码会把内容写坏（本文件曾被写坏后用 Write 工具重写修复）。记忆文件的追加/修改一律用 Write/Edit 工具。

相关：[[minimax-h3-real-backend-testing]]、[[minimax-h3-size-budget]]
