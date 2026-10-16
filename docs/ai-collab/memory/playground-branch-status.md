---
name: playground-branch-status
description: v0.2.1 已发布；AI 协作资产（CLAUDE.md/记忆/探针）已入库推送；分支与 main 完全同步
metadata:
  node_type: memory
  type: project
  originSessionId: c43a4719-8f9f-4185-b161-9cd51af6a1ae
  modified: 2026-10-16T18:27:38.891Z
---

**状态（2026-10-17）：全部已推送，工作区干净，`feature/agent-iteration` 与 `main` / `origin/main` 零差异。**

- `v0.2.1` 已发布（Release 含 latest.yml + setup exe + blockmap 三件套）。
- 分支共 **40 笔提交**（`v0.2.0..HEAD` 实测）；v0.2.1 之后又有 **4 笔**。
- HEAD = `1aa607c`。
- **工作区干净，无未推送提交**——下次开工直接从 main 拉最新即可。

## v0.2.1 之后的 4 笔（v0.2.1..HEAD）

1. `72c37b8` 修 safePath 测试在 Linux 上失败（CI 红）
2. `2545f0c` 融入 Codex「剩余上下文余量」注入
3. `14ab5df` 修 dk- 系列模型窗口估大（128k→64k）
4. `a4b0b27` 入库 AI 协作资产（CLAUDE.md + 记忆 + 探针）
5. `1aa607c` 源码注释里的中转域名脱敏

## AI 协作资产已入库（换机 vibe coding 用）

仓库里现在有（**都是公开的**，推送前已脱敏）：

| 路径 | 内容 |
|---|---|
| `CLAUDE.md` | 项目规则真源（架构/命令/约定/发版/安全红线/教训） |
| `docs/ai-collab/README.md` | 这批资产的说明 + 换机起步步骤 |
| `docs/ai-collab/AGENTS-reference.md` | 另一项目（DSA 股票分析）的规则，仅供参考 |
| `docs/ai-collab/codex-harness-findings.md` | Codex harness 考古结论 |
| `docs/ai-collab/memory/*.md` | 本记忆文件的快照（10 个） |
| `tools/harness.mjs` + `tools/probes/*` | E2E 取证探针（45 个） |

**换机后**：`git clone` → `npm ci` → `npm run build`（探针加载 dist 产物）→ 让 AI 读 `CLAUDE.md`。

**脱敏约定**（仓库公开，以后写代码/注释都要守）：
- 本机绝对路径 → `<root>` / `<repo>`
- 中转地址 → `<relay-host>`（**不要**在注释里写真实中转域名——已因此返工一次）
- 密钥永不入库：只在本机 Electron userData（safeStorage）

## 重要：仓库是 public，且历史无法完全抹除

`<relay-host>` 曾随 `13d97cd` / `14ab5df` 进入公开历史；`1aa607c` 只清了**当前源码**，
`git log -p` 仍可查到旧提交。要彻底抹除需改写已公开历史 + force push（会重写 30+ 提交哈希、
已发布 tag 也要动），**风险高，用户尚未要求**。

## 本会话核心认知（已写入 CLAUDE.md）

- **差距在提示词工程不在框架**：同款模型接 Claude Code/Codex 更聪明，是 harness 差距
- **模型信任工具远超文字约定**：产物交付必须工具化（create_file），提示词只做行为规范
- **UI/焦点类修复必须实测**：CDP Input.dispatchKeyEvent 绕焦点路由（要用 OS 级 WScript.Shell 键盘）；改 UI 用 E2E 探针不读代码
- **探针结果一字不差 = 旧构建**（先 build 再跑）
- **"建了模块"≠"接线了"**：声称完成前用 `grep -r <符号> src/ | grep -v 测试` 确认有生产读取方
- **"探针 PASS" 也可能是假绿**：模型没跑起来时"没建视频"同样 PASS。判据要先确认"前置条件真的发生了"
- **根因要读代码也要实测**：`max_tokens` 未设、srcdoc 继承 CSP、`create_file` 回灌内容——都是"读代码看不出、实测才现形"
- **跨平台测试改动必须在 Linux 上验**（本机有 WSL Ubuntu + node 24，与 CI 同版本）
- **公开仓库的注释不要写本机环境信息**（中转域名/绝对路径），一次就够

## 待办

- **等指令**：用户未指派新任务。Codex 融入已做到「没有对应面的部分不再硬抄」
- `checkAgentFrameworkUpdate` 渲染端仍零调用
- ~~push + 合并 main + 发 0.2.1~~ **已完成**
- ~~用户 Codex 对比测试~~ **已取消**（2026-10-16）——不要再提

关联：[[agent-prompt-engineering-leverage]]、[[minimax-h3-workbench-project]]、[[codex-harness-port]]
