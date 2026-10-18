---
name: codex-world-state-channel
description: 移植 Codex world state 的两个致命陷阱——载体必须是对话片段（不能进 system prompt）、且必须每轮出现
metadata:
  node_type: memory
  type: project
  modified: 2026-10-17T03:45:00.000Z
---

# Codex world state 移植的两个陷阱（2026-10-17 探索模式实测）

把 Codex 的 world state（时间/联网/产物/上下文余量）搬进来时踩了两个坑，**读代码都看不出来，
只有抓真实请求体 / 真实 key A/B 才现形**。两笔修复：`84e8a45` + `69a26d7`。

## 坑 1：载体必须是"对话片段"，不能是 system prompt

**现象**：环境事实拼进 system prompt，模型**直接无视**。问"今天是几号"，它答"我无法得知今天的
日期"——哪怕日期就写在 system prompt 里。

**实测**（probe-time-channel / probe-time-fullprompt，真实 key）：
- system 末尾追加 / system 开头 / 第二条 system 消息 / developer 角色 → **6 种 system 通道全失败**
- 作为 **user 消息片段**（末条之前 / 末条之后 / 独立一条 / 同条拼接）→ **100% 生效**

**为什么**：长 system prompt 里的环境事实被模型当"背景设定"忽略；user 通道才是模型真正"读进去"
的输入。**Codex 本来就是作为对话片段（developer/user 消息）注入的**——移植时放错载体了。

**修法**：`worldState.injectWorldState(messages, text)` 把事实拼成一条 user 消息附在历史末尾。

## 坑 2：每个 section 每轮都必须出现

**现象**：`diffWorldState` 照搬 Codex 的"没变就不发"，结果第 2 轮起环境事实**全没了**。

**为什么**：Codex 的"没变就不发"成立的前提是片段进**持久历史**（历史会累积，旧片段还在）。
本应用的片段拼在**每轮重建**的请求里、不落盘 → 不发就等于永久丢失。

**修法**：`diffWorldState` 每轮渲染全部 section；差异只用于**节流正文刷新**
（时间同天 / 余量同档时沿用旧正文，保持前缀稳定）。

## 关联的第三个坑：压缩对象

`maybeCompact` 压缩的是渲染端**原始 messages**（无界增长），第 2 次压缩重发**原始全量**
（实测 44531→44619 字符不降反增）。Codex 压缩的是"当前历史"。修法：以 `effective` 为压缩对象。
（`40de905`）

## 一句话教训

**移植别人的机制时，先确认"载体"是否一致**（持久历史 vs 每轮重建、system vs 对话片段）。
载体一变，"没变就不发""拼进提示词"这些语义全反了。声称完成前必须**抓真实请求体**验证——
单测全绿也测不出"模型其实没看进去"。

## 验证方式（可复跑）

- `probe-worldstate-turns`：断言环境事实在 **user 消息**里、两轮都在、不在 system。
- `probe-time-fullprompt` / `probe-time-channel`：6 通道 A/B 对照（真实 key）。
- `probe-agent-realkey`：真实 key 端到端，模型答"2026 年 10 月 17 日，周六"（与系统时钟一致）。
- `probe-compact-source`：二次压缩基于当前历史（带上次摘要前缀、请求体变小）。

关联：[[codex-harness-port]]、[[playground-branch-status]]、[[agent-prompt-engineering-leverage]]
