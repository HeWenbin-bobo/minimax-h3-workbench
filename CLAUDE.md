# MiniMax H3 工作台 — 项目工作规则

本文件用于约束本仓库的默认开发流程，目标是减少重复沟通、减少返工。**如果本文件里写的和仓库里实际的脚本、工作流、代码对不上，以实际能跑的为准，并顺手把本文件改对，别让规则越写越离谱。**

## 项目背景速览

- **目录布局**：本文件在**仓库根目录**（`git clone` 后就在项目根）。作者本机是在一个工作目录里
  放 `repo/` 子目录当仓库，但**换机 clone 后只有一层**，直接以仓库根为基准即可，不用找 `repo/`。
- **仓库**：https://github.com/HeWenbin-bobo/minimax-h3-workbench（fork 自 francoeur003，已移除原作者署名）。
- **AI 协作资产**：`docs/ai-collab/`（说明 + Claude 记忆 + Codex 考古结论）、`tools/probes/`（E2E 探针）。
  换机起步看 `docs/ai-collab/README.md`。
- **技术栈**：Electron 43 + React 19 + TypeScript 7 + Vite 8，主进程 `src/main/`、渲染端 `src/renderer/App.tsx`（单文件应用）、共享类型 `src/shared/`。
- **架构**：四个生成后端（local/ssh/minimax/rb）通过 `adapterRegistry.ts` 统一接入，实现 `GenerationAdapter` 接口（test/generate/cancel）；`generationOrchestrator.ts` 管任务生命周期，`settingsStore.ts` 管设置与 safeStorage 加密密钥。
- **验证命令**：在**仓库根**执行 `npm test`（Vitest）、`npm run typecheck`、`npm run build`——三项全绿才算完成。测试数量随迭代增长，以实际输出为准，勿照抄旧数字。

## 仓库结构与职责

均在**仓库根**下。

- 入口：`index.html` → `src/renderer/main.tsx` → `src/renderer/App.tsx`（渲染端）；`src/main/main.ts`（主进程，`package.json` main = `dist-electron/main/main.js`）；`src/main/preload.ts`（IPC 桥）。
- `src/main/backends/`：`adapterRegistry.ts`（后端注册与选择）、`comfyAdapter.ts` / `sshComfyAdapter.ts` / `minimaxAdapter.ts` / `rbAdapter.ts`（四后端）、`workflows.ts`（FL2VA / Ref2VA 工作流）。
- `src/main/modules/`：`generationOrchestrator.ts`（任务生命周期）、`settingsStore.ts`（设置 + safeStorage 密钥）、`llmService.ts`（智能体对话）、`browserFetch.ts`（隐藏窗口渲染）、`webSearch.ts`、`autoUpdater.ts` / `updateChecker.ts`、`agentMemory.ts` / `compaction.ts` / `contextBudget.ts` / `errorRecovery.ts` / `stepSnapshot.ts` / `worldState.ts`（智能体 harness）、`safePath.ts` / `previewCsp.ts`（安全）。
- `src/shared/`：`types.ts`（含 `GenerationAdapter` 接口与 IPC 载荷）、`agentPrompt.ts`（提示词）、`agentVersion.ts`（自动生成，勿手改）、`modelWindows.ts`、`capabilities.ts`、`errors.ts`、`planMode.ts`。
- `src/renderer/`：`App.tsx`（六页应用：ready/studio/playground/downloads/guide/connections）、`markdown.tsx`、`styles.css` / `light.css` / `theme.ts`。
- `.e2e/`：CDP E2E 套件与探针；`scripts/`：构建期脚本；`docs/`：`ARCHITECTURE.md` 与演示素材；`.github/workflows/build.yml`：CI。
- 测试：`src/**/*.test.ts`（Vitest 单测）+ `.e2e/test-*.mjs`（E2E）；`*.test.ts` 与被测模块同目录。

## 常用命令

均在**仓库根**执行。

```bash
# 开发与构建
npm run dev            # Vite + 主进程 tsc watch + Electron 热启动
npm run build          # clean + typecheck + vite build + 主进程 tsc（prebuild 自动同步 agentVersion）
npm run typecheck      # 渲染端 + 主进程双 tsc --noEmit
npm test               # Vitest 单测（npm run test:watch 监听模式）
npm start              # build 后直接跑 Electron

# 打包与发版
npm run package:win    # Windows NSIS 安装包（--publish never）
npm run package:mac    # macOS dmg + zip (arm64)
npm run release:win    # Windows 打包并发布（--publish always，仅发版时用）

# E2E（.e2e/，CDP 裸协议；探针加载 dist 产物，改完代码必须先 npm run build）
node .e2e/test-01-nav.mjs        # 逐套件单跑（test-01 … test-10）
node tools/probes/probe-preview.mjs  # 取证探针（已入库，见 docs/ai-collab/README.md）
```

- CI 证据：`.github/workflows/build.yml`（test → package → release 三 job）。本机未装 `gh` CLI，查 CI / Release 走 GitHub API + curl（见「发版流程」）。

## 默认工作流

1. 先判断这是什么任务：`fix / feat / refactor / docs / chore / test / review`。
2. 先把现有代码、配置、测试、脚本、工作流、文档读一遍，再动手改。
3. 判断这次要动哪块：主进程 `src/main/` / 渲染端 `src/renderer/` / 共享类型 `src/shared/` / 适配器 / E2E / 构建脚本 / `.github/workflows/` / 文档。
4. 先看是不是碰到了容易出事的地方：设置和密钥存储（`settingsStore` / safeStorage）、适配器接口（`GenerationAdapter`）、IPC 通道和路径白名单（`h3media` / `shell:showItem` / `shell:openExternal`）、产物落盘（`saveArtifactFile`）、自动更新链路、发版流程、智能体提示词和工具定义。
5. 只改跟这次任务直接相关的，别顺手带无关的重构；默认优先保证稳定，不图"顺手优化一下"。
6. 优先复用已有的模块、配置入口、脚本和测试，别另起一套。
7. 改完按「验证与测试边界」跑检查。
8. 交付时默认说清：改了什么 / 为什么这么改 / 验了什么 / 没验什么 / 有什么风险 / 出问题怎么退回去。

