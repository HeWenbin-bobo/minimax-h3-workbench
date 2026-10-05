# MiniMax H3 工作台 — 项目工作规则

## 项目背景速览

- **仓库**：https://github.com/HeWenbin-bobo/minimax-h3-workbench（fork 自 francoeur003，已移除原作者署名），本地 `F:\MinimaxH3\repo`。
- **技术栈**：Electron 43 + React 19 + TypeScript 7 + Vite 8，主进程 `src/main/`、渲染端 `src/renderer/App.tsx`（单文件应用）、共享类型 `src/shared/`。
- **架构**：四个生成后端（local/ssh/minimax/rb）通过 `adapterRegistry.ts` 统一接入，实现 `GenerationAdapter` 接口（test/generate/cancel）；`generationOrchestrator.ts` 管任务生命周期，`settingsStore.ts` 管设置与 safeStorage 加密密钥。
- **验证命令**：`npm test`（Vitest，19+ 项）、`npm run typecheck`、`npm run build`——三项全绿才算完成。

## Git 提交与推送规则

**大文件红线**：任何大于 95MB 的文件不得 commit（GitHub 硬限制单文件 100MB）。
- 提交前抽查 `git status`；安装包、模型权重、构建产物不入库（`.gitignore` 已覆盖 `release/`、`dist/`）。

**依赖与环境不入库**：`node_modules/` 禁止暂存。

**瞬态状态不入库**：工作区常驻未跟踪杂物 `.omc/`、`.smoke-userdata/`、`art8.json`、`smoke.png`、`.claude/`——**一律勿提交**；`git add -A` 后抽查 `git status --short` 确认它们未被暂存。

**Commit 信息风格**：`feat:/fix:/chore:/docs:` 简短英文标题 + 中文正文分块说明；描述用户可感知的变化，不写"修复若干问题"这类模糊表述。

**Git 命令边界**：可用 `status / diff / log / add / commit / push / tag`（直接提交到当前分支）；`reset / rebase`、强制推送、删历史需用户明确指示后才可用。

## 发版流程（tag 即发布，有四个坑）

发版 = bump version → commit → tag `vX.Y.Z` → push tag → **若 CI 未自动触发则手动 dispatch** → 等四 job 全绿 → draft 转正 + 写正式 release notes。

1. 修改 `package.json` version → commit `chore: bump version to X.Y.Z` → `git tag vX.Y.Z` → `git push origin main vX.Y.Z`。
2. **坑 ① fork 仓库 push tag 不触发 CI**：必须手动 dispatch。本机未装 gh CLI，用 GitHub API + GCM 凭据：
   ```bash
   TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | grep "^password=" | cut -d= -f2-)
   curl -X POST -H "Authorization: Bearer $TOKEN" \
     "https://api.github.com/repos/HeWenbin-bobo/minimax-h3-workbench/actions/workflows/build.yml/dispatches" \
     -d '{"ref":"vX.Y.Z"}'
   ```
3. **坑 ② electron-builder 只向 draft Release 上传资产**，published 会被静默跳过（v0.1.8 空资产事故）；CI 已预建 draft，维护者手动转正。
4. **坑 ③ 同 tag 并发上传会拆散资产**到两个 Release 对象（v0.1.8 事故）；勿手动提前建 Release，让 CI 预建。
5. **坑 ④ Release 规范**：命名统一 `MiniMax H3 工作台 vX.Y.Z`，body 用中文更新内容（从 git 提交信息整理，**不用 CI 默认的"自动构建发布"**）；转正用 PATCH `draft:false` + body。Windows 控制台 curl 传中文 JSON 用 `--data-binary @file.json` 避免转义问题。
6. 发布后核对：`releases/latest` 返回新 tag、assets 含 `latest.yml` + setup exe + blockmap 三件套（`latest.yml` 是应用内更新依赖，缺了更新会失效）。

## 自动更新链路

- `updateChecker.ts` 读 `UPDATE_REPO` 常量 → GitHub Releases latest API；`autoUpdater.ts` 走 electron-updater 读 `build.win.publish` 配置。**两者必须指向同一仓库**。
- 改仓库名或转移 fork 时同步改这两处 + `package.json` repository 字段。

## 后端适配器约定

- 新增后端 = `BackendKind`/`SecretName` 联合追加 + 新 adapter 文件 + registry 加 if 分支 + settingsStore 默认值 + App.tsx 四处（下拉/label/连接卡片/费用文案）——参考 `feature/rb-backend` 分支历史。
- **云后端网络请求统一走独立超时 + 重试**（参考 rbAdapter 的 `fetchWithRetry`）：站外服务（Cloudflare 等）冷连接尾延迟大，实测 rb.coolhs.com p95≈6.4s，8s 裸超时会间歇性失败。
- **提交类 POST 不自动重试**（无法确认服务端是否已建任务，重复扣次风险）；查询/下载类可重试一次。
- 站点无取消端点时 `cancel()` 用 no-op 并注释说明。

## 验证与测试边界

- **本机 Electron 冒烟测试不可用**（GPU 栈损坏，git stash 对照证实非代码回归），验证以单测 + typecheck + CI 为准。
- 修改 adapter/workflow 逻辑必须配对应单测（`workflows.test.ts`、`comfyAdapter.test.ts` 是模板）；纯 UI 布局改动可不加。
- 单测全绿 + typecheck 通过 + build 通过，三者缺一不提交。

## 安全红线

- **卡密/API Key 只存 safeStorage 加密的 secrets.json**，绝不入库、绝不打印、绝不硬编码。
- `h3media` 协议与 `shell:showItem` 已做路径白名单（输出目录/ComfyUI 模型目录），改动这两个 IPC 时必须保持防护。
- `shell:openExternal` 只允许 HTTPS 链接。
- 渲染端 sandbox: true + contextIsolation，勿放开。

## 长会话工作纪律（v0.1.11 会话教训）

- **写大文件前先在脑中过一遍完整内容再落笔**；输出出现乱码/重复/外语混杂等损坏迹象时，**立即停止输出**，用 `git checkout -- <file>` 恢复，改用小块 Edit 逐段应用。
- 每次 Write/Edit 大文件后 `git diff` 人工核对再提交；损坏内容绝不进入 commit。
- 长会话（>300k tokens）写大文件易损坏，小块 Edit 更可靠。

## 其他约定

- **注释少而精**：解释"为什么"，不复述"是什么"。
- UI 文案、错误提示一律中文（面向最终用户）。
- 回答尽可能少创造新词；引用实测数据时注明样本量与条件（如"40 次冷连接实测 p95≈6.4s"）。
- 不删/不覆盖 `docs/`、历史 Release 资产；发现历史数字与现状不符时先查 git 历史再下结论。
- **不擅自修改本 CLAUDE.md**：改动由 Claude 提出草案、用户确认后落地。
- **督促任务**：用户下达督促任务后，每次回答都要提醒该任务尚未完成，直到用户解除。
