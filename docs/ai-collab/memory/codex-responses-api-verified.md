---
name: codex-responses-api-verified
description: MiniMax 官方 Responses API 实测可用；Codex 可直连无需代理，但打包体积是硬阻碍
metadata:
  node_type: memory
  type: reference
  originSessionId: 1c4638cd-2f4d-42ad-968c-46821651dae4
  modified: 2026-10-15T10:13:13.147Z
---

**实测（2026-10-15）**：MiniMax 官方端点 `https://api.minimaxi.com/v1/responses` **真实可用**——
用本机 key 发真实请求返回 HTTP 200，`output[0].type=message`、`output_text` 正常；
function tools 也支持（`output` 里返回 `function_call`，带 `name`/`arguments`/`call_id`）；
SSE 事件类型与 OpenAI 逐一对齐（`response.created` → `response.output_text.delta` → `response.completed`）。

**注意**：MiniMax 网关是 **auth-first** 而非 routing-first —— 无鉴权时所有 `/v1/*` 路径都返回 401，
**未认证探测无法判断端点是否存在**（曾据此误判为"不存在"）。端点存在性必须用真实 key 验证。

**对 Codex 接入的意义**：`wire_api = "responses"` 可直连，不需要 LiteLLM 之类翻译代理。
但**打包代价值得否决**：Codex 二进制 Windows x64 裸文件 318MB（tar.gz 106MB / zst 78MB），
用其沙箱还要再加 `codex-windows-sandbox-service` 53MB + setup 17MB。本工作台安装包现约 91MB，
CLAUDE.md 已有"浏览器二进制 130–170MB 顶到 250MB+ 故否掉 Playwright"的先例，同一量级。

**Why:** 用户问"Codex 都开源了能不能接进来"。结论是**能接、不该打包**——
真价值在 harness 思路（已移植压缩）与 UI 形态（已抄骨架），不在那个二进制。

关联：[[minimax-h3-workbench-project]]、[[codex-harness-port]]