## 探索模式（用户说"进入探索模式"即自动执行）

**触发条件**：用户输入包含"进入探索模式"（或语义等价表述，如"进入12h探索模式"）时，**无需用户补充任何参数**，直接按以下固定任务开工：

> 进入 12h 探索模式，替我模拟人类操作测试一下所有功能看看（在目前支持的功能下进行，比如像本机还没有设置过本地部署，这个就不用进行测试了）。请你自主修复遇到的 bug，尽量用真实 key 进行一下测试。

**执行要点**（历次探索模式的成熟做法）：

1. **模拟人类操作**：用 `.e2e/driver.mjs`（CDP 裸协议）逐页遍历六个页面，真实点击/输入/切换；纯读代码不算测试。
2. **范围裁剪**：只测当前支持的功能——本机未配置的后端（如本地部署 ComfyUI、SSH 远端）跳过实测，只验证 UI 层不报错。
3. **真实 Key 测试**：走 `tools/harness.mjs` 克隆 userData 到临时目录（含 Local State），密钥只在进程内解密、**绝不打印**；游乐场对话、视频生成、联网搜索都发真实请求。
4. **遇到 bug 自主修复**：先复现取证（探针脚本存 `tools/probes/`），修完跑 `npm test && npm run typecheck && npm run build` 三件套 + 对应 E2E 探针，全绿后按提交规范 commit。
5. **探索产出**：结束时汇报发现的问题、修复清单与仍未验证的边界，更新记忆文件。

## 保存项目进度（用户说"保存项目进度"即自动执行）

**触发条件**：用户输入包含"保存项目进度"（或语义等价表述，如"存一下进度""更新一下记忆""把这次的收获记下来"）时，**无需用户补充任何参数**，直接按以下固定任务开工：

> 保存项目进度，把这次会话新学到的内容与规则更新到本项目的 CLAUDE.md 等相关文件里。

**执行顺序**（每次固定，别跳步）：

1. **先查真实状态，不要凭印象写**：
   ```bash
   git status --short                 # 必须干净；有改动先问，别顺手带上
   git log --oneline -5
   git describe --tags --abbrev=0
   npm test 2>&1 | tail -4            # 数字以实际输出为准
   ```
   记忆里写的 HEAD / 提交数 / 测试项数 / 版本号一律以命令输出为准。**过期的数字比没有更误导**。

2. **更新仓库内的记忆**（`docs/ai-collab/memory/`，**入库**）：
   - `playground-branch-status.md`：当前状态（版本、HEAD、与 `main` 差多少、验证基线）+ 本轮修复主题表。
     **同类问题并进已有小节，不要每轮新起一个"第 N 批"**；历史内容不删（见「文档与协作约定」），
     只在旧内容被新实测推翻时，就地标注"已修正：…"并写清原因。
   - `MEMORY.md`：索引行同步（标题 + 一句话 hook），**不要塞正文**。
   - 主题性结论（"某类 bug 的根因模式"）写进对应的专题记忆文件，别全堆在 branch-status 里。

3. **更新本文件的规则**（只有确实学到**新规则**才改）：
   - 新踩的坑 / 新约定 → 补进**最相关的那一节**（发版流程 / 验证与测试边界 / 调试纪律 …），
     不要另起一节复述已有内容。
   - **实测数字必须带条件与方法**（"40 次冷连接实测 p95≈6.4s"），不能单抛一个数。
   - 改完自己通读一遍：新旧规则有没有互相矛盾？有就以新实测为准，并写清为什么改。

4. **同步工具侧记忆**（`~/.claude/projects/<项目>/memory/`，**不入库**）：
   与仓库记忆同主题的文件保持一致；**只属于本机环境**的东西（绝对路径、私有中转地址、工具 hооk 行为）只放这边。

5. **提交**：`docs: 同步项目进度到 <版本/日期>`，正文写清这次记下了哪些结论、为什么值得记。
   **不要**在同一笔提交里夹带代码改动——进度保存是独立的一步。

6. **交付**：几句话说明「更新了哪几个文件 / 新增或修正了哪些结论 / 哪些是以实测为准改的」。
   不写"已更新记忆"这种没有信息量的话。

**别做的事**：

- 不要把 git 历史里能直接查到的东西（提交清单、某次改动的逐行细节）抄进记忆——那是重复。
- 不要为了让记忆"看起来完整"编数字；查不到就写"未验证"。
- 不要顺手改本文件里与本轮无关的章节。

## Git 提交与推送规则

**大文件红线**：任何大于 95MB 的文件不得 commit（GitHub 硬限制单文件 100MB）。
- 提交前抽查 `git status`；安装包、模型权重、构建产物不入库（`.gitignore` 已覆盖 `release/`、`dist/`）。

**依赖与环境不入库**：`node_modules/` 禁止暂存。

**瞬态状态不入库**：仓库工作区常驻未跟踪杂物 `.omc/`、`.claude/`、`.smoke-userdata/`、E2E 取证脚本与输出（`probe-*.mjs`、`probe-*.js`、`verify-*.mjs`）——**一律勿提交**；`git add -A` 后抽查 `git status --short` 确认它们未被暂存。`.gitignore` 已覆盖上面这些模式；**新增其它命名/扩展名的临时文件时要顺手补进 `.gitignore`**（2026-10-17 就漏过 `probe-*.js`，靠人肉记着容易忘）。

**提交信息怎么写**：`feat:/fix:/chore:/docs:/test:` 前缀 + **中文标题**（和仓库现有历史一致，可带作用域如 `fix(ci):`）+ 中文正文分块说明。写清用户能感觉到的变化，不写"修复若干问题"这类含糊话。正文建议按「问题 / 原因 / 怎么修 / 怎么验」分块（参考近期的 `fix:` 提交）。AI 协作的提交保留 `Co-Authored-By: Claude …` 尾注（本项目历史一直这么做）。

