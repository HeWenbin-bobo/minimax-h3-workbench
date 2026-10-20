/**
 * 文本文件的**编码探测与解码**。
 *
 * 为什么需要（实测，两次踩到同一件事）：
 * - Windows 记事本「另存为 → 编码：ANSI」在中文系统上写的是 **GBK/GB18030**；
 * - 「编码：Unicode」写的是 **UTF-16LE + BOM**（`FF FE` 开头）。
 *
 * 直接 `readFile(path, "utf8")` 对这两种都**不会报错**，只会给出一片乱码：
 * GBK 变成 `���Ĭ����`，UTF-16LE 变成 `��-N噀Km諎`。用户在自己电脑上打开文件明明正常，
 * 看到的是"软件把我文件读坏了"，而模型拿到的也是噪声，只会答非所问。
 *
 * 顺序（BOM 是编码判断里最确定的信号，必须排最前）：
 * 1. `FF FE` → UTF-16LE；`FE FF` → UTF-16BE
 * 2. 严格 UTF-8（`fatal: true` 会抛，而不是静默替换成 U+FFFD）
 * 3. GB18030（向下兼容 GBK/GB2312，是中文 Windows 的实际默认）
 *
 * 同一套逻辑服务于两条路径：**对话附件**（`attachment:read`）与
 * **产物预览**（`artifact:read`）。写两遍的后果是只会修其中一处——
 * 这就是本项目的「同一个判定写了两处，就要一起改」。
 */

/** UTF-16 BOM。存在即确定编码，不必再猜。 */
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;

/**
 * 把文件字节解码成文本。
 *
 * @param bytes 文件原始字节
 * @returns 解码后的文本（已去掉开头的 U+FEFF）
 */
export function decodeTextBytes(bytes: Uint8Array): string {
  let raw: string;
  if (bytes.length >= 2 && bytes[0] === UTF16LE_BOM[0] && bytes[1] === UTF16LE_BOM[1]) {
    // 跳过 BOM 再解：Node 的 `utf-16le` 解码器**不会**自动剥掉 BOM，
    // 不跳的话正文第一个字符就是不可见的 U+FEFF，模型照抄片段时会把它一起带走。
    raw = new TextDecoder("utf-16le").decode(bytes.subarray(2));
  } else if (bytes.length >= 2 && bytes[0] === UTF16BE_BOM[0] && bytes[1] === UTF16BE_BOM[1]) {
    raw = new TextDecoder("utf-16be").decode(bytes.subarray(2));
  } else {
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      raw = new TextDecoder("gb18030").decode(bytes);
    }
  }
  // 兜底：少数工具写的是「UTF-8 BOM + 非 UTF-8 正文」这类混合，
  // 上面的分支剥不干净。U+FEFF 只有"编码标记"这一个含义，正文不该带。
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/**
 * 只读文件头的**预览**解码：超过 `maxBytes` 时只解前一段。
 *
 * 为什么单独一个函数：预览面板是只读展示用途，把整份文本读进内存再随 IPC 传给渲染端，
 * 主进程与渲染进程会同时吃力。xlsx 走 SheetJS 自己的解析路径（不受此限）。
 *
 * 截断只发生在**完整字符边界**上：按字节切会把多字节字符劈成两半，
 * 末尾留下一个 U+FFFD。原文两条预览路径各写了一遍 `replace(/�+$/, "")`，
 * 这里统一收进同一个函数，避免再出现"只改一处"。
 */
export function decodeTextPreview(bytes: Uint8Array, maxBytes: number): { text: string; truncated: boolean } {
  if (bytes.length <= maxBytes) return { text: decodeTextBytes(bytes), truncated: false };
  const head = decodeTextBytes(bytes.subarray(0, maxBytes));
  return { text: head.replace(/�+$/, ""), truncated: true };
}
