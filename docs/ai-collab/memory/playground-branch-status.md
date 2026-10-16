---
name: playground-branch-status
description: v0.2.1 已发布（main 已合并推送，Release 走 workflow_dispatch）；feature/agent-iteration 与 main 同步，继续做 Codex 融入
metadata:
  node_type: memory
  type: project
  originSessionId: c43a4719-8f9f-4185-b161-9cd51af6a1ae
  modified: 2026-10-16T16:10:11.755Z
---

**状态（2026-10-17）：v0.2.1 已发布。** `feature/agent-iteration` 已 push、fast-forward 合并进 `main` 并推送；tag `v0.2.1` 指向 `72c37b8`（修复后）。分支与 main 已同步，继续在同一分支做 Codex 融入。

## v0.2.1 发布过程中的两个坑（都已解决，值得记住）

1. **fork 仓库 push tag 不触发 CI**（项目记忆记的坑 #1 再次应验）：`git push origin v0.2.1`
   之后 Actions 里 **0 个 run**（API 查 `event=push` 确认）。必须手动 dispatch：
   ```bash
   TOK=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
   curl -X POST -H "Authorization: Bearer $TOK" -H "Accept: application/vnd.github+json" \
     https://api.github.com/repos/HeWenbin-bobo/minimax-h3-workbench/actions/workflows/build.yml/dispatches \
     -d '{"ref":"v0.2.1"}'
   ```
   本机**没装 gh**，但 GCM 里的 token 带 `workflow` scope，可直接用 API（token 绝不打印）。
2. **首次 dispatch 失败于 `npm test`（仅 Linux）**：`safePath.test.ts` 的"指向根内的链接放行"
   在 ubuntu 上挂。根因是**测试助手靠 `linkPath.endsWith(".html")` 猜链接类型**——
   链接名不含 .html → 误判为目录链接 → 把文件名拼到文件软链后面 → realpath 失败。
   Windows 走 junction 分支掩盖了它。**修法**：显式返回 `{ link, isDirLink }`。
   验证手段：本机有 **WSL Ubuntu + node 24**，与 CI 环境一致；Windows 的 node_modules
   在 Linux 跑不了原生绑定，故用 `_scratch/verify-link-linux.mjs`（纯 node，不依赖 vitest）
   在 Linux 上复现并对照修复前后。**以后跨平台测试改动都该这样验。**
   tag 因此重指到修复提交（该 tag 当时未产生任何 Release，故安全）。

## 提交分组（v0.2.0 → v0.2.1）

1. 智能体迭代：工具实时可见 / 四项迭代 / open_page + 重试退避（b38b315–7c0032c）
2. markdown 表格渲染（57dbea4）
3. 产物预览 v1→v2：文件卡片 + 懒落盘 `artifact:save` IPC + WorkBuddy 形态（475126d–fe580ae）
4. 联网+浏览器搜索默认开启、取消互斥（fc040d3）
5. 预览面板布局四连修 + `probe-preview.mjs`（5c0f6e7–1bd37d2）
6. 空对话清理 + 分栏压缩 + 拖拽 + 保底 30px（dd2fe8a–9f1a9f7）
7. 工具步骤可折叠（4a3f949）
8. **智能体升级三部曲**：自我认知（895d61c）→ 提示词工程+create_file 工具（5c11ab9）→ create_file 落盘名/围栏别名修复（d9eaea1）
9. 其他修复：test-06 语义适配（c9fa39a）、预览自动聚焦修键盘游戏（4f6fced）、Excel/Word 产物预览（7afdd4a）
10. **Codex harness 移植 8 笔**（a7d123b–65b4c9d）：上下文压缩 / 提示词分层 / world state 差异注入 / 计划模式 / 工具描述规范 + update_plan + request_user_input / 历史规范化 / 每轮配置快照 / 错误恢复三条 / 设计 token 层 + 暗色主题 + 界面骨架
11. **修复四笔**（8e0ff60–ebfff67）：预览游戏不能玩（srcdoc 继承宿主 CSP）/ 安全审查两条（CSP 改响应头 + realpath）/ 3D 页面被做成视频（产出物优先级）/ 大文件截断（未设 maxOutputTokens）+ 内容回灌正文
12. 发版：`2ea8b38` bump 0.2.1 → `72c37b8` 修 Linux 测试

## 本会话核心认知（已写入 CLAUDE.md）

- **差距在提示词工程不在框架**：同款模型接 Claude Code/Codex 更聪明，是 harness 差距
- **模型信任工具远超文字约定**：产物交付必须工具化（create_file），提示词只做行为规范
- **UI/焦点类修复必须实测**：CDP Input.dispatchKeyEvent 绕焦点路由（要用 OS 级 WScript.Shell 键盘）；改 UI 用 E2E 探针不读代码
- **探针结果一字不差 = 旧构建**（先 build 再跑）
- **"建了模块"≠"接线了"**：声称完成前用 `grep -r <符号> src/ | grep -v 测试` 确认有生产读取方。第一轮移植漏了三处（零调用方的 guaranteeDelivery、只读一个字段的 freezeTurn、没抄的 plan.md 三段）
- **"探针 PASS" 也可能是假绿**：模型没跑起来时"没建视频"同样 PASS。判据要先确认"前置条件真的发生了"
- **根因要读代码也要实测**：`max_tokens` 未设、srcdoc 继承 CSP、`create_file` 回灌内容——三处都是"读代码看不出、实测才现形"
- **跨平台测试改动必须在 Linux 上验**（WSL 可用，见上）

## 待办

- 继续在当前分支融入 Codex 内容（用户 2026-10-17 指令）
- `checkAgentFrameworkUpdate` 渲染端仍零调用
- ~~push + 合并 main + 发 0.2.1~~ **已完成**（2026-10-17）
- ~~用户 Codex 对比测试~~ **已取消**（用户 2026-10-16："这个不对比了"）——不要再提

关联：[[agent-prompt-engineering-leverage]]、[[minimax-h3-workbench-project]]、[[codex-harness-port]]
