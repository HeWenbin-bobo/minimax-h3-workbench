---
name: playground-branch-status
description: v0.4.0 已发布（main = tag v0.4.0）；feature/agent-ask-before-generate 的 115 笔已合并进 main 并随 v0.4.0 发版，2026-10-22 基线 971 项单测 / E2E 173/173
metadata:
  node_type: memory
  type: project
  originSessionId: c43a4719-8f9f-4185-b161-9cd51af6a1ae
  modified: 2026-10-22T11:50:00.000Z
---

**当前状态（2026-10-22 19:47）：`v0.4.0` 已发布。`main` HEAD = tag `v0.4.0`，与 `origin/main` 同步。**
最新 Release 已从草稿转为正式；`releases/latest` 返回 `v0.4.0`（`2026-10-22T11:47:01Z`），
`latest.yml` 指向 `0.4.0`，三件套齐全：

- `latest.yml`（369 字节）
- `minimax-h3-workbench-setup-0.4.0.exe`（95.8MB / 100406930 字节）
- `minimax-h3-workbench-setup-0.4.0.exe.blockmap`（103.6KB / 106128 字节）

`feature/agent-ask-before-generate` 的 **115 笔提交原样合入 `main`**（`--no-ff`，
合并提交 `655382d` `merge: feature/agent-ask-before-generate 合入 main`）：49 个文件，
+5734 / −352。**没有 squash**——与 v0.3.1 那次（202 笔压成 `7000c62`）不同，这次保留了逐笔历史。
发版收尾提交为 `9a170f5 chore: bump version to 0.4.0`。

`feature/pelican-exploration-2026-10-19` 的 **202 笔提交已 squash 成一条** `7000c62`
（`merge: feature/pelican-exploration-2026-10-19 — 智能体产物闭环补全 + 一整类"静默跳过"缺陷`）
合入 `main`；37 个文件，+5876 / −244。
**原始逐笔历史也已推到远端**（`b457e80`，本地与远端一致，未改写）。

**引用提交时不要写「HEAD = <sha>」**：本轮为了把收尾压成一条，`main` 尖端被 amend 过，
写死的 sha 会立刻过期（而且写进文件本身就是自引用）。要么引用不可变的 tag（`v0.3.1`），
要么引用不会被改写的提交（`7000c62`、feature 分支的 `b457e80`）。

**CI**：这个 fork 的 `push` 事件**不会**自动跑 workflow（历史运行全是 `workflow_dispatch`，
push 到 `main`、推 tag 都一样）。两次都是按 CLAUDE.md 手动 dispatch：

- run `39368297085`（`7000c62` / `main`）：`test` ✅、`package (windows)` ✅、
  `package (macos)` ✅、`release` **skipped**（`refs/tags/v` 守卫，未发版）。
- run `39391708598`（`v0.3.1` 发版那次，跑在当时的 bump 提交上）：`test` ✅、`release` ✅、
  `package (windows)` ✅、`package (macos)` ✅；生成草稿 Release 后手工转正式。
  （该提交后来被 squash 进 `main` 尖端，SHA 不再存在；结论不变——同一份源码树。）

验证基线：`npm test` **789 项 / 43 文件**全绿；typecheck、build 通过；
E2E test-01…test-10 逐个复跑全过（21/12/5/5/23/12/20/16/10/11）。

**发版踩到的两个新细节**：
- `curl -d` 传中文 JSON 在 Git Bash 下容易转义出错，用 `--data-binary @file`；
  且 `/tmp` 在 Git Bash 与 node 里解析不一致（node 会当成 `F:\tmp`），
  临时 JSON 放仓库 `_scratch/`（已 gitignore）最稳。
- 本地不会自动出现 `origin/feature/...` 这个 remote-tracking ref（仓库没配
  `fetch = +refs/heads/*`），核对远端 SHA 要用 `git ls-remote --heads origin <branch>`。

---

**状态（2026-10-18）：`v0.3.0` 已发布。`feature/agent-iteration` 的 379 笔提交已**
**squash 合入 `main`（`c708747`）并推送；tag `v0.3.0` 已推、CI 全绿、Release 已转正式。**

- `v0.3.0` Release 含三件套：`latest.yml` + `minimax-h3-workbench-setup-0.3.0.exe`（95.7MB）+ `.blockmap`。
- `main` HEAD = `c708747`；`feature/agent-iteration` HEAD = `fb9488e`（内容与 main 一致）。
- 验证基线：`npm test` **549 项 / 39 文件**全绿；typecheck、build 通过；
  E2E test-01/02/03/05/06/07 复跑通过；`probe-preview`(22/22)、`probe-compaction`(22/22) 等探针全过。
- 路径相关逻辑（`artifactDir` / `csv` / `dimensions`）已在 **WSL Ubuntu + Node 24**（与 CI 同版本）额外验证。
- CI 手动触发：`POST /actions/workflows/build.yml/dispatches {"ref":"v0.3.0"}`
  （该 fork 推 tag 不会自动跑，见 CLAUDE.md「坑①」）；`test` / 两个 package job / `release` 全部 success。

- `v0.2.1` 已发布（Release 含 latest.yml + setup exe + blockmap 三件套）。
- HEAD = `9639b6c`。
- **本轮 54 笔未推送**（等用户确认；逐笔见 `git log main..HEAD`）。

## 探索分支 `feature/agent-ask-before-generate` 上的累积修复

**这条分支不是 `main` 的发布状态**，下面是这条分支上历次探索期的产出汇总（按主题，不按批次）。

### 2026-10-21/22 探索期（12h）

主线三条，各自都有"读代码看不出来、动手试才现形"的根因：

**A. 重试判据把 429 挡在门外**（详见 [codex-harness-port.md](codex-harness-port.md) 坑 12–14）
- `errorRecovery.retryDelayMs` 早就实现好，两条路径的判据却不放行 429；
- 更隐蔽的是 SDK 抛 `AI_RetryError` 时不带 `statusCode`，状态码藏在 `lastError` 里——
  只在顶层找等于永远找不到。直连 SDK 打印形状才发现。
