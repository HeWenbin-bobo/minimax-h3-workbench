# Memory Index

- [MiniMax H3 Workbench 项目](minimax-h3-workbench-project.md) — fork 仓库、自动更新发版流程（tag 即发布）、本机 RTX 5090 D 硬件
- [GitHub 凭据已登录](github-credentials-saved.md) — 用户已通过 GCM 登录 GitHub，git 推送/发布无需再请求授权
- [游乐场分支状态](playground-branch-status.md) — feature/agent-iteration 30 笔提交未推送未合并；产物系统 + 智能体 harness（提示词分层/world state/计划模式/压缩）全绿
- [智能体差距在提示词工程](agent-prompt-engineering-leverage.md) — 模型对工具调用的信任远高于文字约定；产物能力必须工具化（create_file 实证）
- [Codex harness 移植](codex-harness-port.md) — 8 笔提交落地：提示词分层/world state 差异注入/计划模式/历史规范化/每轮快照/错误恢复/token 层+暗色主题。含"建了模块≠接线了"的教训
- [MiniMax 支持 Responses API](codex-responses-api-verified.md) — 实测可用、Codex 可直连；但二进制 318MB 故不打包；网关 auth-first，未认证探测会误判
