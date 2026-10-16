# Memory Index

- [MiniMax H3 Workbench 项目](minimax-h3-workbench-project.md) — fork 仓库、自动更新发版流程（tag 即发布）、本机 RTX 5090 D 硬件
- [游乐场分支状态](playground-branch-status.md) — **v0.2.1 已发布；全部已推送，工作区干净**（40 笔提交）；AI 协作资产（CLAUDE.md/记忆/探针）已入库；含换机 vibe coding 的脱敏约定
- [智能体差距在提示词工程](agent-prompt-engineering-leverage.md) — 模型对工具调用的信任远高于文字约定；产物能力必须工具化（create_file 实证）
- [Codex harness 移植](codex-harness-port.md) — 8 笔提交落地：提示词分层/world state 差异注入/计划模式/历史规范化/每轮快照/错误恢复/token 层+暗色主题。含"建了模块≠接线了"的教训
- [MiniMax 支持 Responses API](codex-responses-api-verified.md) — 实测可用、Codex 可直连；但二进制 318MB 故不打包；网关 auth-first，未认证探测会误判
- [中转能力边界](relay-capabilities.md) — 游乐场 LLM 中转的实测能力（无内置联网、搜索端点不存在、连接建立耗时）
- [RB 后端实测](minimax-h3-real-backend-testing.md) — 瞬映 RB 云生成的真实连通性与超时特性
- [安装包体积预算](minimax-h3-size-budget.md) — 评估新依赖时的体积基线
- [RB 后端进行中](rb-backend-wip.md) — RB 适配器的未完成事项
