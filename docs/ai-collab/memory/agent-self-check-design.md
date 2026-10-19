---
name: agent-self-check-design
description: "让智能体\"自检自己写的网页\"时必须守住的三条：报文件身份、区分运行状态与视觉效果、堵住零报错白屏"
metadata:
  node_type: memory
  type: project
  originSessionId: ffef1031-03ba-4d2c-9783-aeb7f514312a
  modified: 2026-10-19T05:54:14.049Z
---

2026-10-19 在 `feature/pelican-exploration-2026-10-19` 分支上为游乐场加了 `inspect_artifact`
（智能体用应用自带 Chromium 真实运行自己写的 HTML）。三条结论读代码看不出来，都是真机跑出来的：

**1. 报告必须写明"检查的是哪个文件 + 大小 + 修改时间"。**
不加这一行时，自检连续两次报同一条 `M.identity is not defined` 后，模型开始怀疑工具
"加载了缓存/旧文件"，为此写了两个探针页、烧掉 4 步去验证工具是否可信。
**事后核对磁盘：报错是真的**——它所谓"重写后"的文件里确实还留着那一行
（正确写法 `M.ident` 出现 19 次，错写 `M.identity` 还留着 1 次）。
即模型会把自己的疏忽误判成工具故障；给它文件身份它就能自查。
→ 推论：**同类"工具给了负面结论"的场景，都要附上"我是基于哪份输入得出的"。**

**2. "控制台没报错"不等于"画出来了"，必须采样像素。**
一个 WebGL 页可以零报错但整屏空白（清屏成背景色 / 画布 0 尺寸 / 渲染循环没启动）。
实测 Electron 隐藏窗口（`show:false`）能 `capturePage()` 取到真实像素；
纯色页主色占比 100%、空白画布页 97.7%，所以"主色 ≥97% 且元素数 > 1"是稳定判据。
缺了这条，工具会说"已运行且未报错"，模型据此对用户宣称"已验证"，用户打开是白屏。

**3. 同一个判定写了两处就会漏一处。**
`formatProbeReport`（给模型看）和 `humanizeToolOutput`（给用户看的步骤条）各判一次
"自检是否通过"。给模型那份修好了，步骤条那份因为匹配的措辞对不上（正文是
"控制台**没有** error/warning"，而它匹配"**没有任何** error/warning"），
把空画面说成了中性的「自检完成」。→ 与 CLAUDE.md 那条"同一个判定写了两处就要一起改"同源。

相关：[[agent-prompt-engineering-leverage]]、[[playground-branch-status]]