- 普通对话放行 429+5xx，智能体只放行 429（SDK 自己已 `maxRetries: 1` 覆盖 5xx，
  整轮再等 3 次会把 500 拖到十几秒）。E2E test-02 从 14/16 恢复 16/16 就是这条。

**B. 不可逆操作挡不住连点**（详见 [double-click-and-reentrancy.md](double-click-and-reentrancy.md)）
- 同一根因共 8 个入口；最重的是回收站「彻底删除」——实测连点 3 次，
  主进程真的收到 3 次 `tasks:purge`（不可逆、连视频文件一起删）。
- 顺带把提示改成带实际条数（`已彻底删除 N 条`），既给用户真实反馈，也让"重复执行"有可观察痕迹。
- 新增回归护栏 `.e2e/test-11-double-click-guards.mjs`。

**C. 切页期间的补齐通道缺少验证**（详见 [probe-blind-spots.md](probe-blind-spots.md) 教训 ④⑤）
- 新增 `.e2e/test-12-page-switch-mid-stream.mjs`：流式中途切走**超过整轮时长**再切回，
  只有主进程的 `turnState` 能补齐；扩成连续三轮以覆盖"读一次就清"的复用能力。
- 变异验证：去掉两处 `turnState.fullText = turnText` 后气泡停在「段0 段1」、缺段 `[2,3,4,5,6]`。

**D. 计划模式：紧凑的两步计划被长度门槛误杀**
- `looksLikePlan` 里 `body.length < 30` 排在有序列表判据之前，于是「1. 查资料\n2. 写报告」
  被判成"不是计划"，「继续执行」按钮不出现。单测里那条断言当时**锁的就是错误行为**。
- 端到端对照：同一段 13 字计划，旧逻辑界面上没有「▶ 继续执行」，修复后正常出现。

**E. 文档纠偏**
- `worldState.ts` 顶部注释写"直接拼进 system prompt"，与同文件 `injectWorldState` 的
  "必须作为 user 消息"实测结论**互相矛盾**；已改。
- `llmService.ts` 里 `prepareStep` 的说明整段重复两遍，已删重复。

**验证基线（2026-10-22）**：`npm test` **971 项 / 47 文件**全绿；typecheck、build 通过；
E2E **test-01…test-12 全套 173/173**。

**真机验证（真实中转 + 真实模型，经 `tools/harness.mjs` 克隆 userData，密钥不打印）**：
- **`compute` 工具**：40 个已知温度值（-10~29，步长 1），模型调用了 1 次工具、
  回执为「✓ 统计数据完成（40 个样本，范围 -10~29，均值 9.5）」；
  最终数字与独立核对**全部一致**（min -10.0 / max 29.0 / mean 9.5 / median 9.5 / sum 380 / stdDev 11.5434）。
- **对话主流程冒烟 8/8**：真实上游连通、正文正确、无错误气泡、收尾后停止键消失、
  会话不再标记生成中、可继续发第二条。
- **成功路径零额外开销**：mock 下游正常 200 请求只发生 1 次、端到端 9ms，
  说明 429 的重试改动只影响失败路径，没有给每次对话白加退避等待。

**合并与发版（2026-10-22 19:47 完成）**：
- 分支 `feature/agent-ask-before-generate` 的 115 笔提交已用 `--no-ff` **合并进 `main`**
  （合并提交 `655382d`），并已推送远端。**这次没有 squash**，保留逐笔历史。
- 发版：`package.json` 0.3.1 → **0.4.0**（`9a170f5`）→ annotated tag `v0.4.0`
  → 推 `main` + tag → 手动 dispatch CI（run `39772078855`）→ 草稿 Release 有资产后转正式。
- 那次 CI 四个 job 全绿：`test` ✅、`package (windows)` ✅、`package (macos)` ✅、`release` ✅。
  **坑⑤ 复核**：`test` 跑在 ubuntu 上通过，本轮改的 `artifactDir` / `artifactStats` /
  `settingsStore` / `localModels` 测试均为纯字符串或 `tmpdir` 用法，无符号链接/权限依赖。
- `package-lock.json` 的根 `version` 已从 `0.2.0` 校正为 `0.4.0`（用 `npm install --package-lock-only`，
  只动 2 行；`chromium-pickle-js` 的真实 `0.2.0` 未受影响）。
- 工作区干净，本地与 `origin/main`、`v0.4.0` 的 SHA 完全一致。

**下一阶段的入口**（供接手时快速定位）：
1. 下一个功能/修复从 `main` 开 `feature/*` 分支。合并回 `main` 用 `merge:` 提交；
   squash 与否按当轮规模决定（v0.3.1 是 202 笔压成 1 条，v0.4.0 是 115 笔原样保留）。
2. 发版仍需手动 dispatch CI（这个 fork 推 tag 不会自动跑），且 test 在 Linux 上跑——
   改了文件系统/路径/符号链接相关测试时，发版前先在 WSL 复核（坑⑤）。
3. 未覆盖的边界：真实上游的 429（本机中转未触发过限流，全部用 mock 复现）；
   `test-12` 只验了正文补齐，切页期间的任务卡片与工具步骤补齐未单独造例。


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
11. `af23774`（安全）SSRF 防护漏判 IPv4 映射的 IPv6：`https://[::ffff:127.0.0.1]/` 被放行
    - URL 会规范化成 `[::ffff:7f00:1]`，旧前缀检查（fc/fd/fe8…）漏判。取末 32 位还原成 IPv4 再判。
12. `8b8d8bd` 流式期间往上翻看历史被每个 chunk 拽回底部（注释写着"仅在接近底部时跟随"但没实现）。
13. `7aad02d`（test）补 `injectWorldState` 单测。
14. `af61536` + `991147a` + `b2fb2d6` + `5c8d08d`（docs）把结论写入仓库记忆与考古文档。