**Git 命令边界**：可以用 `status / diff / log / add / commit / push / tag`（直接提交到当前分支）；`reset / rebase`、强制推送、删历史**必须用户明确说了才能做**。

**分支与 PR 习惯**：功能/修复在 `feature/*` 分支上做，合并回 `main` 用 `merge:` 提交（如 `merge: feature/playground — …`）；`main` 上只留 `chore: bump version` 这类收尾提交。开始合并/PR 相关任务前，先确认当前分支和目标基线差多少，不要擅自切分支或改写历史。

### 分支合并约定（每次 feature/* → main 都要这么做）

**先把这个分支上的零散提交并成一条，再合进 `main`**——不要几十条"改一下""再改一下""修个错字"
原样塞进 `main`。

1. **先把同一批工作的提交并成一条**（squash），再合进 `main`。
   目的：`main` 的历史要能一眼看懂"这一批做了什么"，而不是被过程性提交淹掉。
2. **并完的那条提交信息要说清「这堆提交合起来做了什么」**：
   - 按**模块/主题分块**列要点（不要罗列原始提交标题，那是流水账）；
   - 写清**用户能感觉到的变化**，不写"修复若干问题"；
   - 如果这批是在修 bug，按「问题 / 原因 / 怎么修 / 怎么验」分块。
3. **不用并的情况**：本来就是一个改动、只有一条提交；或者提交已经推送出去、别人可能引用了
   （改写历史要用户明确批准）。
4. 合并后交付说明里给出**这批提交的清单**（原来的提交哈希 → 并完之后对应什么内容），方便回溯。

> 教训（2026-10-17）：v0.2.1 那次把 36 条提交原样合进 `main`，里面好几条是"修上一条的修复"，
> `main` 历史很难看。这条约定从那之后生效。

**手动打 tag 用 annotated tag**（`git tag -a vX.Y.Z -m "…"`），不要用轻量 tag——
Release 说明和 `git describe` 都靠它。

**提交/PR 标题不要带工具前缀**：不写 `[codex]`、`codex:`、`[claude]`、`autocode`、`copilot`。
标题只说改了什么，用什么工具改的是过程，不是改动本身。

**分支操作前先同步基线**（借鉴 AGENTS.md §8）：开始合并 / PR 相关任务前，先查工作区状态并
`git fetch --all --prune`；若工作区干净且当前分支可 fast-forward，则 `git pull --ff-only`。
**若存在本地改动、冲突状态或未跟踪风险文件，不得强行切分支、stash、reset 或覆盖本地状态**——
应说明当前 HEAD 与目标基线的差异，必要时请用户确认后再推进。

**一次性取证产物不入库**：E2E 截图、探针脚本与输出、审查/验收截图等临时可视证据，
一律放本地的 `_scratch/`（不入库）或作为对话中的证据，**不作为仓库文件提交**。
产品长期文档确需保留的示意图除外，但文件名与语义必须脱离具体 issue/PR 编号。

## 文档与协作约定

- 用户能看到的功能、配置项、后端适配器、产物结构或界面形态有变化时，相关文档要跟着改。
- 加了新配置项，`.env.example` 和相关文档要一起更新。
- `README.md` 只放项目是干什么的、主要能力、怎么快速开始、主要入口这类首页信息；不必要就别改，免得越写越长。
- 具体到某个模块怎么运作、页面怎么交互、专题怎么配、出问题怎么查、字段是什么意思、边界情况怎么处理——这些写进 `docs/*.md` 或专题文档，**不要塞进 README**。
- 引用实测数字要写清怎么测的、测了多少次（比如"40 次冷连接实测 p95≈6.4s"），不要脱离条件单抛一个数。
- **不要删或覆盖 `docs/` 和历史记录**；发现以前的数字跟现在对不上，先去翻 git 历史再下结论，不要拿现在的代码去猜当时为什么那么做。

## 发版流程（推 tag 就等于发版，有五个坑）

发版 = 改版本号 → 提交 → 打 tag `vX.Y.Z` → 推 tag → **CI 没自动跑就手动触发** → 等跑完 → 把草稿改成正式发布 + 写发布说明。

1. 改 `package.json` 的 version → 提交 `chore: bump version to X.Y.Z` → `git tag vX.Y.Z` → `git push origin main vX.Y.Z`。
2. **坑① 这个 fork 推 tag 不会自动跑 CI**：得手动触发。本机没装 gh，用 GitHub API + 已存的 git 凭据：
   ```bash
   TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | grep "^password=" | cut -d= -f2-)
   curl -X POST -H "Authorization: Bearer $TOKEN" \
     "https://api.github.com/repos/HeWenbin-bobo/minimax-h3-workbench/actions/workflows/build.yml/dispatches" \
     -d '{"ref":"vX.Y.Z"}'
   ```
3. **坑② 打包工具只往"草稿"Release 传文件**，已经发布的会被悄悄跳过（v0.1.8 就出过这事：Release 建了但没文件）。CI 会先建草稿，最后由人手动改成正式。
4. **坑③ 同一个 tag 并发上传会把文件拆到两个 Release 里**（v0.1.8 事故）。所以别自己提前建 Release，让 CI 建。
5. **坑④ 发布说明要自己写**：标题统一 `MiniMax H3 工作台 vX.Y.Z`，正文用中文写这次更新了什么（从 git 提交整理），**不要用 CI 默认那句"自动构建发布"**。改成正式发布用 PATCH `draft:false` 带上正文。Windows 下 curl 传中文 JSON 要用 `--data-binary @file.json`，否则转义会出错。
6. 发完检查：`releases/latest` 返回的是新 tag，且附件有 `latest.yml` + setup exe + blockmap 三个（`latest.yml` 是应用内更新要读的，少了自动更新就失效）。

