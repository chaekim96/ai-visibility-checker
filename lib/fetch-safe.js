// Fetching other people's sites from a public server: only http(s), only public
// addresses (checked on every redirect hop), bounded size, bounded time.
import dns from "node:dns/promises";
import net from "node:net";

export const USER_AGENT =
  "AIVisibilityChecker/1.0 (+https://github.com/chaekim96/ai-visibility-checker)";

function ipv4ToInt(ip) {
  return ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

const PRIVATE_V4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([base, bits]) => [ipv4ToInt(base), bits]);

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return PRIVATE_V4.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique local
    if (/^fe[89ab]/.test(v)) return true; // link local
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // not an IP at all: refuse
}

export async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("That address isn't on the public internet.");
  }
  const addresses = net.isIP(host)
    ? [host]
    : (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new Error("That address isn't on the public internet.");
  }
}

export function normalizeUrl(input) {
  let raw = String(input || "").trim();
  if (!raw) throw new Error("Enter a URL to check.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = "https://" + raw;
  let u;
  try { u = new URL(raw); } catch { throw new Error("That doesn't look like a URL."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http and https URLs can be checked.");
  if (u.username || u.password) throw new Error("URLs with a username or password can't be checked.");
  u.hash = "";
  return u.toString();
}

async function readBody(res, maxBytes) {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0, truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      chunks.push(value.subarray(0, value.byteLength - (size - maxBytes)));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks)), truncated };
}

/**
 * GET (or HEAD) a public URL, following up to `maxRedirects` redirects by hand so
 * every hop is checked. Returns { url, status, headers, text, redirects, truncated, ms }.
 */
export async function safeFetch(url, { method = "GET", maxBytes = 2_000_000, timeoutMs = 8000, maxRedirects = 5, accept = "*/*", follow = true } = {}) {
  const started = Date.now();
  const redirects = [];
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = new URL(current);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Redirected to a non-web address.");
    await assertPublicHost(u.hostname);
    const res = await fetch(u, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": USER_AGENT, accept },
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location && !follow) {
      await res.body?.cancel().catch(() => {});
      return { url: current, status: res.status, headers: res.headers, text: "", redirects, truncated: false, ms: Date.now() - started, location: new URL(location, current).toString() };
    }
    if (res.status >= 300 && res.status < 400 && location) {
      redirects.push({ from: current, to: new URL(location, current).toString(), status: res.status });
      current = new URL(location, current).toString();
      await res.body?.cancel().catch(() => {});
      continue;
    }
    const { text, truncated } = method === "HEAD" ? { text: "", truncated: false } : await readBody(res, maxBytes);
    return { url: current, status: res.status, headers: res.headers, text, redirects, truncated, ms: Date.now() - started };
  }
  throw new Error(`More than ${maxRedirects} redirects.`);
}
