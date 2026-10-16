---
name: minimax-h3-workbench-project
description: 用户的 MiniMax H3 工作台 fork 仓库位置、自动更新发布流程与硬件环境
metadata:
  node_type: memory
  type: project
  originSessionId: 34b6bc09-4487-4e92-b7be-92cf95558cad
  modified: 2026-10-03T08:06:55.992Z
---

用户 fork 仓库 https://github.com/HeWenbin-bobo/minimax-h3-workbench（原作者 francoeur003），本地在 <root>\repo。2026-10-03 已完成：electron-updater 应用内自动更新、CI tag `v*` 发布 Windows NSIS、自定义 ComfyUI 目录 + 模型就位检查（`comfyuiRoot` 设置 + `models:check` IPC + localModels.ts）、cancel 出队两步修复、Windows 磁盘卷检测修复。

**Why:** 发布链路有三个坑：① fork 仓库 push tag 不触发 CI，需手动 dispatch（Actions → Run workflow → 选 tag）；② electron-builder 只向 **draft** Release 上传资产，published 会被静默跳过（v0.1.8 空资产事故），CI 已改为预建 draft；③ 同 tag 并发上传会产生两个 Release 对象拆散资产，需手工合并（下载补传+删空壳+转正）。

**How to apply:** 发版 = bump version → commit → tag → push → 若无 run 则手动 dispatch tag ref → 构建完成后转正 draft。用户硬件 RTX 5090 D 32GB + 190GB RAM。git 凭据走 GCM 已存好，无需再授权。本机 Electron 冒烟测试因 GPU 栈损坏不可用（git stash 对照证实非代码回归），验证以单测+CI 为准。