**坑⑤ 发版前测试必须在 Linux 上验一遍**（2026-10-17 v0.2.1 踩到）：CI 的 test 跑在 Linux 上，
本机是 Windows，**本地全绿不代表 CI 会绿**。`safePath.test.ts` 就是因为靠链接名结尾猜链接类型，
在 Linux 上失败（Windows 走了另一条分支把问题盖住了），第一次触发就红了。

- 如果这轮改过**跟文件系统、路径、符号链接、大小写、权限有关**的测试，先在 WSL 上跑一遍：
  ```bash
  wsl -e bash -lc "node /mnt/<盘符小写>/<仓库路径>/tools/probes/<验证脚本>.mjs"
  ```
  （Windows 装的 `node_modules` 在 Linux 跑不了，不能直接 `npx vitest`；写个纯 node 脚本对照即可。）
- **如果 tag 推了、CI 红了、而且没生成任何 Release**，可以把 tag 挪到修好的提交上：
  删远端 tag（`git push origin --delete vX.Y.Z`）→ `git tag -f` → 再推。
  **前提是先确认这个 tag 真的没生成过 Release**（`GET /releases/tags/vX.Y.Z` 返回 404）；
  要是已经发出去过，那就是覆盖已发布内容，得用户明确同意。
- 每次手动触发后，先看 test 那一步绿没绿，再看打包和发布——早点发现问题。

## 自动更新链路

- `updateChecker.ts` 读 `UPDATE_REPO` 常量 → GitHub Releases latest API；`autoUpdater.ts` 走 electron-updater 读 `build.win.publish` 配置。**两者必须指向同一仓库**。
- 改仓库名或转移 fork 时同步改这两处 + `package.json` repository 字段。

## 后端适配器约定

- **不要把密钥、账号、模型名、端口写死在代码里**，也不要在代码里判断"本地/线上环境"；确实需要固定不变的值（比如 `updateChecker.ts` 里的 `UPDATE_REPO`）就集中放一处，写清用途，别到处散着。
- 加一个新后端要改这几处：`BackendKind`/`SecretName` 联合类型 + 新建 adapter 文件 + registry 里加分支 + settingsStore 默认值 + App.tsx 四处（下拉框 / label / 连接卡片 / 费用文案）——照着 `feature/rb-backend` 分支的历史做。
- **云后端的网络请求统一带超时 + 重试**（参考 rbAdapter 的 `fetchWithRetry`）：站外服务（Cloudflare 这类）冷启动很慢，实测 rb.coolhs.com 的 p95 约 6.4 秒，用 8 秒裸超时会时不时失败。
- **提交类的 POST 不要自动重试**（没法确认服务端是不是已经建了任务，重复提交会重复扣次数）；查询/下载类的可以重试一次。
- 站点没有取消接口时，`cancel()` 就写成空操作（no-op）并加注释说明。

## 验证与测试边界

**底线**：单测全绿 + typecheck 通过 + build 通过，三者缺一不提交。

- **本机的 Electron 冒烟测试用不了**（GPU 栈坏了，用 `git stash` 对照确认过不是代码问题），所以验证靠单测 + typecheck + CI。
- 改适配器/工作流必须配单测（照着 `workflows.test.ts`、`comfyAdapter.test.ts` 写）；纯界面布局改动可以不配。

**按改的地方决定要跑什么**（PR 上已有 CI 结论就直接引用；CI 没覆盖到的，要说明本地验了什么、还有什么没验）：

- 主进程 / 模块（`src/main/**`）：跑 `npm test` + `npm run typecheck`；如果动到任务生命周期、设置存储、产物落盘、自动更新、IPC，交付说明里要写清验了哪条路径。
- 渲染端（`src/renderer/**`、`src/shared/**`）：跑 `npm run typecheck` + `npm run build`；涉及布局、拖拽、预览、键盘焦点的，**必须跑 E2E 探针**（这类 bug 读代码看不出来）。
- 适配器 / 工作流（`src/main/backends/**`）：必须配单测；改网络请求要确认超时、重试、失败降级、取消这几条路还都对。
- 提示词 / 工具定义（`src/shared/agentPrompt.ts`、`src/main/modules/llmService.ts`）：必须**用真人会说的话跑一遍真机**（合成指令测不出"模型自我怀疑"这类问题），并说明验了哪些工具触发场景。
- 构建 / 发版 / 打包（`scripts/**`、`.github/workflows/**`、`package.json` scripts）：说明影响了哪条流水线、发布或部署路径；没真跑过打包 / Actions 的，要写清原因和可能的风险。
- 纯文档改动（`docs/**`、`*.md`）：不强制跑测试，但要把命令、配置项、文件名、工作流名字跟仓库实际对一遍。

## 改动时要守住的东西

- **配置和启动方式**：改设置的含义、默认值或启动方式时，主进程 / 渲染端 / 打包后的产物 / 自动更新这四条路都要想一遍。新配置尽量做到"不配也能跑，配了更好用"，别搞一堆互相排斥的开关。
- **后端和失败降级**：改 `adapterRegistry.ts` 或任一 adapter 时，注意后端优先级、失败后换哪个、字段怎么统一、超时和取消怎么处理。一个后端挂了不该把整条生成流程拖垮，除非明确要求"挂了就直接报错"。
- **IPC / 类型 / 兼容**：改 `src/shared/types.ts` 里的 IPC 数据或通道时，主进程、preload、渲染端**三处都要改**；尽量只加字段、保留旧字段或做兼容，别让老版本悄没声地坏掉。
- **产物 / 提示词 / 工具定义**：改产物结构、提取器、提示词或工具定义时，检查上下游（卡片渲染、预览面板、`saveArtifactFile`）还配不配得上。
- **外部调用必须自己加超时**：上游接口挂住会把整条降级链拖死。云后端请求走 `fetchWithRetry` 里的 `AbortSignal.timeout(timeoutMs)`（和取消信号合并），超时就当失败换下一个后端，成功路径不变；**不要让 `fetch` 裸等**（站外服务冷启动很慢，实测数据见「后端适配器约定」）。
- **"提示/说明"不能塞进下游要解析的数据里**：v0.3.0 修 xlsx 预览上限时，把「表格共 N 行，仅显示前 2000 行」拼在了返回的 CSV 末尾，渲染端拿它直接 `parseCsvRows` → 那句话变成**表格里的第 4 行假数据**。凡是"正文 + 附带说明"的返回，都用结构化字段分开（`{ text, note? }`），不要用字符串拼接。
- **同一个判定写了两处，就要一起改**：v0.3.0 给 SSRF 校验修了 `localhost.` 尾点，但 `resolveChatPath` 里还有一份 hostname 精确比对没修 → `api.minimax.io.` 走了错误端点（404）。改"按 hostname / 扩展名 / 字段名精确比对"的逻辑前，先 grep 一遍同一个字符串还有谁在比。

