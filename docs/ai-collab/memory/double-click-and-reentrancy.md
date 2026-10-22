# 连点与重入：`useState` 挡不住同一 tick 的第二次点击

**一句话**：`disabled={busy}` / `if (busy) return` 这类守卫在 React 里挡不住连点——
`setState` 是异步提交的，同一个事件循环里连点 N 次，N 次都会读到**旧的** `busy`。
守卫必须用**同步 ref**。

## 为什么会踩

```tsx
const [testing, setTesting] = useState<BackendKind>();
async function test(kind: BackendKind) {
  if (testing) return;          // ← 同一 tick 内连点 3 次，三次读到的都是 undefined
  setTesting(kind);             // ← 三次都执行
  await window.h3.testBackend(kind);   // ← 真的发了 3 次请求
  setTesting(undefined);
}
```

`setTesting` 只是"排队等下一次渲染时生效"。点击事件是同步的，第二、三次点击
在 React 提交新状态之前就已经跑完了判据。

修法固定是同一套：

```tsx
const testingRef = useRef<BackendKind>();   // 或 useRef(false)
async function test(kind: BackendKind) {
  if (testingRef.current) return;
  testingRef.current = kind;                // 同步置位，立刻生效
  setTesting(kind);                         // 仅用于按钮文案/禁用态，不承担守卫
  try { … } finally { testingRef.current = undefined; setTesting(undefined); }
}
```

**别用 `setX` 的函数式更新来"顺手守卫"**：`setX(prev => { if (prev) return prev; … })`
看起来能读旧值，但它在 updater 里做副作用（发请求）是错的——React 可能重复调用 updater。

## 已经被这个根因打中过的入口（截至 2026-10-22，共 8 处）

| 入口 | 重复执行的后果 |
|---|---|
| `StudioPage.submit` | 云端按次计费：双击建出 2 个项目组、ComfyUI `/prompt` 被命中 2 次 |
| `VideoForm.submitVideo` | 同上（与 submit 各修过一次，属于漏了兄弟入口） |
| `TaskCard.retry` | 重试会新建项目组，双击建两组；云端重试真扣费 |
| `PlaygroundPage.manualCompact` | 重复压缩历史，同一轮跑两次摘要 |
| `PlaygroundPage.answerQuestions` | 同一份答案重复提交，模型收到两次 |
| `ConnectionsPage.test` / `testLlm` | 重复向站外服务打连通性探测（白耗额度） |
| `TrashPanel.purge` | **不可逆**：`tasks:purge` 连视频文件一起删，实测连点 3 次主进程真的收到 3 次 |
| `TrashPanel.restore` / `StudioPage.deleteProject` | 重复发请求、反复弹提示，与主进程状态脱节 |

## 怎么验（别只看代码）

**必须数"副作用真的发生了几次"，而不是看界面有没有变**：

- 不可逆/站外操作：在**渲染端观察不到的地方**计数。包装 `window.h3.xxx` **不起作用**
  （React 持有的是 preload 暴露对象的原始方法引用），实测得到"0 次"的假结果；
  改用**上游 mock HTTP 服务**数请求，或临时在主进程 handler 里落一行计数日志。
- 观察类判据仍可用：让提示文案带上**实际条数**（`已彻底删除 N 条`），
  连点失效时第 2、3 次会拿到空数组、文案变成"已不在回收站"，断言即可捕获。
- **做完必须做变异验证**：把守卫删掉重新 build，确认测试变红。见
  [probe-blind-spots.md](probe-blind-spots.md) 教训 ③——本轮第一版判据因为留了余量，
  变异后仍然全绿。

回归护栏：`.e2e/test-11-double-click-guards.mjs`（10 项）。

## 加新入口时的检查清单

1. 这个 handler 会不会发 IPC / 网络请求 / 写盘 / 扣费？
2. 会 → 第一行就写同步 ref 守卫，`finally` 里复位。
3. 顺带 grep 一遍**同一个功能的其他入口**（提交、重试、测试连接常常是三个独立函数）。
4. 把这一处加进上表，并在 `test-11` 里补一条"连点 3 次只发生 1 次"的断言。