**验证**：单测 265 项 / typecheck / build 全绿；新探针 probe-worldstate-turns /
probe-agent-overflow / probe-compact-source / probe-time-channel / probe-time-fullprompt（6 通道 A/B）/
probe-search-channel / probe-artifact-ext / probe-sheet-quoted / probe-xlsx-quoted /
probe-preview-error / probe-render-subframe / probe-render-bing / probe-settings-partial /
probe-scroll-stick；
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


## 第二批修复（同一探索会话后半段，按问题类型归纳）

前期集中在「world state 载体 / 项目自身纪律」，后期继续深挖，覆盖了更多真实故障面：

| 类型 | 具体问题 |
|---|---|
| **数据正确性** | 帧数换算方向反了（4 秒→3.75 秒）；CSV 含逗号/换行字段错切；xlsx 预览 readFile 全坏；同名产物互相覆盖；ComfyUI 取到预览帧当成品 |
| **静默失败** | 预览读取失败卡「正在读取」；空产物永远「正在读取」；localStorage 写满导致界面塌成空白 |
| **安全** | SSRF 漏判 IPv4 映射 IPv6（::ffff:127.0.0.1）；artifact sessionId=".." 越出产物目录 |
| **并发/一致性** | settings 并发写失败+丢更新（无串行化）；IPC 抛异常导致会话永久发不出消息；轮询闭包用旧历史（chip 停在 0%） |
| **健壮性** | Bing/搜狗解析只认精确 class；markdown 表格外侧竖线/转义竖线/紧随段落；CRLF 围栏提取不到产物 |
| **超时纪律** | SSH exec 无超时；ComfyUI 请求裸等（含 `signal ?? timeout` 的假超时） |
| **协议/端点** | 智能体不推导端点（MiniMax 官方 404）；中国站域名被当中转 |

**通用教训（已多次验证）**：
- 「注释承诺了但代码没实现」是高产 bug 源（滚动跟随、预览宽度记忆、错误可见）。
- 「同一语义两处实现」必有一处漏（校验/超时/端点/合并策略）——改一处要 grep 全仓同类。
- 真实 key 端到端必跑：单测 + E2E 全绿仍可能模型根本没看进去（world state 那次）。

## 2026-10-17 深夜批量（自 `991147a` 之后，共 137 笔未推送）

按问题类型归纳，重点在**「UI 有选项但下游没接线」**与**「同一职责分散在多处」**：

| 类型 | 具体问题 |
|---|---|
| **功能静默失效** | 画幅/分辨率下拉完全不生效（工作流读 `width/height`，UI 只改 `ratio/resolution`）——新增 `shared/dimensions.ts`；视频拖不动进度条（`net.fetch(file://)` 不支持 Range）——新增 `mediaRange.ts` 自实现 206；搜索 API 返回 0 条时静默（模型凭旧知识答）；ComfyUI 完成但无产物会干等 30 分钟超时 |
| **素材按模式过滤** | 切模式/切预设后旧路径残留：MiniMax 收到两个 `first_frame`；RB `easy_15` 仍上传参考图；ComfyUI 图生视频挂上残留尾帧。三个后端同一类，必须各自按 `mode`/`preset` 过滤 |
| **SSRF 三重** | 结果下载漏 5 种 IPv6 内嵌 IPv4；`open_page` 只校验协议不拦内网；**3xx 重定向可绕过首跳校验**（实测 302 → `127.0.0.1` 内网内容被读回） |
| **超时纪律** | ComfyUI `cancel()` 无超时；`signal ?? AbortSignal.timeout()` 假超时两处；`nonstreamChat` 无超时；普通对话 SSE 无空闲超时（上游卡住光标一直闪） |
| **崩溃/僵尸状态** | SSH 掉线无 error 监听器（主进程直接退出）+ 重连后仍用旧端口；abort 回调里的未处理 rejection；读密钥失败让会话永久卡在「上一轮还在进行中」；旧一轮 finally 清掉新一轮 controller |
| **数据损坏** | `tasks.json` / localStorage 一条坏记录让**全部**历史消失（元素级校验写成整体级）；消息 `content` 非字符串抛英文 TypeError；第三方 API 返回非数组 JSON |
| **性能** | 流式每个 chunk 都把全部会话 stringify + 同步写盘（实测 2.2MB × 20 次/秒）→ 节流 400ms |
| **密钥/设置** | settings.json 嵌套字段无类型校验；密钥解不开仍报「已保存」+ 英文 crypto 错误 |
| **资源泄漏** | 会话彻底删除后 `artifacts/<sessionId>/` 永久留盘（新增 `artifact:purgeSession`）；拖拽中面板卸载导致 window 监听器残留 |
| **IPC 健壮性（一批同型）** | 多处 `await window.h3.*()` 无 try/catch 或丢弃返回值：三个按钮点了没反应、检测/更新/测试连接卡在加载态、回收站与项目操作、模型下载页、连接页两个「选择」、游乐场提交无双击守卫（RB 重复扣费） |

**本轮新增认知**：
- **一类缺陷往往成批出现**：修完一处后 grep 同型模式（`signal ?? AbortSignal.timeout`、`void x.then(`、
  `JSON.parse` 后直接 `.map`、`await window.h3.*` 无 try）比逐个读文件高效得多。
- **「看起来生效、实际没生效」必须对照下游真实输入**：UI 改的是 `ratio/resolution`，
  工作流读的是 `width/height`——只读 UI 代码永远看不出来。
- **先跑探针再下结论**：`net.fetch(file://)` 的 Range 不支持、Electron 跟随 302、
  React updater 里做副作用，都是实测确认后才算数。
