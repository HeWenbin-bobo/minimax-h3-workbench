# "清空"被静默改回默认值：同一类缺陷出现了四次

**记录时间**：2026-10-21 探索期。四次都是实测复现，不是推断。

## 一句话结论

`normalizeSettings` 里的 `str()` 把**空串当成"没给"**，回落到默认值。
但用户点"清空"表达的是**"我不想用它"**——两件事被合并处理，于是"清空"静默无效，
下游还以为值配好了。正确口径：**空串 = 未配置**，用 `maybeStr()`。

## 四次实例

| 字段 | 默认值 | 后果 |
|---|---|---|
| `ssh.username` | `"root"` | 清空用户名后磁盘仍是 root；`assertUsable` 判"填齐了"→ 建出注定失败的任务 |
| `localComfyUrl` | `http://127.0.0.1:8188` | 全新用户（什么都没配）说"生成视频"，闸门放行，回执写「已创建 1 个视频生成任务：后端=本机 ComfyUI」 |
| `rbBaseUrl` | `https://rb.coolhs.com` | 清空地址静默无效，仍在连默认服务 |
| `minimaxBaseUrl` | `https://api.minimax.io` | 同上 |

## 为什么这么难发现

这些字段**平时看起来都对**：默认值本身合理，绝大多数用户也会用默认值。
只有当"用户主动清空"时行为才不同，而那是个低频动作。

前三处都是**先有别的现象、顺藤摸到根因**才发现的：
- `ssh.username` 是从"提交没被拦"查出来的（探针 `probe-assert-usable`）；
- `localComfyUrl` 是从"没有任何后端却建出了任务"查出来的（探针 `probe-no-backend`）；
- 两个 `*BaseUrl` 是顺着前一处**主动穷举** `grep "str(raw\."` 找出来的。

**教训：修完一处同类缺陷后，立刻 grep 同类写法。** 第四处就是靠这一步找到的。

## 判断标准（哪些字段该允许空）

不是所有字段都该改成 `maybeStr`。判据是**"空串是否是一个有意义的用户意图"**：

| 允许空（`maybeStr`） | 必须回落（`str`） |
|---|---|
| 服务地址（清空 = 不用这个后端） | `outputDirectory`（空了会崩） |
| 用户名（清空 = 未配置） | `llm.provider` / `llm.model`（空了没法发请求） |
| `comfyuiRoot`（清空 = 不做本地检测） | `ssh.name`（纯显示，空了难看） |

## 配套的第二道防线

允许空之后，**下游必须能接住空值**，否则会从"静默无效"变成"英文技术错误"：

- `AdapterRegistry.get()` 加 `requireUrl`：地址为空 → 中文错误
  「请先在连接设置中填写「本机 ComfyUI」的服务地址。」
  （不挡的话会拼出 `"/prompt"` 这种相对地址，报 `Failed to parse URL`）
- `assertUsable()` 判据本来就是"非空"，天然接住
- `describeEndpoint()` 显式处理空值 → `（未配置地址）`

## 测试怎么写才算数

每条都用**变异验证**确认过"改回旧写法就会红"：

```ts
// 不是这种（测的是"有没有值"，旧写法也可能通过）
expect(result.localComfyUrl).toBeTruthy();

// 是这种（直接测"空串必须保持空"）
expect(normalizeSettings({ localComfyUrl: "" }, defaults).localComfyUrl).toBe("");
```

并且**写两条方向相反的**：`"" → ""`（清空生效）与 `123 → 默认值`（类型错误仍回落）。
只测一个方向会让"把所有输入都保留"这种错误实现也通过。

## 相关探针

- `_scratch/probe-assert-usable.mjs`（ssh 用户名）
- `_scratch/probe-no-backend.mjs`（localComfyUrl + 闸门）
- 两个 `*BaseUrl` 直接在 `settingsStore.test.ts` 里覆盖，没有单独探针