## 安全红线

- **卡密/API Key 只存 safeStorage 加密的 secrets.json**，绝不入库、绝不打印、绝不硬编码。
- **任何 Key 不得上传 GitHub（用户明令）**：用户测试或使用时输入的所有 Key（MiniMax API Key、瞬映卡密、游乐场 LLM Key、搜索 API Key、SSH 私钥等）一律不得进入 commit/push。提交前必查 `git status` 与 `git diff --cached`；`secrets.json`、`*.key`、含 Key 的日志/截图/临时文件一律排除。密钥只存在于本机 `%APPDATA%` 下的 Electron userData（safeStorage 加密）。
- `h3media` 协议与 `shell:showItem` 已做路径白名单（输出目录/ComfyUI 模型目录），改动这两个 IPC 时必须保持防护。
- `shell:openExternal` 只允许 HTTPS 链接。
- 渲染端 sandbox: true + contextIsolation，勿放开。

## 收到反馈后怎么改

被指出问题后，**不要只把被点名的那几行改掉就说"已修复"**。先把人家到底在说什么搞明白，
再检查同一个问题在别处是不是也存在。

按这个顺序来：

1. 把对方指出的问题一条条列出来。
2. 说清**为什么会这样**，不要只说"我改了哪几行"。
3. 找出同一个问题还影响哪些地方（主进程 / 渲染端 / IPC / 提示词 / 产物 / 测试 / 文档）。
4. 把这一整块改对，而不是只让当前那个测试通过。
5. 补一个能证明"对方举的反例确实不会再出现"的测试；做不到就明说为什么做不到。
6. 如果改不完，就说清需要拆开做 / 推倒重来 / 先缩小范围，**别硬堆补丁，也别声称可以交了**。

下面这些做法不行：用一个大而全的兜底逻辑或"出错就返回空"来掩盖没想清楚的情况；
测试只测无关紧要的部分、绕开真正会出问题的地方；声称问题已解决但没有验证对方举的反例。
**测试通过只说明自动检查过了，不等于问题真的解决了。**

## 长会话工作纪律（v0.1.11 的教训）

- **写大文件前先在脑子里把内容过一遍再动笔**；输出里出现乱码、重复、夹外语这类损坏迹象时，
  **立刻停下**，用 `git checkout -- <file>` 恢复，改成小块 Edit 一段段改。
- 每次 Write/Edit 大文件后都用 `git diff` 看一遍再提交；坏掉的内容绝不能进提交。
- 长会话（超过 30 万 token）写大文件容易坏，小块 Edit 更靠谱。

## 调试与验证纪律（游乐场"空回复"连环 bug 的教训）

- **能从别的配置推出来的值，不要存进设置**：比如对话端点路径能从 baseUrl 推出来，就每次现算，
  绝不持久化——存下来的旧值在用户改上游地址后会变成脏数据。
- **出错必须让人看见**：异步/流式的操作（LLM 对话、视频生成）失败时，错误文案必须显示到界面上
  （气泡/卡片），主进程和渲染端**都要兜底**——渲染端收到失败事件但气泡是空的时候，也要写上错误文案。
  绝不允许"请求失败了，但界面一片空白"。
- **改完界面一定要截图看一眼真实效果**：CSS 继承这类问题（比如浅色底上写了白字）读代码看不出来，
  截图看才能确认字能不能看清。
- 用户说"空回复"时，先复现主进程发的真实请求，再看渲染端怎么显示的——两边都可能把错误吞掉。

## 其他约定

- **注释少而精**：解释"为什么"，不复述"是什么"。
- UI 文案、错误提示一律中文（面向最终用户）。
- 回答尽可能少创造新词；引用实测数据时注明样本量与条件（如"40 次冷连接实测 p95≈6.4s"）。
- 不删/不覆盖 `docs/`、历史 Release 资产；发现历史数字与现状不符时先查 git 历史再下结论。
- **不要擅自改本 CLAUDE.md**：要改先由 Claude 提草案，用户确认后再写进去。
  例外：用户说「保存项目进度」时，按上面那节的流程**按需**更新（这是用户已授权的固定流程）；
  其余改动仍需先提草案。
- **督促任务**：用户下达督促任务后，每次回答都要提醒该任务尚未完成，直到用户解除。

## 关于 AGENTS.md（**别照搬，那是另一个项目的**）

`docs/ai-collab/AGENTS-reference.md` 属于**另一个项目**——一个 Python 写的股票分析系统，
讲的是 `src/core/`、`data_provider/`、`api/`、`bot/`、`apps/dsa-web/`、`main.py` 那套东西，
跟这个 Electron 项目没关系。**本项目的规则就看这份 CLAUDE.md。**

已经从它那里挑了几条通用的原则搬过来（就是上面那几节）：改动好坏看什么、下结论要有证据、
分支合并约定、提交标题规范、长会话纪律、调试与验证纪律。

**有三处它说的和这里冲突，以这份为准**：