- **测试也可能锁住正确行为**：MiniMax「Success 但无 url 继续轮询」看着像 bug，
  实际是云端转码延迟的真实契约（已加注释防止再被"修"）。
- **自己引入的回归要立刻修并记录**：SSH `test()` 顺序、`setSessions` updater 副作用、
  capSessions 无限渲染循环——都在同一轮内发现并修正。

## 2026-10-18 探索模式续（自 137 笔之后 → 240 笔）

本轮反复验证的一条：**「校验器允许的形状」必须与「下游假设的形状」一致**。
`validateRequest` 对 `baseSeed/width/height/ratio/resolution` 只做"给了才校验"，
而 `submit()` 全部当必有 → `baseSeed` 缺省时 `undefined + 0 = NaN` 写进任务记录
（卡片显示 "Seed NaN"）与 ComfyUI 的 `noise_seed`（JSON 里变 null）。
修法是在 submit 内统一补齐并**同时**用于"写进任务"和"传给 runTask"，否则重试会读到未补值的旧对象。

**本轮修复（按类）**：

| 类型 | 具体问题 |
|---|---|
| **静默失败（旧路径）** | 工作台素材选择 `choose()` 丢弃 IPC Promise、不判 `ok`；预览面板 📁 用 `.catch(()=>undefined)` 吞掉白名单拒绝；`retry()` 绕过 `validateRequest`（未知 backend 静默落到 SSH，RB 非法时长真发云端并扣卡密） |
| **取消失效** | `open_page` 漏传 `controller.signal`（停止后隐藏窗口仍跑满 45 秒）；`nonstreamChat` 读 `this.controller`，`abort()` 置空后补发请求仍会真的发出（最长 120 秒） |
| **资源泄漏** | 三个后端 `delay()` 的 abort 监听器只在取消时移除（ComfyUI 30 分钟 ≈ 600 个、Cloud 轮询 360–720 个）→ 正常结束也 `removeEventListener` |
| **崩溃风险** | SSH 握手失败后失败的 client 留在字段上、`once("error")` 已被消耗 → 迟到 error 无监听器，主进程退出 |
| **参数契约** | `submit` 缺省字段补默认值（NaN seed / 缺 width·height / 非法 ratio·resolution）；`retry` 复用存档参数时补校验 |
| **IPC 类型** | `artifact:save` 入参 null/非字符串 → 英文 TypeError；`settings:update` 传 null → 读属性时炸（对象展开 `...null` 合法，故容易漏） |
| **文案与行为不符** | 游乐场「视频描述（留空则用聊天内容）」永远不生效（`videoRequest` 继承工作台的 demo 提示词） |
| **跨会话串台** | `newSession()` 漏清 `planNext`（新对话首条消息会以计划模式发出） |
| **产物识别** | `extractArtifact` 文档别名漏了 `md`——正是 `create_file` 的 kind 枚举值（同当年漏 `xlsx`） |
| **判定口径** | `classifyEnvironment` 的 C 级门槛把"磁盘读不到(0)"当"空间不足"，把 24GB 显存机器判成 D 级 |
| **瞬映下载** | 直链 `/video` 网络层抛错时直接跳出，`video_url` 回落永远轮不到（卡密已扣、成片拿不到） |

**新增测试**：`extractArtifact` 围栏别名 5 条、`submit` 默认值 3 条、`retry` 校验 2 条、
SSH 握手失败 1 条、RB 直链回落 1 条、磁盘未知判级 1 条。

**探针自身的坑（不是产品问题，但会误导）**：
- `.e2e/probe-preview.mjs` 用 `Object.keys(localStorage).find(k => k.includes("sessions"))`
  取键——全新临时 userData 里还没有这个键，写入落到 `"undefined"`；且空会话清理是
  400ms 节流后才写盘，400ms 就检查会读到清理前的旧值。改成固定键名 + 1200ms。
- `.e2e/probe-l-ui-buttons.mjs` 假设"点一次取消 = 4 路全部取消"（实际是逐任务），
  且用 `.cancel-button` 判"取消按钮消失"——该 class 也被「重试」按钮复用，要按文案判。
- `.e2e/probe-g-settings-trash.mjs` 只点一次「彻底删除」——该操作已改为两段式确认
  （先「彻底删除」再「确认删除」），探针没跟上，断言自然落空。

## 2026-10-18 第三批（240 → 273 笔）

这一批的主线是**「两条路径只修了其中一条」**与**「保存即断线」**：

| 类型 | 具体问题 |
|---|---|
| **只修了一半** | `submit()` 补了缺省参数默认值，`retry()` 没补 → 抽出 `normalizeRequest()` 共用；`pickRoot()` 修了"先改 state 再落盘"，`ConnectionsPage.save()` 同样错序；`settings:update` 与 `secret:set` 都会 `invalidate()`，LLM 侧保住了在途实例，SSH 侧却当场 `close()` |
| **保存即断线** | 任何一次设置保存都会 `AdapterRegistry.invalidate()` → `sshAdapter.close()` → 正在跑的 SSH 生成断在 ECONNREFUSED；改完 model/Key 后保留下来的会话实例又会被下一轮复用（旧配置）→ 引入 `serviceGeneration` 代次 |
| **写盘失败没回滚** | `submit` / `retry` 先改内存再 `await save()`，失败时内存多出一批「等待生成」幽灵任务，且 `trimHistory` 可能已淘汰旧组 |
| **删了又冒回来** | 删除流程先打 `deletedAt` 再 `cancel()`，而 `cancel()` 会推 `task:update`；渲染端无条件 upsert，刚删的项目借推送"复活" |
| **读盘脏值** | `tasks.json` 的 `index`/`seed` 未归一（排序 NaN、`noise_seed` 变 null）；`secrets.json` 非字符串值 → 英文 `ERR_INVALID_ARG_TYPE`；`role` 未校验（"tool"/数字 → 该会话永久 400）；会话 `messages` 里字符串会被按字符展开、`taskIds` 非数组会包成 `["abc"]` 导致渲染端 map 白屏 |
| **英文技术错误** | ComfyUI / MiniMax 反代返回 HTML 时 `response.json()` 抛 `Unexpected token '<'`（ComfyUI 轮询里还会把已计时的任务判死）；`/object_info` 非对象时 `"x" in "ok"` 抛 TypeError |
| **ok:false 被静默** | 启动读设置、回收站刷新、任务列表刷新、模型清单检查、两个「选择」按钮——全部只判 `data`，失败时"保持旧值且无提示" |
| **取消/监听器** | `QuestionBridge.answer()`（最常见路径）不摘 abort 监听器；`SshTunnel.close()` 先断后清字段（可重入）+ 不销毁已接受 socket |
| **产物/附件** | 文档围栏漏 `md` 别名；GIF 附件被压成静态 JPEG（丢动画与透明） |
| **判定与筛选** | 磁盘读不到时 C 级门槛把够用的机器判成 D 级；游乐场会话分类筛选失效后列表变空、按钮也没了 |
| **文案与行为不符** | 游乐场「留空则用聊天内容」永不生效（表单继承工作台 demo 提示词）；`newSession()` 漏清 `planNext` → 新对话首条消息以计划模式发出 |

