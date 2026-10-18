---
name: playground-branch-status
description: v0.2.1 已发布；2026-10-18 探索模式连续修复，290 笔未推送（HEAD 722da58）
metadata:
  node_type: memory
  type: project
  originSessionId: c43a4719-8f9f-4185-b161-9cd51af6a1ae
  modified: 2026-10-18T08:53:00.000Z
---

**状态（2026-10-18 探索模式进行中）：工作区干净，`feature/agent-iteration` 领先 `main` 290 笔（未推送）。**

- `v0.2.1` 已发布（Release 含 latest.yml + setup exe + blockmap 三件套）。
- HEAD = `722da58`。
- 验证基线：`npm test` **464 项 / 36 文件**全绿；typecheck、build 通过；
  E2E test-01/02/03/04/05/06/07/08/09/10 逐个复跑通过。

- `v0.2.1` 已发布（Release 含 latest.yml + setup exe + blockmap 三件套）。
- HEAD = `9639b6c`。
- **本轮 54 笔未推送**（等用户确认；逐笔见 `git log main..HEAD`）。

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




