---
name: minimax-h3-size-budget
description: MiniMax H3 工作台的体积预算与浏览器自动化代价评估（Electron 自带 Chromium 是关键变量）
metadata:
  node_type: memory
  type: project
  originSessionId: e2d1a939-aefd-47be-bc44-ecb868f1b022
  modified: 2026-10-12T11:10:20.002Z
---

2026-10-12 实测的 MiniMax H3 工作台体积基线（评估新依赖时用这个做对比）：

- 已打包 Windows NSIS 安装包：**91.4 MB**
- Electron 运行时 `node_modules/electron/dist`：**348 MB**（绝大部分是 Electron 自带的 Chromium）
- 应用自身代码：`dist` 3.2 MB + `dist-electron` 0.2 MB
- 运行时依赖仅 **7 个**（@ai-sdk/openai-compatible, ai, electron-updater, react, react-dom, ssh2, systeminformation）
- 源码总量约 5.3k 行

**浏览器自动化依赖的真实代价**（npm 元数据实测）：
- `playwright-core` 13.7 MB / 115 文件 / **deps: none**（自包含）
- `playwright` 5.0 MB（仅包一层，依赖 playwright-core）
- `puppeteer-core` 6.0 MB 但 **927 文件 / 6 个依赖**（ws、chromium-bidi、devtools-protocol…）
- `selenium-webdriver` 23.3 MB / 4 个依赖
- **关键**：上述都**不含浏览器二进制**；Chromium 二进制每平台约 130–170 MB 需另行下载，会把安装包从 91 MB 顶到 250–300 MB+。

**结论**：`playwright-core`（无依赖、13.7 MB）本身可接受；真正撑爆体积的是**浏览器二进制**。本项目已依赖 Electron（自带 Chromium），`.e2e/driver.mjs` 已用**裸 CDP + WebSocket 零依赖**驱动 Electron 做 E2E。所以要做浏览器自动化，正确路线是**复用应用自身的 Chromium / CDP**，而不是引入 Playwright/Selenium 附带的浏览器下载——后者让软件"大一倍"是必然的。

**CDP 路线已落地**（2026-10-12）：`src/main/modules/browserFetch.ts` 用隐藏 `BrowserWindow` + `loadURL` + `executeJavaScript("document.documentElement.outerHTML")` 实现渲染抓取，零新增依赖。要点与陷阱：

- **陷阱（踩过）**：**没有常驻窗口时，隐藏窗口销毁会触发 Electron `window-all-closed` 默认行为，主进程静默退出（exit 0、无异常）**——连续调用 renderHtml 的独立探针就这样"凭空消失"，极易误判成"渲染崩溃"。生产应用有常驻 `mainWindow`，故不受影响；**写这类探针/脚本时必须自己保留一个 keeper 窗口**。
- 走独立 session 分区 `persist:h3-browser-fetch`，不污染应用 Cookie；隐藏窗口 `show:false` + `sandbox:true` + 无 nodeIntegration。
- **串行队列**：隐藏窗口是重资源，并发开多个会打爆内存；队列需吞掉单次失败（`chain = task.then(noop, noop)`），否则一次失败连坐后续全部调用。
- 与 HTTP 抓取的关系：搜索链路是 **API → HTTP 抓 Bing → HTTP 抓搜狗 → 浏览器渲染 Bing → 浏览器渲染搜狗**，逐级回退。实测 HTTP 直抓 Bing 已够用（591ms/6 条），浏览器渲染作为最后兜底。

相关：[[relay-capabilities]]