**新增测试**：SSH 适配器延后关闭 3 条、`secrets` 脏值 2 条、ComfyUI HTML 2 条、
`extractArtifact` 别名 5 条、`submit`/`retry` 归一 5 条、会话归一 3 条。

## 第四批（273 → 290 笔）

主线是**「用户可感知的状态会莫名其妙消失或串台」**：

| 类型 | 具体问题 |
|---|---|
| **草稿丢失** | 切页会卸载 `StudioPage`，填到一半的提示词整个消失（输入框还重新填上 demo 文案，用户甚至意识不到丢了）；跨会话切换时「生成视频」表单的描述也会串台 |
| **状态串台** | 删光会话后顶部仍挂着上一个会话的「上下文 N%」；预览面板换产物时先显示上一份文件的磁盘内容 |
| **静默失效** | 摘要失败的占位文本不被 `isSummaryMessage` 认出 → 下次压缩当"用户原话"累积；第三方搜索 API 结果不截断（其余三条路径都截 6 条） |
| **假可点击** | markdown 把 `http://` 渲染成 `<a target="_blank">`，而主进程只放行 HTTPS → 点了毫无反应 |
| **误判落点** | 选错 ComfyUI 目录 → 显示「0 / 5 个模型已就位 + 去下载」，而真实原因是目录不对 |
| **卡死风险** | 就绪检测的 5 个 `systeminformation` 采集无超时（Windows 走 WMI）→ 「正在检测…」永久转圈 |
| **写盘失败未回滚（补齐）** | `submit`/`retry` 之外，`deleteTasks`/`restoreTasks`/`setCategory`/`purgeTasks` 同样"先改内存再写盘" |
| **性能** | 流式每个 chunk 都重新 markdown 解析全部历史；拖拽预览面板时每帧全量解析 CSV |

**结论**：`npm test` **484 项 / 37 文件**；E2E test-01…test-10 逐个复跑全过
（21/21、12/12、5/5、5/5、23/23、12/12、20/20、16/16、10/10、11/11）。
290 笔仍未推送（等用户明确指示）。

**探针自身又踩到 2 条假设错误**（记下来避免重复排查）：
- `probe-explore-a` 用 `model: "mock-a"` 测「多模态载荷含 image_url」——但
  `normalizeHistory` 会按**模型名**判断视觉能力，纯文本模型被剥图是正确行为。
  换成 `gpt-4o-mock` 后通过。
- `probe-explore-b` 用脚本给 textarea 赋值来验证 `maxlength`——属性写入不受该约束
  （只有真实键盘输入才会被拦）。断言改为"属性确实挂着 2000 + 超长提交有中文拒绝"。

## 第五批（290 → 332 笔）

这一批的主线是**「一次失败的读取/写入会永久吞掉用户数据」**与
**「功能建好了但没人接线」**：

| 类型 | 具体问题 |
|---|---|
| **读失败吞数据** | `tasks.json` / `settings.json` / `secrets.json` 读取或解析失败时直接返回「空/默认值」，而三者都是**读-改-写**：下一次写盘就把用户的任务历史、整份设置、**其余四个已保存密钥**永久抹掉。现在非 ENOENT 的失败先把坏文件 `rename` 成 `.corrupt-<时间戳>` |
| **不存在的文件被静默调用** | `shell.showItemInFolder` 对已删除路径是空操作 → 补 `stat` 检查并回报中文错误 |
| **建好了却没接线** | `onDownloadProgress`（安装包下载进度）+ `.download-progress` 样式齐全但**零订阅方** → 接通并显示「已完成 N%」 |
| **目录名碰撞（安全）** | `sessionDirName` 只把危险字符换成 `_`：Windows 上 `basename("x:y")→"y"`，`a\|b`/`a_b` 同归 → 构造 sessionId 命中**别人**的产物目录，再触发 `artifact:purgeSession` 即不可逆删除。抽出 `modules/artifactDir.ts`，净化改动过原值时追加 12 位 sha256 |
| **文案与状态相反** | 密钥输入框一律写「已保存的密钥不会回显」，全新用户以为已配好 → 改用从未被调用的 `hasSecret` IPC 判断真实状态 |
| **同类只修一半** | `retry()` 补齐可缺省参数（`normalizeRequest` 共用）；`restoreSession` / 自动落位补草稿清理；`checkRoot()` 补 `ok:false` 报错；`pickAttachment` 补 `ok:false`；`parseBing` 的 `<h2>` 与 href 补全 |
| **翻译/判定** | `Invalid URL`（地址漏写 http://）此前拼成「网络错误 Invalid URL。请检查端口」；token 估算的 CJK 正则只覆盖汉字，日文假名/韩文按英文密度估（低估 2~2.5 倍）；内存读数未知会把够用机器判成 D 级 |
| **中文乱码** | 渲染端标题/项目名/重命名/分类、主进程工具摘要与 `setCategory` 仍用裸 `slice` → 统一 `sliceSafe` |
| **性能/OOM** | 三个后端下载成片用 `arrayBuffer()` 整个读进内存（2K 长片数百 MB，主进程静默闪退）→ 流式 `pipeline` 落盘；GIF 附件按体积触发降级 |
| **竞态/资源** | 浏览器渲染排队期间不可取消；`submit`/`retry`/`delete`/`restore`/`setCategory`/`purge` 写盘失败未回滚；`tasks.json` 的 `progress` 未夹到 0–100（显示 500%） |
| **自己引入的回归（已修）** | 把 markdown 链接正则从 `https?` 收紧成 `https` → `[标题](http://…)` 整段露出方括号原文；改为仍匹配、仅 http 渲染成纯文本 |

