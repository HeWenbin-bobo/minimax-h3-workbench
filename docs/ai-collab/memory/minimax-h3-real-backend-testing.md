---
name: minimax-h3-real-backend-testing
description: MiniMax H3 工作台真机测试手法与云后端真实状态词表（RB/MiniMax 状态值、网络抖动实测）
metadata:
  node_type: memory
  type: project
  originSessionId: e2d1a939-aefd-47be-bc44-ecb868f1b022
  modified: 2026-10-12T03:58:47.799Z
---

2026-10-12 用真实 Key 对 MiniMax H3 工作台做了全功能实测，结论与可复用手法：

**真机测试手法**：`<root>\_scratch\harness.mjs` 克隆 `%APPDATA%\minimax-h3-workbench`（settings.json + secrets.json + Local State 三件套，缺 Local State 会导致 safeStorage 解密失败）到临时目录，用 `H3_USER_DATA` 启动，可读到真实 Key 且不污染用户数据。密钥只在进程内解密，绝不落盘/打印。

**云后端真实协议（实测，非文档推断）**：
- 瞬映 RB `/api/v1/jobs/{id}` 真实成功态是 `status: "done"` + `progress: "已完成"`，**不是** `succeeded`（旧代码只认 succeeded → 任务卡 92%、成片永不下载、卡密已扣）。已修复（isDone 含 done/success/completed）。
- rb.coolhs.com 在 Electron/undici 下极不稳定：25 次请求约 2 次 `UND_ERR_CONNECT_TIMEOUT`（10s 连接超时），**瞬时失败后紧接着重试几乎必然成功**。轮询里一次抖动就抛错 = 假失败。已修复（wait() 容忍连续 5 次抖动）。
- MiniMax 官方文档成功态是 `Success`（首字母大写）。本机无 Key 未能真机验证，已放宽匹配并注明。

**游乐场 LLM 中转（<relay-host> / glm-5.3-flash）**：连接建立约 3.5–8s，首个内容 chunk 后还有固定约 15s 空档才收到 `finish_reason`（上游行为，非客户端 bug），所以智能体模式一轮 20–40s 属正常。

**AI SDK 陷阱**：`streamText` 失败时抛的 `AI_NoOutputGeneratedError`（cause 为 null）会把真实原因藏起来，必须用 `onError` 回调捕获；且默认 `maxRetries: 0` 会让中转偶发 reset 把整轮打挂并触发误导性的"模型不支持工具"回落。已修复：maxRetries:1 + onError 透出底层错误 + describeError 翻译包裹层文案。

**游乐场多会话并发（2026-10-12 新增）**：`llm:chat` 现在带 `sessionId`（渲染端 `crypto.randomUUID()` 生成）；主进程 `sessionServices`/`sessionAborters` 两个 Map 按会话隔离，事件 `llm:chunk/done/tasks` 回带 `sessionId` 由渲染端路由。会话列表按 `updatedAt`（最近使用）倒序 + `.running` 标识（粉点+左竖条+高亮"正在回复…"）。守卫只挡"同一会话"并发；`abortLlm(sessionId)` 单会话中止不连坐；会话上限裁剪保护生成中的会话。E2E 守护在 `.e2e/test-08-playground-concurrency.mjs`（16 断言）。**Mock LLM 教训：Node http 的 `req` close 在请求体读完即触发，会误杀流式定时器，清理必须挂 `res` close。**

相关：[[playground-branch-status]]、[[rb-backend-wip]]