1. 它要求「`CLAUDE.md` 必须是指向 `AGENTS.md` 的软链接」——**这里不这么做**。
   那是另一个项目的文件，把本文件改成指向它，**本项目所有规则就全没了**。
   本文件是独立文件，本项目的规则就看它。
2. 它要求 commit 里**不加** `Co-Authored-By` 尾注——**这里保留**（本项目历史一直带，
   而且用户没有要求去掉）。若要统一成它的做法，先问用户。
3. 它写的目录（`data_provider/`、`apps/dsa-web/` 等）和命令（`python main.py`、
   `./scripts/ci_gate.sh`）**这个项目里没有**，不要照着执行。

以后如果本项目也要引入 `AGENTS.md`，先定好以哪份为准再同步，别手工维护两份一样的内容
（这条原则本身是从它那儿学的，是对的）。

## 改动做得好不好，看什么

- **改得多、文件多、看起来完整，都不算好**。只看四件事：有没有解决明确的问题、
  改动是不是够小、有没有破坏原有的约定、有没有覆盖真正会出问题的地方。
- 用 AI 写代码没问题；有问题的是 AI 写完**没人看懂、没验证、没收尾**就交上去。
- 如果改了好几轮，还是反复出现「同一件事各处做法不一致」「到处写重复的兜底逻辑」
  「测试只测了无关紧要的地方」，就主动说「这块得拆开做 / 推倒重做 / 先把范围缩小」，
  别再零敲碎打。

## 下结论要有证据

- **测试显示「通过」不等于真的测到了**：先确认测试的前提真的发生了。
  实测教训：中转返回空时，「没有额外生成视频」这条照样通过——因为模型压根没跑；
  OS 键盘测试也一样，窗口没真正切到前台时键打到了别处，测试却报失败。
  断言里要显式检查前提状态。
- **改了跟文件系统 / 路径 / 符号链接 / 大小写有关的测试，必须在 Linux 上再验一遍**：
  CI 跑的是 Linux，本机是 Windows，本地全绿不代表 CI 会绿。
  实测教训：`safePath.test.ts` 靠链接名结尾猜链接类型，Windows 上走了另一条分支掩盖了问题，
  导致 v0.2.1 第一次发版 CI 直接红。
  本机有 WSL Ubuntu + node 24（和 CI 同版本），写个纯 node 脚本跑一遍即可
  （Windows 装的 `node_modules` 在 Linux 跑不了，不能直接 `npx vitest`）。
- **根因既要读代码也要动手试**：本仓库已经三次出现「读代码看不出、一试才现形」的根因——
  没设输出上限导致大文件被截断、`srcdoc` 继承宿主 CSP 导致预览脚本不跑、
  `create_file` 把内容回灌进了历史。结论要基于复现，不要基于推测。
- **用户说「没反应 / 空结果」时，先复现真实请求，再查界面显示**——两头都可能把错误吞掉。
- **探针本身也会坏，而且坏了会骗人**（v0.3.0 一次会话里踩到 4 次）：
  对比度探针只看上一级背景色 → 把"透明黑"当底色，正常文字被算成 3.55:1（真值 5.57:1）；
  安全探针用页面内 `fetch` 取响应头 → 被宿主 CSP 挡掉，断言永远 FAIL 且"越界被拒"是**假 PASS**；
  UI 探针假设"点一次取消 = 4 路全取消"（实际逐任务）；
  正则退化探针只重复开头标签，得不到 O(n²) 的输入形状。
  **探针报出异常结果时，先怀疑探针**：用另一条独立路径（CDP 网络事件、真实 HTTP server、
  物理键盘）复核一次，再去改产品代码。改完产品后要确认探针**在新构建上**跑（`npm run build` 先）。
- **"测试写过了"不等于"改动真的生效"**：v0.3.0 给 xlsx 预览加了行数上限，探针只量了输出体积（降了），
  却漏掉"提示文案被当成表格数据行"这个语义回归——**量到指标变好，也要检查没把别的东西弄坏**。

## 智能体框架（游乐场）

- 用的是 Vercel AI SDK（npm 包 `ai` + `@ai-sdk/openai-compatible`）。它是 ESM-only——主进程产物是 CJS，所以**只能用 `await import()` 动态加载，不要写成顶部的静态 import**。
- 打包版本号在 `src/shared/agentVersion.ts`，由 `scripts/sync-agent-version.mjs` 在 prebuild/prepackage 时从 node_modules/ai 自动生成，**不要手改**；单独的更新检查走 `updateChecker.checkFrameworkUpdate`（查 npm registry）。
- 智能体一轮最多走 10 步工具调用（`stopWhen: stepCountIs(10)`）；工具的实现都由 main.ts 注入（webSearch→searchWeb，generateVideo→orchestrator.submit，openPage→renderHtml，createFile→saveArtifactFile）。
- **多会话并发**：`llm:chat` 带 `sessionId`，主进程按会话各存一份服务实例（`sessionServices`/`sessionAborters`），事件（chunk/done/tasks）都带上 sessionId 让渲染端知道该写哪个会话。并发守卫只挡**同一个会话**；`abortLlm(sessionId)` 只停那一个，不连坐。
- **`enableWebSearch` 这个开关有个坑**：`chatAgent(..., enableWebSearch)` 决定要不要把 `web_search` 工具给模型；`browserOnly` 只决定搜索怎么执行。**两个都要传**（`webSearch || browserOnly`），漏传任一个模型就会凭旧知识回答（实测表现是"该商品尚未发布"）。降级走普通对话时 `service.chat` 也要把 `browserOnly` 传下去。

## 智能体为什么"不够聪明"：是提示词没写好，不是引擎的问题（重要）

**实测结论**：同一个国产模型，接 Claude Code / Codex（用 cc-switch 挂到同一个中转）就是比接我们的
智能体"聪明"。差别在**提示词和工具描述怎么打磨**，不在引擎——AI SDK 的 `streamText` 工具循环
跟 Claude Code 的核心是同一套。三笔提交（`895d61c`→`5c11ab9`）把真机三个任务的通过数从 6/8 提到 8/8，
证明了这一点。