**结论**：`npm test` **496 项 / 38 文件**；E2E test-01…test-10 逐个复跑全过。
332 笔仍未推送（等用户明确指示）。

**新增测试（本批）**：`artifactDir` 4 条、`taskStore` 损坏备份 1 条、
`settingsSecrets` 损坏备份 1 条、`capabilities` 内存未知 2 条、
`mediaFile` 流式落盘 2 条、`webSearch` h2 属性与协议相对链接 2 条。

**探针自身的坑（续）**：
- `probe-preview-security.mjs` 用页面内 `fetch(h3preview://…)` 取响应头——
  宿主 CSP 的 `connect-src` 不含 `h3preview:`，请求发出前就被挡掉：
  两条「响应头」断言永远 FAIL（产品其实正确），而「越界被拒」只判 `status !== 200`，
  fetch 抛错时 `status` 是 undefined → **假 PASS**。改用 CDP `Network.responseReceived`。
- `probe-h-readiness-models.mjs` 只用 IPC 改 `comfyuiRoot` 却不 reload，
  渲染端 state 仍是旧值（`probe-j` 有 `location.reload()`）；且它假定本机必判 D 级，
  而 RTX 5090 + 189GB 内存判 C 级才是对的。

## 第六批（332 → 346 笔）

主线是**「判定所依赖的前提被写死，换个输入就失效」**——前五批修的是"明显会坏"，
这一批修的是"看起来对、条件一变就错"：

| 类型 | 具体问题 |
|---|---|
| **SSRF 绕过（安全）** | `assertPublicHttpUrl` 只比 `localhost` / `.local` / `.internal` 的**字面量**，而 `localhost.` 是 FQDN 根锚定写法、DNS 解析完全等价。实测（本机起真实 HTTP 服务）`http://localhost.:<port>/object_info` 通过校验并读回内网响应体。修法：`hostname` 先 `replace(/\.+$/, "")` 再判定 |
| **监听器不认领自己** | `SshTunnel` 断线后重建，旧 client 的 `close`/`error` 监听器写成 `() => this.drop()`（作用于对象字段），旧连接的事件晚到时会把**新隧道**一起拆掉 → "刚重连上又断了"。改为闭包捕获本次 client，`this.client === client` 才收尾 |
| **超时只 reject 不清理** | `SshTunnel.exec()` 超时后远端流仍在跑，`data` 监听器持续往局部字符串追加（`tail -f` 类是无限增长）→ 统一 `teardown()` 销毁流 |
| **markdown 无上限** | 聊天里模型偶尔吐出上万行表格 → 主线程被 DOM 铺满。加 `MAX_TABLE_ROWS = 200` 并如实告知"共 N 行，仅显示前 200" |

**结论**：`npm test` **510 项 / 39 文件**；typecheck、build 通过；
E2E test-01…test-10 逐个复跑全过（21/21、12/12、5/5、5/5、23/23、12/12、20/20、16/16、10/10、11/11）。
346 笔仍未推送（等用户明确指示）。

**新增测试（本批）**：SSH 迟到 close / exec 超时销毁流 2 条、SSRF 尾点 2 条。

**探针自身的坑（再续）**：
- 用 `AbortSignal.any([caller, timeout])` 验证超时行为时，曾用**端口 9** 当"连不上"的目标——
  Windows 上端口 9 属 bad port，fetch 抛的是 `fetch failed` / cause `bad port`，
  与超时无关。要验超时必须起一个**真实的挂起 HTTP server**（`createServer` 不响应）。
- `_scratch/` 下的 `.ts` 探针被 `npx tsx` 按 CJS 转译，**顶层 await 会直接报
  "Top-level await is currently not supported with the cjs output format"**——
  包进 `async function main()` 再 `void main()`。
- 从 `_scratch/` 里 `import "../repo/node_modules/xlsx"` 会 **MODULE_NOT_FOUND**：
  ESM 包得用 `createRequire("F:/…/repo/package.json")` 再 `require("xlsx")`。

## 第七批（346 → 365 笔）

主线是**「一次失败/一次异常输入会永久或长时间卡住整条链路」**——
前六批修的是"结论错"，这一批修的是"卡住/泄漏/崩溃"：

