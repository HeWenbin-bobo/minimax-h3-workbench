---
name: agent-prompt-engineering-leverage
description: 智能体差距主要在提示词工程而非框架；模型对工具调用的信任远高于文字约定
metadata:
  node_type: memory
  modified: 2026-10-14T10:10:42.666Z
  type: feedback
  originSessionId: e2d1a939-aefd-47be-bc44-ecb868f1b022
---

用户实测：同一款国产模型接 Claude Code 明显比接我们的智能体聪明——差距不在框架（AI SDK 工具循环与 Claude Code 核心同构），在系统提示词 + 工具描述的打磨。补齐后（5c11ab9：提示词对齐 Claude Code 形态 + create_file 真工具）多步任务表现立刻达标。

**Why:** 模型对工具调用的信任远高于对文字约定的信任——只靠提示词约定"写围栏代码块"时，模型会自我怀疑"我没有文件写入工具"而道歉推脱（实测复现两次）。产物交付类能力必须工具化（create_file），提示词只做行为规范（何时用、何时不问、如何拆步骤）。

**How to apply:** 升级智能体表现时的顺序：① 系统提示词写清角色/工具清单/产物规范/工作方式（参考 Claude Code 的分层结构）；② 每个工具 description 写清触发场景 + 反例（何时不用）；③ 新能力优先做成工具而非提示词约定。验证必须真机跑用户原话，不能用合成指令。

关联：[[minimax-h3-workbench-project]]
