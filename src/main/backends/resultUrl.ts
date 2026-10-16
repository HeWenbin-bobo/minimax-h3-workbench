// 云后端结果下载的 SSRF 防护：远端返回的下载地址属不可信输入，落回下载前必须过这里。
// 仅允许公网 HTTPS，拒绝回环/私网/链路本地/组播/云元数据地址；调用方还需用
// redirect:"manual" 禁止自动跟随重定向（否则可用 302 绕过本校验指向内网）。
export function assertSafeResultUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("生成结果下载地址无效。");
  }
  if (url.protocol !== "https:") throw new Error("生成结果下载地址必须为 HTTPS。");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("生成结果下载地址指向内网，已拒绝。");
  }
  if (isPrivateAddress(host)) throw new Error("生成结果下载地址指向内网，已拒绝。");
  return url;
}

// 仅覆盖直接写 IP 的情形（域名解析到内网需 DNS 层校验，此处超出权限范围）；
// IPv4 私网/回环/链路本地/组播 + IPv6 回环/唯一本地/链路本地 + IPv4 映射的 IPv6。
function isPrivateAddress(host: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (ipv4.slice(1).some((part) => Number(part) > 255)) return false; // 非法 IP 交给 fetch 报错
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (host.includes(":")) {
    const normalized = host.toLowerCase();
    // IPv4 映射/兼容的 IPv6（如 ::ffff:127.0.0.1）：WHATWG URL 会把 ::ffff:127.0.0.1 规范化成
    // 十六进制 [::ffff:7f00:1]，普通前缀检查漏判 → 回环/内网被放行（实测 SSRF 绕过）。
    // 取末 32 位（末两个 hextet）还原成 IPv4 再走同一套私网判定。
    const mapped = /::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
    if (mapped) {
      const high = parseInt(mapped[1], 16);
      const low = parseInt(mapped[2], 16);
      const dotted = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
      return isPrivateAddress(dotted);
    }
    return normalized === "::" || normalized === "::1"
      || normalized.startsWith("fc") || normalized.startsWith("fd") // 唯一本地地址 fc00::/7
      || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb"); // 链路本地 fe80::/10
  }
  return false;
}