**两条铁律**：

1. **模型更信"有没有这个工具"，不太信你写在提示词里的话**。只在提示词里说"请用代码块输出"，
   模型会怀疑自己"没有写文件的工具"，然后道歉推脱（实测复现过两次）→ **要交付文件就必须做成工具**
   （`create_file`），提示词只负责规范行为。
2. **提示词要分层写**（照 Claude Code 的样子）：角色 → 有哪些工具（写清什么情况该用）→ 产物规范
   → 干活的方式（能动手就别问 / 复杂任务拆步骤 / 工具结果要消化 / 失败就换路 / 回答简洁）。
   工具的说明里**既要写什么时候用，也要写什么时候别用**。

**怎么验**：必须用**真人会说的话**跑一遍真机（比如"随便生成一个 excel 文件给我"），
不能用合成指令——合成指令测不出"模型自我怀疑"这类问题。

**待偷的 harness**：**已经全做完了**（2026-10-15/16 的 Codex 移植，8 笔提交）——① 上下文压缩
（`contextBudget.ts` + `compaction.ts`，自动 + 手动）② 计划模式（`planMode.ts`）③ 提示词再加厚
（`agentPrompt.ts` 分层 + `worldState.ts` 差异注入）。Codex 剩下的东西（guardian 审批流、
sandbox/worktree、rollout 事件记录）**这个应用里根本没有对应场景**，硬抄只会抄出一堆没人调用的空代码，
不要再试。

**为什么不换引擎**：Codex 本身不绑模型（config.toml 里 `model_providers` 可以接任意 OpenAI 兼容的地址），
但要接它得跑子进程/MCP server、我们的领域工具（generate_video 等）要重新挂一遍、安全边界也完全不同
（在一个聊天窗口里跑 shell 命令，那是另一个产品了）。收益抵不上成本。

## 产物系统（HTML / Excel / Word）

- 产物靠**消息里的内容**识别：`extractArtifact` 依次试三种（网页 > 表格 > 文档），一条消息出一张卡片。
- **`create_file` 存完文件只告诉渲染端"文件叫什么、在哪、多大"，不再把内容塞回消息里**（v0.2.1 修复）。
  以前是把整个文件内容当成代码块追加到回复里，有两个坏处：① 气泡里卡片和代码块重复显示一遍；
  ② **这段内容进了会话历史，每轮都重新发给模型**（几十 KB 的 3D 页面等于每轮白烧上万 token，
  还会提前触发压缩）。现在内容只在磁盘上，渲染端按元数据挂卡片，预览时用 `artifact:read` 现读。
  老的"扫代码块找产物"的路子**保留着**，用来兼容历史消息和模型直接把内容写在回复里的情况。
- **输出长度上限必须自己设**（v0.2.1 修复）：智能体那边设 `maxOutputTokens`，普通对话设 `max_tokens`，
  **两处都要设**（实测这个中转默认只有约 4096 token，差不多 17.5k 字符）。不设的后果很隐蔽：
  模型写大文件时输出被硬截断 → 工具参数 JSON 断成半截 → 解析失败 → 模型以为是"内容太长"，
  **反复重写、越写越短**，最后放弃。现在设成 64000。