| 类型 | 具体问题 |
|---|---|
| **SSRF（通配 DNS）** | 字面 hostname 合法 ≠ 公网。`127.0.0.1.nip.io` / `localtest.me` 把 IP 编进域名，实测能真的读回本机服务。新增 `assertPublicHttpUrlResolved()`（`dns.lookup(all)` 后任一结果落内网即拒），`open_page` 与浏览器渲染都用它；导航守卫走 `webRequest.onBeforeRequest`（该回调可异步）。已知上限：不防 DNS 重绑定（已写进注释） |
| **连接泄漏** | `consumeSse` 收到 `[DONE]` 只 `releaseLock()`（不断连接）。实测连跑 3 轮留下 3 条 socket。改为 `reader.cancel()` |
| **永久挂住** | `LlmService.chat()` 只传用户取消信号（永不到期），`consumeSse` 的空闲超时在拿到响应头**之后**才生效 → 上游不回响应头时永久卡住（实测 8s 仍未落定）。加独立的「等响应头」计时（120s） |
| **停不下来的解析** | `parseBing`/`parseSogou` 的大正则遇到"大量完整前缀但永不闭合"是 O(n²)：实测 2 万前缀 **15.5 秒**（加跨距上限也无效）。改为线性 `collectBlocks`（先收集闭合位置再配对），2–3ms |
| **栈溢出白屏** | `renderMarkdown` 对 `<proposed_plan>` 正文递归渲染，1000 层就爆栈（模型可被注入诱导写出来），刷新后立刻复发。加 `MAX_PLAN_DEPTH = 8` |
| **主进程崩溃** | `SshTunnel` 的 accept 回调用 `this.client!`：`close()` 后迟到的连接会让它在 net 回调里抛 TypeError，无人可接（进程直接退出）。改为先取局部变量并 destroy |
| **负尺寸** | `resolveDimensions("-1:2")` 只判 `!w || !h` 漏掉负数 → `height: -1440` 进 ComfyUI 工作流 |
| **十几 MB over IPC** | xlsx 预览 `sheet_to_csv(整表)` 无上限（10 万行实测转出十几 MB）。按 `!ref` 收窄到 2000 行 |
| **自引入回归** | 上面那条的提示文案被拼进 CSV 正文，渲染端当成**一行数据**（3 行表格变 4 行）。`artifact:read` 改成 `{ text, note? }` 结构化返回 |
| **测试通过≠没坏** | 三条「先保存再测」路径只 `setSettings` 不回写 `draft`（表单显示与磁盘不一致）；启动链没有 `.catch()`（失败时双击毫无反应）；`checkFrameworkUpdate` 用裸 `response.json()`（HTML → 英文 `Unexpected token`）；`bad port` 未收录（中英混排） |

**结论**：`npm test` **528 项 / 39 文件**；typecheck、build 通过；
E2E test-01…test-10 逐个复跑全过；探针 `probe-preview`/`probe-plan-mode`/`probe-compaction`/
`probe-preview-headers`/`probe-user-input`/`probe-codex-ui` 全过。

> **已修正（2026-10-19）**：本批结束时写的「365 笔仍未推送」已过时。后续又修到 379 笔，
> 经用户明确指示**推送 + squash 合并 + 发版 v0.3.0**（详见文件头的当前状态）。
> 保留这句是为了说明当时的记录口径，不要按它判断仓库现状。

**发布后才发现的四类问题**（都在 v0.3.0 的 squash 提交里，不在上面的表格中）：

| 类型 | 具体问题 |
|---|---|
| **错误处理路径自己抛错** | `isContentFilterError` 用 `JSON.stringify(error.data)` 拼待匹配文本；错误体是循环引用 / BigInt / 抛错的 `toJSON` 时**自己炸掉**，一次本该"改写措辞重试"的内容拒绝变成未捕获异常。新增 `safeStringify()`（失败退 `String()`，再失败空串，**永不抛错**） |
| **同一判定写了两处** | SSRF 那边修了 `localhost.` 尾点，`resolveChatPath` 里的 hostname 精确比对没跟着修 → `api.minimax.io.` 走错端点（404）。`assertPublicHost` 与 `resolveChatPath` 现在都先 `replace(/\.+$/, "")` |
| **字段形状异常连坐整份报告** | `inspectEnvironment` 直接 `graphics.controllers.map(...)`。`systeminformation` 走 WMI，驱动异常时可能返回**缺字段的对象**（不是 reject）→ TypeError → 整份「开始配置检测」失败，而磁盘/内存/ComfyUI 其实都采到了。实测 `vram: "abc"` 还会让显存合计变 NaN、静默降级判级 |
| **NaN 让"取最大"失效** | `pickVolumeForOutput` 的 `reduce` 用 `free > best` 比较，`fsSize()` 给出 `size: NaN` 时 `NaN > NaN` 恒 false → **原样保留第一个 NaN 卷**，界面报「剩余 NaN GB」。`freeOf` 对非有限值返回 `-Infinity` |

同批还修了：`formatAnswers` 缺 `options` 时抛错（工具循环 resolve 路径上，会让整轮对话挂掉）、
CSV 单列表格里一个制表符把整表劈成两列、会话/消息重复 id 未去重（一次删除作用到两条）、
`renderMarkdown` 里 `<proposed_plan>` 无限递归、回收站 7 天清理误删同组未过期任务、
world-state 时间按"跨天"节流（15:30 仍告诉模型"现在是 09:00"）、历史习惯提示因排序整条消失。

**新增测试（本批）**：`bad port` 1、框架更新 HTML 1、等响应头超时 1、内容过滤不可序列化 1、
选择题缺字段 1、CSV 分隔符 4、会话 id 去重 2、画幅负数 1、磁盘 NaN 2、browserFetch 守卫 4、
SSRF 尾点 2 + 通配 DNS 5、SSH accept 竞态 1 + 迟到 close 1 + exec 超时 1。

**探针自身的坑（三续）**：
- 测「xlsx 预览输出多大」时，必须**同时**验证提示文案有没有被当成数据行——
  只看体积会漏掉这个语义回归（体积降了，但表格多出一行怪文字）。
- 验证正则是否退化，要用**前缀完整但不闭合**的输入（`<li class="b_algo"><h2><a href="x">`
  重复 2 万次）。只重复开头的 `<li class="b_algo">` 只会命中第一段惰性匹配，得不到 O(n²)。
- `webRequest.onBeforeRequest` 是**单监听器**语义（重复注册即覆盖），
  所以给测试注入 resolver 时可以放心重新安装。






