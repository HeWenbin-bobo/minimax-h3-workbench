---
name: minimax-h3-workbench-project
description: 用户的 MiniMax H3 工作台 fork 仓库位置、自动更新发布流程与硬件环境
metadata:
  node_type: memory
  type: project
  originSessionId: 34b6bc09-4487-4e92-b7be-92cf95558cad
  modified: 2026-10-16T18:29:35.016Z
---

用户 fork 仓库 https://github.com/HeWenbin-bobo/minimax-h3-workbench（原作者 francoeur003），本地在 `<root>\repo`。2026-10-03 已完成：electron-updater 应用内自动更新、CI tag `v*` 发布 Windows NSIS、自定义 ComfyUI 目录 + 模型就位检查（`comfyuiRoot` 设置 + `models:check` IPC + localModels.ts）、cancel 出队两步修复、Windows 磁盘卷检测修复。

**⚠️ 仓库是 public（公开）**：任何提交全世界可见。本机路径、中转域名、内部地址不要写进代码/注释/文档；
密钥永远只在本机 Electron userData（safeStorage 加密）。2026-10-17 已因此把源码注释里的中转域名脱敏
（且注意：**已进过公开历史的内容无法靠新提交抹除**，`git log -p` 仍可查，彻底清除需 force push 改写历史）。

**Why:** 发布链路的坑（截至 v0.2.1 共 5 个）：① fork 仓库 push tag 不触发 CI，需手动 dispatch
（本机没装 gh，用 GitHub API + GCM token，token 带 `workflow` scope）；② electron-builder 只向
**draft** Release 上传资产，published 会被静默跳过（v0.1.8 空资产事故），CI 已改为预建 draft；
③ 同 tag 并发上传会产生两个 Release 对象拆散资产，需手工合并；④ 发布说明要自己写中文正文，
别用 CI 默认的"自动构建发布"；⑤ **CI 跑 Linux、本机是 Windows——本地全绿不代表 CI 会绿**，
v0.2.1 首次 dispatch 就因 `safePath.test.ts` 的跨平台问题（靠链接名结尾猜链接类型）直接红。

**How to apply:** 发版 = bump version → commit → tag（annotated）→ push → 手动 dispatch tag ref →
先看 `test` job 绿没绿 → 等构建完 → draft 转正 + 写中文 release notes → 核对 `releases/latest`
含 `latest.yml` + setup exe + blockmap。跨平台测试改动先在 WSL 上验（本机有 WSL Ubuntu + node 24，
与 CI 同版本；Windows 的 node_modules 在 Linux 跑不了，写纯 node 脚本对照）。
用户硬件 RTX 5090 D 32GB + 190GB RAM。git 凭据走 GCM 已存好，无需再授权。
本机 Electron 冒烟测试因 GPU 栈损坏不可用（git stash 对照证实非代码回归），验证以单测+typecheck+build+E2E 探针为准。