- `create_file` 工具（智能体）与 `artifact:save` IPC（渲染端懒落盘）**共用 `saveArtifactFile`**（main.ts）——一处逻辑两条路径，改落盘规则只改这个函数。
- **文件名要能容错**：模型常传不带扩展名的名字（如"上海出行建议"），`saveArtifactFile` 按类型自动补——不补的话白名单校验会拒掉（实测出过"不支持的产物类型"这种假错误）。
- **代码块的语言标记有别名**：`create_file` 成功后回注的代码块用的是模型给的类型名，可能是 ```xlsx——提取器必须认得 xlsx/excel 这些别名，否则文件存下来了但卡片挂不上（实测 bug）。
- 表格走 SheetJS（`await import("xlsx")`）把 CSV 转成真 Excel 文件；文档存 `.md`（模型输出的本来就是纯文本，真 .docx 以后再说）。
- 预览面板：html→沙箱 iframe（**走 `h3preview:` 协议按 URL 加载**，见下节）；sheet→CSV 渲染 Excel 观感表格；doc→renderMarkdown 衬线文档排版。分栏三要素见「产物预览与文件卡片」节。

## 联网搜索链路（webSearch + browserFetch）

- 依次尝试：搜索 API → **用 Chromium 渲染 Bing** → 直接抓 Bing 网页 → 渲染/抓搜狗。实测直接用 fetch 拿 Bing 会**时不时降级成无关结果**（查 iPhone 价格返回别的东西），所以优先用渲染；老顺序（先直抓、拿到东西就算成功）会让准确结果永远轮不到。
- `browserFetch.ts`：借用 Electron 自带的 Chromium，开一个隐藏窗口渲染页面。**不引入 Playwright/Selenium**（浏览器二进制 130–170MB，会把安装包从 91MB 顶到 250MB 以上）。开窗排队防并发；独立 session 分区；退出时清缓存。
- **Electron 有个坑**：没有常驻窗口时，隐藏窗口一销毁就会触发 `window-all-closed`，进程**静默退出**（退出码 0，没有任何报错）。正式运行时有个常驻主窗口所以不受影响；但**独立的探针/脚本必须自己建一个"占位窗口"**，否则会被误判成"渲染崩了"。
- Node http 的 `req` close 在**请求体读完时就触发**（会误杀流式的定时器）；清理连接要挂在 `res` close 上。

## 游乐场状态与持久化

- 会话存在 localStorage 里（最多 50 个，按最近使用裁剪，**正在生成回复的会话绝不丢**）。
- **流式输出中途关掉应用，消息上会残留 `streaming: true`**：读会话时（`loadSessions`）要清掉——留着会让删除按钮的守卫失效（"点了删除没反应"），气泡也会一直闪光标。守卫判断用 `generatingIds`（真实状态）而不是消息上的标记，而且被拦住时必须弹提示，不能悄悄 return。

## E2E 测试（.e2e/）

- 驱动：CDP 裸协议（`driver.mjs`，零依赖）+ 独立的临时 userData；要测真实 Key 就用 `tools/harness.mjs` 那套办法克隆 userData 三个文件（含 Local State，否则 safeStorage 解不开密钥）。
- 套件 test-01…test-10 覆盖导航/LLM/任务/取消/边界/回归/并发/网络重试/会话删除；mock LLM 用本地 http server（`req/res close` 的坑见上文）。
- 探针脚本在 `tools/probes/`（**已入库**，供换机后复用；本机写新探针仍建议放 `_scratch/` 不入库）。
- **改 UI 一定要跑探针看，别只读代码**（预览面板出过事）：CSS `max-width` 把 JS 拖拽的宽度顶死（卡在 372px）、flex 方向排错把面板挤到聊天下面、输入框没包进分栏容器导致关掉面板后聊天区只剩 190px——这三个 bug 读代码完全看不出来，探针一次全抓到。`probe-preview.mjs` 覆盖分栏/拖拽/钳制/关闭恢复。
- **探针输出和上次一模一样 = 跑的是旧构建**：改完代码必须先 `npm run build` 再跑探针（探针加载的是 dist 里的产物）。
- **CDP 发的键盘事件会绕过焦点**（验键盘焦点时踩到）：它直接把事件丢给主页面，焦点在 iframe 上时宿主照样能收到——用它验证"按键进了 iframe"必然得到假结果。这类修复要用**真的物理键盘**验：PowerShell `(New-Object -ComObject WScript.Shell).SendKeys('{UP}')`（注意 SendKeys 这个类在没有消息循环的控制台里会报错，得走 WScript.Shell COM）。
- **但用真键盘时，先确认窗口真的切到前台了**（2026-10-17 踩到）：SendKeys 是把键发给**当前前台窗口**的，探针起的 Electron 不在前台时，键打到了别处——测试会报失败，但其实是测试自己的问题。做法是先 `SetForegroundWindow`，再用 `GetForegroundWindow` 核对确实切过去了，然后才发键。
- **断言先确认前提真的发生了，再判断结果**：实测两次假结果——中转返回空时"没有额外生成视频"照样通过（模型压根没跑）；窗口没切到前台时键盘测试报失败（键打偏了）。断言里要显式检查前置状态（如 `steps.length > 0`、`foregroundMatchesTarget`）。

## 产物预览与文件卡片（游乐场）

- 网页产物的流程：气泡里认出 ```html 代码块 → 出现文件卡片（**懒落盘**：第一次点「预览」才真正写文件到 `userData/artifacts/<sessionId>/`，路径由主进程的 `artifact:save` 生成，渲染端没法指定往哪写）→ 右侧分栏预览面板（iframe 带 `sandbox=allow-scripts`，跟聊天列真分栏、能拖宽）。
- **分栏要成的三个条件**：`.pg-main` 横向 flex + 输入框要包进 `.pg-chat`（漏了会被挤到面板右边）+ 面板 `flex: none` 且聊天列 `flex: 1`。
- **面板初始宽度要量实宽，不能按窗口算**：游乐场限宽 1150px，按 `window.innerWidth` 算会占满整栏；打开时量一下 `.pg-main` 实际多宽再定。
- docx/xlsx 预览需要解析库（mammoth ~100KB、SheetJS ~150KB），PDF/图片 iframe 原生就能显示——真用到再加依赖。

### 预览里的脚本为什么不跑（v0.2.1 查到的原因，务必记住）

**用 `srcDoc` 加载的 iframe 会继承宿主的 CSP**，而宿主的规则是 `script-src 'self'`
（不允许内联脚本）→ 预览页里的 `<script>` 被浏览器挡掉，**游戏/小工具根本没运行**。
用户看到的就是"页面画出来了，但点什么都没反应"。

- 我一条条试过、都不成立的说法（都是实测，不是猜的）：不是 `sandbox`（去掉也不跑）、
  不是 `blob:`/`data:`（一样会继承 CSP）、iframe 上的 `csp` 属性（Chrome 根本没实现这个）、
  也不是子页面自己写一条 CSP 就能放宽（CSP 只能收紧，不能放松）。
- **唯一管用的办法**：用 URL 加载页面，这样它用自己的规则、不继承宿主的 → 走 `h3preview:` 协议按 URL 加载。
- **宿主的 CSP 没放宽**（`script-src 'self'` 一个字没动），只多加了一条 `frame-src 'self' h3preview:`。
- **预览自己的 CSP 走响应头下发，不要用 `<meta>` 注入**（安全审查的结论）：用正则去找 `<head>`
  再往里插 meta，会匹到注释或脚本字符串里的假 `<head>`，结果安全策略**悄悄失效还不报错**。
  响应头是权威的，页面内容怎么构造都改不了它。
- 预览的产物当**不可信内容**对待：注入 `default-src 'none'` 再逐项放行本地来源，
  `connect-src`/`form-action`/`base-uri` 全封（模型生成的网页不该有往外发数据的能力）。
- **怎么快速定位**：临时把构建产物里的 CSP meta 删掉再跑探针——脚本立刻跑起来就说明是它。
  比读代码猜快得多。

## UI 交互约定（用户已确认的形态）

- 「联网」「浏览器搜索」chips 默认开启，二者不互斥（同开时浏览器渲染优先）。
- 工具调用步骤：生成中强制展开（实时透明），完成后默认折叠为「已执行 N 步 · 最后一步摘要」一行，可点开回看。
- 空对话不落盘（关软件即永久删除）+ 新建/切换会话时清掉空壳——任意时刻空对话最多 1 个。
- 预览面板聊天列保底 30px（可拖到接近全宽预览）。