## 第八批（365 → 201 笔；探索期 2026-10-19 22:20 → 10-20 11:46）

主线是**「工具 schema 的硬校验把整轮静默打死」**——这一批把它从"逐个救火"变成"系统扫一遍"。

**判据（写进注释与测试）**：*只要代码本来就能自动纠正（夹紧 / 截断 / 归一 / 补全），就不该做成 schema 硬校验。*
AI SDK 在 `parseToolCall` 阶段校验失败时**只把 toolCall 记进历史、不执行**——
`onToolExecutionStart/End` 都不触发，模型收不到回执，于是反复重试同一条，**20 步预算烧光**，
而界面把原因归成"参数被上游截断"（完全误导）。mock 上游探针能稳定复现"连续 20 次没执行"。

| 类型 | 具体问题 |
|---|---|
| **空/缺字段被拒** | 四个产物工具的 `name` 是 `z.string().min(1)`：模型说"刚才那个文件"时传空串 → 1 次 create + **19 次空转**、步骤条一片空白。改为放宽 + execute 回可纠正说明。同类：`create_file` 的 `content`/`name`/`kind`、`update_plan` 的 `step`/`status`/`plan`、`request_user_input` 的 `header`/`question`/`label`/`description`/`questions`、`open_page` 的 `url`、`edit_artifact_batch` 的 `edits` |
| **`.optional()` 不收 null** | 只允许 `undefined`。`explanation: null` / `multiSelect: null` 会让 zod 拒掉**整个对象**。改 `.nullish()` + execute 归一 |
| **带单位的数字** | `z.coerce.number()` 遇 `"8 秒"` / `"2 路"` / `"第 3 行"` 得 `NaN` → zod 拒 → `generate_video` 连续 20 次没执行。新增 `toFiniteNumber()`（取文本里第一个数字），schema 改 `z.union([number, string])` |
| **拒绝被显示成成功** | 放宽后新增一类回执（"搜索关键词是空的…"），不含"失败"二字，`isToolFailure` 一律打勾、摘要编出「步骤清单已更新」等假成功。新增 `REJECTION_RE` 并**锚定回执开头**（裸 `/是空的/` 会把搜索结果标题 `[1] 为什么杯子是空的` 误判成失败——本会话自引入的误报，已修） |
| **同 step 竞态** | `create_file` 的落盘在 `artifactWriteQueue` 里，而 `inspect_artifact`/`edit_artifact` 的**解析在队列外** → 并行时自检报「找不到产物」。`edit_artifact` 更隐蔽：解析与读改写是**两次排队**，中间可插入 `create_file` 落成新版本，于是改到旧版、界面无变化。两者都收进**同一个队列条目**（注意不能调 `resolveArtifactQueued`，会自己等自己） |
| **编码探测漏了三处** | `attachment:read` 只认 UTF-8/GBK，记事本「Unicode」= UTF-16LE+BOM 会被 GB18030 解成乱码（不报错）。修完后发现**产物预览 / 智能体读写 / h3preview 三条路径各写了一遍**，共用 `modules/textFile.ts` 的 `decodeTextBytes` / `decodeTextPreview` |
| **行数/行尾** | 文件以换行结尾时 `split("\n").length` 多算一行（回执"共 4 行"、编辑器里 3 行；恰好 400 行的文件被误报"还有 1 行没显示"）。新增 `countLines()`。CRLF 文件的按行读回把 `\r` 藏在行尾，模型照抄必 not-found → 新增 `splitLines()` 从源头去掉（`closestLines` 是第三处） |
| **半截产物真的落盘** | 围栏只认三个反引号：四个反引号包住三个反引号（正文里教别人写代码块）会在内层提前闭合 → 一个含代码示例的 html 被截成 32 字符并**真的落盘**成坏卡片。`markdown.tsx` 与 `App.tsx` 的 `codeFences` 都改成「闭围栏长度 ≥ 开围栏」 |
| **CRLF 整篇识别失败** | 新写的 `^…$` 围栏正则里 `.` 与 `$` 都不吃 `\r`（**本会话自引入的回归**）→ CRLF 内容下围栏/标题/表格全部不认。两处解析入口统一 `replace(/\r\n/g, "\n")` |
| **其他** | 方案块紧跟段落（无空行）被并进段落 → 标签按字面显示、卡片不出；` ```xlsx ` 里放制表符数据判不出表格（卡片消失）；两道题同 `id` 时后一题顶用前一题的答案；`[x](https://…/Foo_(bar))` 链接被截断；搜索摘要截断切开 emoji；`isPathInside` 把 `..报告.html` 当越界（4 处同源）；产物已删除时说成"不在产物目录内"；空文件回"共 1 行 + 一行空白"；行号超末尾无提示；脏 `artifact.kind` 让预览面板一片空白；搜索 API 失败不回落浏览器渲染；`describeError` 把业务异常/HTML 错误页都说成"网络连接失败" |

**结论**：`npm test` **789 项 / 43 文件**全绿；typecheck、build 通过；
E2E test-01…test-10 逐个复跑全过；`probe-pelican-loop`（写→自检→读回→改→再自检）、
`probe-same-step-create-inspect`、`probe-schema-question-field`、`probe-missing-content`、
`probe-plan-missing`、`probe-schema-duration-str` 等 mock 上游探针全过。

**探针经验（本批新增）**：
- **断言要落在"上游收到的工具回执"上**，不是气泡文字：气泡默认折叠只显示摘要，中间回执看不到；
  而"是否被静默跳过"正是由回执决定的。
- **mock 收到回执后要能改口**：只重发同一条坏参数会让"修复后"看起来仍像失败（其实回执已送达）。
- 探针里复刻产品逻辑时，**复刻的是"当前源码"而不是"记得的源码"**——
  本批有一次用旧逻辑写探针，报出来的"失败"其实是探针没跟上改动。
