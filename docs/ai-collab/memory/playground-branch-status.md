---
name: playground-branch-status
description: v0.2.1 已发布；2026-10-17 探索模式修 11 处，14 笔未推送
metadata:
  node_type: memory
  type: project
  originSessionId: c43a4719-8f9f-4185-b161-9cd51af6a1ae
  modified: 2026-10-17T05:40:00.000Z
---

**状态（2026-10-17 探索模式结束时）：工作区干净，`feature/agent-iteration` 领先 `main` 14 笔（未推送）。**

- `v0.2.1` 已发布（Release 含 latest.yml + setup exe + blockmap 三件套）。
- HEAD = `8b68990`。
- **本轮 14 笔（11 修复 + 2 文档 + 1 测试）未推送**（等用户确认）。

## 本轮（探索模式）11 修 + 2 文档 + 1 测试（都在 `v0.2.1..HEAD`）

分三类：
**A. "world state 载体不匹配"的三个面**（移植 Codex 时"载体"对不上，读代码看不出来，抓真实请求体才现形）。
**B. "项目自身纪律"的面**（超时 / 扩展名一致性 / 出错可见）。
**C. 补全 + 测试 + 文档**。

1. `84e8a45` world state 第 2 轮起全部丢失 + 智能体不认上下文超窗
   - `diffWorldState` 照搬 Codex 的"没变就不发"，但那套成立的前提是片段进**持久历史**；
     这里载体是每轮重建的 system prompt → 第 2 轮起环境事实全没了。改为**每轮完整渲染**。
   - 智能体路径不认上游 `ContextWindowExceeded`（只有普通对话认）→ 撞超窗反复撞墙。
     抽出共用 `noteContextOverflow()`。
2. `40de905` 二次压缩重发原始全量历史（应在当前历史上继续压）
   - `maybeCompact` 压缩的是渲染端原始 messages（无界增长），第 2 次压缩重发全量（实测
     44531→44619 字符不降反增）。改为以 `effective`（当前历史）为压缩对象，对齐 Codex。
3. `69a26d7` world state 必须作为 **user 片段**注入——拼进 system 会被模型忽略
   - 真实 key A/B：环境事实拼进 system prompt 时模型**直接无视**（问日期答"我无法得知"），
     6 种 system 通道全失败；作为 user 片段则 100% 生效。Codex 本就是作为对话片段注入的。
   - 修后真实 key 端到端：模型答"2026 年 10 月 17 日，周六"（与系统时钟一致）。
4. `312e7f2` 摘要请求未设输出上限（大上下文摘要可能被静默截断）——补 `max_tokens: 8000`。
5. `21ca76f` 产物落盘扩展名与 kind 不符 → 表格写成假 CSV / 直接落盘失败
   - 旧逻辑见 `.csv` 属已知扩展名就保留——但 `create_file` 把 csv/tsv 映射成 kind=xlsx，
     SheetJS 按扩展名把 **xlsx 二进制写进 .csv 文件**；`表格.tsv` 更直接抛错。
   - 修：先剥掉名字里任何已知产物扩展名，再按 kind 补上正确的那个。
6. `e2a352e` 补齐两处遗漏的超时/输出上限（`nonstreamChat` 没设 max_tokens；`minimaxAdapter` 四处 fetch 没自己的超时——CLAUDE.md 纪律）。
7. `5f29355` xlsx 预览全坏（`XLSX.readFile` 不是命名空间导出）+ 含逗号表格字段被错切
   - `await import("xlsx")` 的命名空间只有 read/write/writeFile/utils，**没有 readFile**——
     保存走 writeFile（在命名空间上）所以"存得下"，预览走 readFile 就报错"看不了"。统一走 loadXlsx() 取 default。
   - SheetJS `sheet_to_csv` 对含逗号字段加引号，两处朴素 split（main.ts 落盘 + 渲染端 SheetTable）都错切。新增 shared/csv.ts 的 parseCsvRow。
8. `609f814` 产物预览读取失败时静默卡在"（正在读取…）"——把错误显示到面板（正是它掩盖了 #7 的 readFile 报错）。
9. `f4e2492` 子框架(iframe)加载失败连坐整页 → 浏览器渲染在正常页面上误报失败（`did-fail-load` 未判 isMainFrame）。
10. `8b68990` settings.update 局部更新 llm/searchApi 把兄弟字段打回默认值（只 ssh 做了嵌套合并）。
11. `7aad02d`（test）补 `injectWorldState` 单测。
12. `af61536` + `991147a` + `b2fb2d6`（docs）把结论写入仓库记忆与考古文档。

**验证**：单测 265 项 / typecheck / build 全绿；新探针 probe-worldstate-turns /
probe-agent-overflow / probe-compact-source / probe-time-channel / probe-time-fullprompt（6 通道 A/B）/
probe-search-channel / probe-artifact-ext / probe-sheet-quoted / probe-xlsx-quoted /
probe-preview-error / probe-render-subframe / probe-render-bing / probe-settings-partial；
回归 probe-compaction 22/22、probe-plan-mode / probe-user-input / probe-codex-ui / .e2e/probe-preview 全过；
E2E test-01..10 全过（逐个跑，避免 CDP 端口争用）。

> "system prompt 完全无效"是过度概括（"搜索结果+明确指令"能照用，"短环境事实"被无视）——载体
> 选择（system vs 对话片段）取决于内容性质，不是非黑即白。

## v0.2.1 之后的 5 笔（v0.2.1..84e8a45 之前）

1. `72c37b8` 修 safePath 测试在 Linux 上失败（CI 红）
2. `2545f0c` 融入 Codex「剩余上下文余量」注入
3. `14ab5df` 修 dk- 系列模型窗口估大（128k→64k）
4. `a4b0b27` 入库 AI 协作资产（CLAUDE.md + 记忆 + 探针）
5. `1aa607c` 源码注释里的中转域名脱敏