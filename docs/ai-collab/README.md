# AI 协作资产（换机继续 vibe coding 用）

这个目录放的是**给 AI 看的项目知识**，不是产品代码。目的是换一台电脑 `git clone` 之后，
AI 助手能立刻读到项目规则、架构、踩过的坑，不用从头问一遍。

## 目录里有什么

| 路径 | 是什么 | 谁该看 |
|---|---|---|
| `../../CLAUDE.md` | **项目规则真源**：架构、命令、约定、发版流程、安全红线、历史教训 | 每次开工前 AI 必读 |
| `AGENTS-reference.md` | 另一个项目（DSA 股票分析系统）的规则文件，**仅供参考，不要照搬** | 想借鉴写法时看 |
| `codex-harness-findings.md` | 移植 OpenAI Codex harness 的考古结论（哪些抄了、哪些没抄、为什么） | 继续搞智能体时看 |
| `memory/*.md` | Claude 会话记忆：项目状态、实测数据、踩坑记录 | 想了解"为什么当初这么定"时查 |

## 换机后怎么起步

```bash
git clone https://github.com/HeWenbin-bobo/minimax-h3-workbench.git
cd minimax-h3-workbench
npm ci
npm run build          # 必须先 build：E2E 探针加载的是 dist 产物
npm test               # 单测
```

然后让 AI 读 `CLAUDE.md` 即可开工。

## tools/ 里的探针

`tools/harness.mjs` 与 `tools/probes/` 是**一次性取证工具**（E2E 探针），用来复现 bug、验证修复。
它们**不是产品代码**，也不参与 CI。

- 跑之前先 `npm run build`（部分探针加载 `dist-electron` / `dist` 产物）。
- 探针里的 `<relay-host>` 是占位符——原值是作者本机用的 LLM 中转地址，已脱敏。
  要用真实上游，先在自己的「连接设置」里配好。
- `tools/harness.mjs` 会克隆本机 Electron userData（含加密密钥）到临时目录，
  **密钥只在进程内解密、绝不打印、绝不落盘**。换机后需先配好自己的 Key 才能跑需要真上游的探针。

## 脱敏说明

推送前已把作者本机相关信息替换为占位符：

- 绝对路径 → `<root>` / `<repo>`
- 中转地址 → `<relay-host>`

仓库里**没有**任何 API Key、卡密、私钥。密钥只存在本机 Electron userData（safeStorage 加密）。
