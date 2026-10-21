// A small, dependency-free reader for the parts of an HTML page that crawlers use.
// It reads the raw HTML exactly as a crawler that doesn't run JavaScript would.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(src))) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  return attrs;
}

/** All opening tags with this name, as attribute objects. */
export function tags(html, name) {
  const out = [];
  const re = new RegExp(`<${name}\\b([^>]*)>`, "gi");
  let m;
  while ((m = re.exec(html))) out.push(parseAttrs(m[1]));
  return out;
}

function stripNonContent(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ");
}

function textOf(fragment) {
  return decodeEntities(fragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function readPage(html) {
  const head = (html.match(/<head\b[\s\S]*?<\/head>/i) || [html])[0];

  const meta = {};
  for (const t of tags(html, "meta")) {
    const key = (t.name || t.property || t["http-equiv"] || "").toLowerCase();
    if (key && t.content !== undefined && !(key in meta)) meta[key] = t.content.trim();
  }

  const canonicalTag = tags(head, "link").find((t) => (t.rel || "").toLowerCase().split(/\s+/).includes("canonical"));
  const title = textOf((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || ["", ""])[1]);
  const htmlTag = tags(html, "html")[0] || {};

  // JSON-LD blocks: keep the parse errors, they're findings too.
  const jsonld = [];
  const ldRe = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRe.exec(html))) {
    try {
      jsonld.push({ ok: true, data: JSON.parse(m[1].trim()) });
    } catch (e) {
      jsonld.push({ ok: false, error: e.message });
    }
  }

  const body = stripNonContent(html);
  const h1s = [...body.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((x) => textOf(x[1])).filter(Boolean);
  const h2Count = (body.match(/<h2\b/gi) || []).length;
  const bodyHtml = (body.match(/<body\b[\s\S]*<\/body>/i) || [body])[0];
  const words = textOf(bodyHtml).split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w));
  const scripts = (html.match(/<script\b/gi) || []).length;

  // Images: a missing alt attribute is a finding; alt="" is a valid choice for decoration.
  const imgs = tags(bodyHtml, "img");
  const imagesMissingAlt = imgs.filter((t) => !("alt" in t)).length;

  // Heading levels in document order, to catch skips like h1 -> h3.
  const headingLevels = [...body.matchAll(/<h([1-6])\b/gi)].map((x) => Number(x[1]));

  // Insecure resources an HTTPS page would load (images, scripts, styles, frames, media).
  const insecure = [
    ...tags(html, "img").map((t) => t.src), ...tags(html, "script").map((t) => t.src),
    ...tags(html, "iframe").map((t) => t.src), ...tags(html, "source").map((t) => t.src),
    ...tags(html, "video").map((t) => t.src), ...tags(html, "audio").map((t) => t.src),
    ...tags(html, "link").filter((t) => /stylesheet|icon|preload/i.test(t.rel || "")).map((t) => t.href),
  ].filter((u) => typeof u === "string" && /^http:\/\//i.test(u.trim()));

  return {
    title,
    lang: htmlTag.lang || "",
    meta,
    canonical: canonicalTag ? canonicalTag.href || "" : null,
    jsonld,
    h1s,
    h2Count,
    wordCount: words.length,
    scripts,
    imageCount: imgs.length,
    imagesMissingAlt,
    headingLevels,
    insecure,
  };
}

/** Every @type in a JSON-LD value, including inside @graph and nested objects. */
export function schemaTypes(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => schemaTypes(v, out));
  else if (value && typeof value === "object") {
    const t = value["@type"];
    if (typeof t === "string") out.add(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && out.add(x));
    for (const [k, v] of Object.entries(value)) if (k !== "@type" && typeof v === "object") schemaTypes(v, out);
  }
  return out;
}
