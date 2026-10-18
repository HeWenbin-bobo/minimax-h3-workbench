// 云后端结果下载的 SSRF 防护：远端返回的下载地址属不可信输入，落回下载前必须过这里。
// 仅允许公网 HTTPS，拒绝回环/私网/链路本地/组播/云元数据地址；调用方还需用
// redirect:"manual" 禁止自动跟随重定向（否则可用 302 绕过本校验指向内网）。
import { lookup } from "node:dns/promises";

export function assertSafeResultUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("生成结果下载地址无效。");
  }
  if (url.protocol !== "https:") throw new Error("生成结果下载地址必须为 HTTPS。");
  assertPublicHost(url);
  return url;
}

/**
 * `open_page` 用的校验：允许 http/https，但同样拒绝回环/私网/链路本地/元数据地址。
 *
 * 为什么需要：`open_page` 的 URL 由**模型**生成（还可能被它刚抓到的网页内容提示注入诱导），
 * 而浏览器窗口是以主进程身份发请求的——不拦的话模型可以让我方去访问
 * `http://127.0.0.1:8188`（ComfyUI 控制面）、`http://169.254.169.254/`（云元数据）等内网资源，
 * 再把响应原文交回对话。这与结果下载那条 SSRF 是同一类问题，只是多允许了 http。
 */
export function assertPublicHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("网页地址无效。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只允许打开 http/https 网页。");
  assertPublicHost(url);
  return url;
}

/**
 * 同 `assertPublicHttpUrl`，但**额外做一次 DNS 解析**再确认落点是公网。
 *
 * 为什么必须有这一层：字面 hostname 合法不等于目标公网。有一类免费的**通配 DNS**
 * 服务专门把 IP 编进域名——`127.0.0.1.nip.io`、`10.0.0.1.sslip.io`、`localtest.me`
 * 都解析到对应的内网地址。实测（probe-ssrf-nipio）`http://127.0.0.1.nip.io:<port>/object_info`
 * 通过了旧的纯字面校验，并**真的读回了本机服务的内容**。
 *
 * 用于**能 await 的入口**：`open_page` 打开前，以及 `browserFetch` 的
 * `webRequest.onBeforeRequest`（该回调本身就是异步的，能容纳 DNS 查询）。
 * `will-redirect` / `will-navigate` 是同步事件，那里只能退回字面校验。
 *
 * 已知上限（写在这里，别以为已经万无一失）：这是"解析一次、随后再连接"，
 * 对 **DNS 重绑定**（同一域名两次解析结果不同）无效。要彻底堵住得在连接层按实际 IP 校验，
 * 代价与复杂度都高得多；本应用的使用场景（模型给出的 URL）下，解析校验已挡住绝大多数写法。
 */
export async function assertPublicHttpUrlResolved(
  rawUrl: string,
  /** 注入 DNS 解析（默认 node 的 lookup）。单测用它锁定"通配 DNS 指向内网"这条路径，不必联网。 */
  resolver: (host: string) => Promise<Array<{ address: string }>> = (host) => lookup(host, { all: true })
): Promise<URL> {
  const url = assertPublicHttpUrl(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolver(host);
  } catch {
    throw new Error("无法解析该网页的域名，请检查地址是否正确。");
  }
  if (addresses.length === 0) throw new Error("无法解析该网页的域名，请检查地址是否正确。");
  // 任一解析结果落在内网就拒绝：多 A 记录里混一条内网地址同样能被用来绕过。
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("该地址指向内网，已拒绝访问。");
  }
  return url;
}

function assertPublicHost(url: URL): void {
  // **先去掉尾点**：`localhost.` 是 FQDN 的根锚定写法，DNS 解析与 `localhost` 完全等价。
  // 实测（probe-ssrf-trailing-dot）`http://localhost.:<port>/object_info` 能真的连上本机服务，
  // 而旧实现只比对 `localhost` → 放行，模型（或提示注入）由此可读回 ComfyUI 控制面。
  // `.internal.` / `.local.` / `.localhost.` 同理。
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("该地址指向内网，已拒绝访问。");
  }
  if (isPrivateAddress(host)) throw new Error("该地址指向内网，已拒绝访问。");
}

// 仅覆盖直接写 IP 的情形（域名解析到内网需 DNS 层校验，此处超出权限范围）。
function isPrivateAddress(host: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (ipv4.slice(1).some((part) => Number(part) > 255)) return false; // 非法 IP 交给 fetch 报错
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) // 运营商级 NAT 100.64/10
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (!host.includes(":")) return false;
  const groups = parseIpv6(host);
  // 解析不了就按原来的前缀启发式兜底，宁可多拦。
  if (!groups) {
    const normalized = host.toLowerCase();
    return normalized === "::" || normalized === "::1"
      || normalized.startsWith("fc") || normalized.startsWith("fd")
      || /^fe[89ab]/.test(normalized);
  }
  return isPrivateIpv6(groups);
}

// 把 ::ffff:127.0.0.1 这类写法展开成 8 个 hextet。WHATWG URL 已把 hostname 规范成十六进制，
// 这里同时兼容点分内嵌形式，避免只认一种写法。
function parseIpv6(host: string): number[] | undefined {
  let text = host.replace(/^\[|\]$/g, "").toLowerCase();
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail) {
    const parts = tail.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return undefined;
    text = text.slice(0, tail.index) + `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...rest];
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return groups.map((group) => parseInt(group, 16));
}

// 私网判定要连 IPv6 里嵌的 IPv4 一起看：只查前缀的话，::ffff:7f00:1、::7f00:1（IPv4 兼容）、
// ::ffff:0:7f00:1（IPv4 翻译）、64:ff9b::7f00:1（NAT64）、2002:7f00:1::（6to4）全都会被放行
// ——实测都能打到回环/内网，属于 SSRF 绕过。
function isPrivateIpv6([a, b, c, d, e, f, g, h]: number[]): boolean {
  const embedded = () => isPrivateAddress(`${g >> 8}.${g & 0xff}.${h >> 8}.${h & 0xff}`);
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g === 0 && h === 0) return true; // ::
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g === 0 && h === 1) return true; // ::1
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) return embedded(); // IPv4 兼容 ::a.b.c.d
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return embedded(); // IPv4 映射
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0xffff && f === 0) return embedded(); // IPv4 翻译
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return embedded(); // NAT64 64:ff9b::/96
  if (a === 0x64 && b === 0xff9b && c === 1) return true; // NAT64 本地 64:ff9b:1::/48
  if (a === 0x2002) return isPrivateAddress(`${b >> 8}.${b & 0xff}.${c >> 8}.${c & 0xff}`); // 6to4 2002::/16
  // Teredo 2001::/32：客户端 IPv4 在末两个 hextet，按位取反存放。
  if (a === 0x2001 && b === 0) {
    const high = g ^ 0xffff;
    const low = h ^ 0xffff;
    return isPrivateAddress(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  if ((a & 0xfe00) === 0xfc00) return true; // 唯一本地 fc00::/7
  if ((a & 0xffc0) === 0xfe80) return true; // 链路本地 fe80::/10
  if ((a & 0xffc0) === 0xfec0) return true; // 站点本地 fec0::/10（已废弃但仍应拦）
  if ((a & 0xff00) === 0xff00) return true; // 组播 ff00::/8
  return false;
}
