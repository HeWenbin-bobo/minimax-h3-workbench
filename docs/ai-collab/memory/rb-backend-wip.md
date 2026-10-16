---
name: rb-backend-wip
description: feature/playground 已修复游乐场无回复/RB提取态/工作台视图分离（1947ee8）；待用户实测后合并 0.2.0
metadata:
  node_type: memory
  type: feature
  originSessionId: c43a4719-8f9f-4185-b161-9cd51af6a1ae
  modified: 2026-10-10T05:58:56.738Z
---

**feature/playground 最新提交 1947ee8（2026-10-10），待用户实测后合并 main → 0.2.0。**

## 最近修复（用户 2026-10-10 报的三个问题）

1. 游乐场"发消息没回复"真根因：**竞态**——首个 SSE chunk 常在 React 提交
   "新增会话+user+assistant"之前到达，patchLast 落空致内容只留在 streamBuffer，
   onLlmDone 又用空 content 覆盖落库。修法：收尾取缓冲区与消息内容的较长者写回。
2. RB"提取失败"：轮询只认 succeeded/failed，生成后的提取阶段被当未知态轮询到超时。
   已补 extracting/decoding/processing + fail/error 模糊匹配 + /video 失败回落 video_url。
3. 工作台新建/已有视图分离：新增「＋ 新建任务」tab；新建态只显示 request.count 个占位格，
   点项目 tab 只显示该项目任务（格子数=任务数）。
4. 安全审查整改：RB 结果下载的远端 video_url 加 assertSafeResultUrl（公网 HTTPS + 拒绝
   回环/私网/链路本地/组播 + redirect:"manual"）。**已知上限**：未做 DNS 解析校验，
   域名指向内网仍可能绕过。

## 关键经验

- AI SDK v7：steps 是 PromiseLike<Array>（await 后遍历）；默认 maxRetries=2 需置 0；
  timeout {chunkMs,totalMs} 可防服务商卡死转圈
- E2E 跑 dist/ 产物——改渲染端必须先 npm run build 再跑测试
- Electron renderer 禁用 window.prompt/confirm；custom protocol 状态码用 video 元素探测
- RB 官网 bundle 是 API 响应格式真相来源（{job:{id}} 包装）；providerTaskId 早回传防云扣费

## 待办

- 用户实测三项修复 → 合并 main → 0.2.0 发版
- RB 动态预设（GET /api/portal/presets）低优先级
