# Memory Index

- [MiniMax H3 Workbench 项目](minimax-h3-workbench-project.md) — fork 仓库、自动更新发版流程（tag 即发布）、本机 RTX 5090 D 硬件
- [游乐场分支状态](playground-branch-status.md) — **v0.3.1 已发布**（`main` = tag `v0.3.1`）；`feature/agent-ask-before-generate` **已推远端、未合并 main**（相对 origin/main 114 笔）；2026-10-22 基线 971 项单测 / E2E test-01…12 共 173/173；含「工具 schema 硬校验打死整轮」的系统化教训
- [环境事实要走对话片段](codex-world-state-channel.md) — **环境事实拼进 system prompt 会被模型无视（实测 6 通道全失败），必须作为 user 片段注入**
- [智能体差距在提示词工程](agent-prompt-engineering-leverage.md) — 模型对工具调用的信任远高于文字约定；产物能力必须工具化（create_file 实证）
- [Codex harness 移植](codex-harness-port.md) — 8 笔提交落地：提示词分层/world state 差异注入/计划模式/历史规范化/每轮快照/错误恢复/token 层+暗色主题。含"建了模块≠接线了"的教训
- [MiniMax 支持 Responses API](codex-responses-api-verified.md) — 实测可用、Codex 可直连；但二进制 318MB 故不打包；网关 auth-first，未认证探测会误判
- [中转能力边界](relay-capabilities.md) — 游乐场 LLM 中转的实测能力（无内置联网、搜索端点不存在、连接建立耗时）
- [RB 后端实测](minimax-h3-real-backend-testing.md) — 瞬映 RB 云生成的真实连通性与超时特性
- [安装包体积预算](minimax-h3-size-budget.md) — 评估新依赖时的体积基线
- [RB 后端进行中](rb-backend-wip.md) — RB 适配器的未完成事项
- [智能体自检自己写的网页](agent-self-check-design.md) — 必须报文件身份 / 采样像素堵白屏假通过 / 同一判定写两处会漏一处（鹈鹕案例真机）
- [「清空」被静默改回默认值](silent-default-overwrite.md) — **`str()` 把空串当"没给"→ 清空静默无效**；同一缺陷在 `ssh.username` / `localComfyUrl` / `rbBaseUrl` / `minimaxBaseUrl` 出现四次；含"哪些字段该允许空"的判断表与变异验证写法
- [探针的覆盖盲区](probe-blind-spots.md) — **自写探针全绿、官方 E2E 却抓到"普通对话漏发 done → 永久卡在生成中"**；含"两条路径都要覆盖"、"内容到了≠这一轮结束了"、用 worktree 基线判定"是不是我引入的"、"变异验证是探针的体检"、切页探针的离开时长必须跨过整轮
- [连点与重入](double-click-and-reentrancy.md) — **`useState` 挡不住同一 tick 的连点，守卫必须用同步 ref**；同一根因已打中 8 个入口（含不可逆的彻底删除）；含"渲染端包装 `window.h3` 不起作用"的假结果与回归护栏 `test-11`
