// The checks. Each returns { id, group, label, status, detail, fix, weight }.
// status: pass | warn | fail | info. The score is the share of weight earned:
// pass earns all of it, warn half, fail none; info is shown but not scored.
import { safeFetch, normalizeUrl } from "./fetch-safe.js";
import { readPage, schemaTypes } from "./html.js";
import { parseRobots, isAllowed, CRAWLERS } from "./robots.js";

export const GROUPS = {
  find: "Can AI find it?",
  read: "Can AI read it?",
  cite: "Can AI understand and cite it?",
};

function check(id, group, label, weight, status, detail, fix = "") {
  return { id, group, label, weight, status, detail, fix };
}

const sameUrl = (a, b) => {
  try {
    const x = new URL(a), y = new URL(b);
    const clean = (u) => (u.origin + u.pathname.replace(/\/+$/, "") + u.search).toLowerCase();
    return clean(x) === clean(y);
  } catch { return false; }
};

async function tryFetch(url, opts) {
  try { return await safeFetch(url, opts); } catch (e) { return { error: e.message }; }
}

const publicCrawlers = (list) => list.map(({ ua, owner, purpose, kind, allowed, rule, named }) => ({ ua, owner, purpose, kind, allowed, rule, named }));

export function score(checks) {
  let earned = 0, total = 0;
  for (const c of checks) {
    if (c.status === "info" || !c.weight) continue;
    total += c.weight;
    earned += c.status === "pass" ? c.weight : c.status === "warn" ? c.weight / 2 : 0;
  }
  return total ? Math.round((earned / total) * 100) : 0;
}

export function fixFirst(checks, n = 3) {
  return checks
    .filter((c) => (c.status === "fail" || c.status === "warn") && c.fix)
    .map((c) => ({ ...c, lost: c.status === "fail" ? c.weight : c.weight / 2 }))
    .sort((a, b) => b.lost - a.lost)
    .slice(0, n)
    .map(({ id, label, fix, status }) => ({ id, label, fix, status }));
}

async function siteChecks(origin, path, finalUrl) {
  const checks = [];
  const robotsRes = await tryFetch(origin + "/robots.txt", { maxBytes: 500_000, timeoutMs: 6000, accept: "text/plain" });
  const robotsOk = robotsRes.status === 200 && !/^\s*</.test(robotsRes.text || "");
  const robots = parseRobots(robotsOk ? robotsRes.text : "");
  const crawlers = CRAWLERS.map((c) => ({ ...c, ...isAllowed(robots, c.ua, path) }));
  const blockedSearch = crawlers.filter((c) => c.kind === "search" && !c.allowed);
  const blockedTraining = crawlers.filter((c) => c.kind === "training" && !c.allowed);
  if (blockedSearch.some((c) => c.ua === "Googlebot" || c.ua === "Bingbot")) {
    checks.push(check("crawlers", "find", "AI and search crawlers", 12, "fail",
      `robots.txt blocks ${blockedSearch.map((c) => c.ua).join(", ")} from this page.`,
      "Allow Googlebot and Bingbot in robots.txt; most AI answers lean on these indexes."));
  } else if (blockedSearch.length) {
    checks.push(check("crawlers", "find", "AI and search crawlers", 12, "warn",
      `robots.txt blocks ${blockedSearch.map((c) => c.ua).join(", ")}, so those assistants can't fetch or cite this page.`,
      "Allow the search and user-fetch bots (OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot) if you want to be cited."));
  } else {
    checks.push(check("crawlers", "find", "AI and search crawlers", 12, "pass",
      robotsOk ? "robots.txt lets every search and AI-answer crawler fetch this page." : "No robots.txt, so every crawler is allowed by default.",
      ""));
  }
  if (blockedTraining.length) {
    checks.push(check("training", "find", "Model-training crawlers", 0, "info",
      `Blocked: ${blockedTraining.map((c) => c.ua).join(", ")}. That keeps this page out of training data; it doesn't remove it from search or AI answers.`));
  }

  // Sitemap: from robots.txt, else /sitemap.xml
  const sitemapUrls = robots.sitemaps.length ? robots.sitemaps : [origin + "/sitemap.xml"];
  let sitemap = null;
  for (const s of sitemapUrls.slice(0, 3)) {
    const r = await tryFetch(s, { maxBytes: 3_000_000, timeoutMs: 6000, accept: "application/xml,text/xml" });
    if (r.status === 200 && /<(urlset|sitemapindex)\b/i.test(r.text || "")) {
      const locs = [...r.text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]);
      sitemap = { url: s, index: /<sitemapindex\b/i.test(r.text), count: locs.length, listsPage: locs.some((l) => sameUrl(l, finalUrl)), inRobots: robots.sitemaps.length > 0 };
      break;
    }
  }
  checks.push(sitemap
    ? check("sitemap", "find", "Sitemap", 6, sitemap.inRobots ? "pass" : "warn",
        `${sitemap.index ? "A sitemap index with" : "A sitemap with"} ${sitemap.count} ${sitemap.index ? (sitemap.count === 1 ? "sitemap" : "sitemaps") : (sitemap.count === 1 ? "URL" : "URLs")}${sitemap.inRobots ? ", listed in robots.txt" : ""}${!sitemap.index && sitemap.listsPage ? ", including this page" : ""}.`,
        sitemap.inRobots ? "" : "Add a Sitemap: line to robots.txt so crawlers find it without guessing.")
    : check("sitemap", "find", "Sitemap", 6, "warn", "No sitemap found in robots.txt or at /sitemap.xml.",
        "Publish a sitemap.xml and reference it from robots.txt."));

  const llms = await tryFetch(origin + "/llms.txt", { maxBytes: 300_000, timeoutMs: 5000, accept: "text/plain,text/markdown" });
  const llmsOk = llms.status === 200 && (llms.text || "").trim().length > 0 && !/^\s*</.test(llms.text);
  checks.push(llmsOk
    ? check("llms", "find", "llms.txt", 4, "pass", `Found /llms.txt (${(llms.text.match(/\n/g) || []).length + 1} lines).`)
    : check("llms", "find", "llms.txt", 4, "warn", "No /llms.txt. It's an emerging, optional convention: a short Markdown guide to your site for AI tools.",
        "Add /llms.txt: your name, one line on what the site is, and links to the pages that matter most."));

  return { checks, crawlers, robotsOk };
}

export async function audit(input) {
  const target = normalizeUrl(input);
  const page = await safeFetch(target, { accept: "text/html,application/xhtml+xml" });
  const finalUrl = page.url;
  const origin = new URL(finalUrl).origin;
  const path = new URL(finalUrl).pathname + new URL(finalUrl).search;
  const checks = [];

  if ([401, 403, 429, 503].includes(page.status)) {
    // Many large sites refuse unknown bots. That says nothing about what Googlebot or
    // GPTBot get, so check the public site files and say plainly what we couldn't see.
    checks.push(check("reachable", "find", "Page loads", 0, "info",
      `The site refused this checker (HTTP ${page.status}), as many large sites do with unknown bots. Real search and AI crawlers may still get the page, so the page itself wasn't checked; robots.txt, the sitemap and llms.txt were.`));
    const site = await siteChecks(origin, path, finalUrl);
    checks.push(...site.checks);
    return { url: target, finalUrl, status: page.status, redirects: page.redirects, ms: page.ms, partial: true, score: score(checks), checks, crawlers: publicCrawlers(site.crawlers), fixFirst: fixFirst(checks), robotsTxt: site.robotsOk };
  }
  if (page.status !== 200) {
    checks.push(check("reachable", "find", "Page loads", 15, "fail",
      `The page answered with HTTP ${page.status}.`, "Make sure the URL returns 200 OK to crawlers, not an error or a login wall."));
    return { url: target, finalUrl, status: page.status, redirects: page.redirects, ms: page.ms, score: 0, checks, crawlers: [], fixFirst: fixFirst(checks) };
  }
  const type = page.headers.get("content-type") || "";
  if (!/html/i.test(type)) {
    checks.push(check("reachable", "find", "Page loads", 15, "fail",
      `This URL returns ${type || "an unknown type"}, not a web page.`, "Check a page URL, not a file or an API."));
    return { url: target, finalUrl, status: page.status, redirects: page.redirects, ms: page.ms, score: 0, checks, crawlers: [], fixFirst: fixFirst(checks) };
  }

  const doc = readPage(page.text);

  // ---------- Can AI find it? ----------
  const xRobots = (page.headers.get("x-robots-tag") || "").toLowerCase();
  const metaRobots = (doc.meta["robots"] || "").toLowerCase();
  const noindex = /noindex|none/.test(xRobots) || /noindex|none/.test(metaRobots);
  checks.push(noindex
    ? check("indexable", "find", "Allowed in search", 15, "fail",
        `The page asks not to be indexed (${xRobots ? "X-Robots-Tag: " + xRobots : "meta robots: " + metaRobots}).`,
        "Remove noindex if you want this page to appear in search and AI answers.")
    : check("indexable", "find", "Allowed in search", 15, "pass", "No noindex instruction on the page or in its headers."));

  const site = await siteChecks(origin, path, finalUrl);
  checks.push(...site.checks);

  // From the Lucent audit playbook: HTTPS everywhere, HTTP redirecting to it, no redirect chains.
  const final = new URL(finalUrl);
  if (final.protocol !== "https:") {
    checks.push(check("https", "find", "HTTPS", 6, "fail", "The page is served over plain HTTP.",
      "Serve the site over HTTPS and redirect every HTTP URL to it."));
  } else {
    const plain = await tryFetch("http://" + final.host + final.pathname + final.search, { follow: false, timeoutMs: 5000 });
    const toHttps = plain.location && new URL(plain.location).protocol === "https:";
    checks.push(toHttps
      ? check("https", "find", "HTTPS", 6, "pass", `Served over HTTPS, and the HTTP address redirects to it (${plain.status}).`)
      : plain.error
        ? check("https", "find", "HTTPS", 6, "pass", "Served over HTTPS; the HTTP address doesn't answer at all.")
        : check("https", "find", "HTTPS", 6, "warn", `Served over HTTPS, but the HTTP address answers with ${plain.status} instead of redirecting.`,
            "Redirect every HTTP URL to its HTTPS version with a 301."));
  }
  const hops = page.redirects.length;
  checks.push(hops <= 1
    ? check("redirects", "find", "Redirect chain", 3, "pass", hops ? "One redirect to reach the page." : "No redirects to reach the page.")
    : check("redirects", "find", "Redirect chain", 3, "warn", `${hops} redirects in a row before the page loads.`,
        "Point links and the sitemap straight at the final URL, so crawlers reach it in one hop."));

  // ---------- Can AI read it? ----------
  if (doc.wordCount >= 150) {
    checks.push(check("ssr", "read", "Readable without JavaScript", 14, "pass", `${doc.wordCount} words are in the HTML itself, before any script runs.`));
  } else if (doc.wordCount >= 50) {
    checks.push(check("ssr", "read", "Readable without JavaScript", 14, "warn", `Only ${doc.wordCount} words are in the HTML before scripts run.`,
      "Put the main content in the HTML (server-render or prerender). Several AI crawlers don't run JavaScript."));
  } else {
    checks.push(check("ssr", "read", "Readable without JavaScript", 14, "fail", `Only ${doc.wordCount} words are in the HTML; the rest appears after JavaScript runs${doc.scripts ? ` (${doc.scripts} ${doc.scripts === 1 ? "script" : "scripts"})` : ""}.`,
      "Server-render or prerender the content. Several AI crawlers don't run JavaScript, so they see an empty page."));
  }

  checks.push(!doc.title
    ? check("title", "read", "Title", 8, "fail", "The page has no <title>.", "Add a title that says what the page is, in 60 characters or fewer.")
    : doc.title.length > 70
      ? check("title", "read", "Title", 8, "warn", `“${doc.title}” is ${doc.title.length} characters; long titles get cut off.`, "Shorten the title to about 60 characters.")
      : check("title", "read", "Title", 8, "pass", `“${doc.title}”`));

  checks.push(doc.h1s.length === 1
    ? check("headings", "read", "One main heading", 5, "pass", `“${doc.h1s[0]}”, plus ${doc.h2Count} section ${doc.h2Count === 1 ? "heading" : "headings"}.`)
    : doc.h1s.length === 0
      ? check("headings", "read", "One main heading", 5, "warn", "No <h1> in the HTML.", "Give the page one <h1> that names its topic.")
      : check("headings", "read", "One main heading", 5, "warn", `${doc.h1s.length} <h1> headings; one is clearer.`, "Keep one <h1> and make the rest <h2>."));

  // From the Lucent audit playbook: mobile viewport, image alt text, heading order, mixed content.
  const viewport = (doc.meta["viewport"] || "").toLowerCase();
  checks.push(/width\s*=\s*device-width/.test(viewport)
    ? check("viewport", "read", "Mobile viewport", 3, "pass", "The page declares a mobile viewport.")
    : check("viewport", "read", "Mobile viewport", 3, "warn", viewport ? `The viewport tag doesn't use the device width (“${viewport}”).` : "No viewport meta tag, so phones render a zoomed-out desktop page.",
        'Add <meta name="viewport" content="width=device-width, initial-scale=1">.'));

  if (doc.imageCount) {
    checks.push(doc.imagesMissingAlt === 0
      ? check("alt", "read", "Image alt text", 4, "pass", `All ${doc.imageCount} ${doc.imageCount === 1 ? "image has" : "images have"} alt text, so their content can be read without seeing them.`)
      : check("alt", "read", "Image alt text", 4, doc.imagesMissingAlt / doc.imageCount > 0.5 ? "fail" : "warn",
          `${doc.imagesMissingAlt} of ${doc.imageCount} images have no alt text.`,
          'Describe each meaningful image in an alt attribute; use alt="" for purely decorative ones.'));
  }

  const skips = [];
  for (let i = 1; i < doc.headingLevels.length; i++) {
    const [a, b] = [doc.headingLevels[i - 1], doc.headingLevels[i]];
    if (b > a + 1) skips.push(`h${a} to h${b}`);
  }
  if (doc.headingLevels.length > 1) {
    checks.push(skips.length
      ? check("heading-order", "read", "Heading order", 3, "warn", `Headings skip a level: ${[...new Set(skips)].slice(0, 3).join(", ")}.`,
          "Step headings down one level at a time (h1, then h2, then h3), so the outline reads as a structure.")
      : check("heading-order", "read", "Heading order", 3, "pass", "Headings step down one level at a time."));
  }

  if (final.protocol === "https:") {
    checks.push(doc.insecure.length
      ? check("mixed", "read", "Mixed content", 3, "warn", `${doc.insecure.length} ${doc.insecure.length === 1 ? "resource loads" : "resources load"} over plain HTTP on this HTTPS page, e.g. ${doc.insecure[0]}.`,
          "Load every image, script, stylesheet and frame over HTTPS.")
      : check("mixed", "read", "Mixed content", 3, "pass", "Every image, script and stylesheet loads over HTTPS."));
  }

  checks.push(doc.lang
    ? check("lang", "read", "Language", 0, "info", `Declared as “${doc.lang}”.`)
    : check("lang", "read", "Language", 0, "info", "No lang attribute on <html>.", "Add lang=\"en\" (or your language) to the <html> tag."));

  // ---------- Can AI understand and cite it? ----------
  const blocks = doc.jsonld;
  const types = [...schemaTypes(blocks.filter((b) => b.ok).map((b) => b.data))];
  const broken = blocks.filter((b) => !b.ok).length;
  checks.push(!blocks.length
    ? check("schema", "cite", "Structured data", 12, "warn", "No JSON-LD. Machines have to guess what this page is and who made it.",
        "Add JSON-LD naming the page type (Article, Product, Organization, Person, CreativeWork) and its author.")
    : broken
      ? check("schema", "cite", "Structured data", 12, "fail", `${broken} of ${blocks.length} JSON-LD blocks don't parse${types.length ? `; the rest declare ${types.join(", ")}` : ""}.`,
          "Fix the JSON syntax in the broken block; invalid JSON-LD is ignored entirely.")
      : check("schema", "cite", "Structured data", 12, "pass", `JSON-LD declares ${types.join(", ") || "data with no @type"}.`));

  if (doc.canonical === null) {
    checks.push(check("canonical", "cite", "Canonical URL", 8, "warn", "No canonical link, so copies of this page can compete with it.",
      "Add <link rel=\"canonical\" href=\"…\"> with the page's preferred URL."));
  } else {
    const canon = (() => { try { return new URL(doc.canonical, finalUrl).toString(); } catch { return ""; } })();
    checks.push(sameUrl(canon, finalUrl)
      ? check("canonical", "cite", "Canonical URL", 8, "pass", `Points to this page: ${canon}`)
      : check("canonical", "cite", "Canonical URL", 8, "warn", `Points somewhere else: ${canon || doc.canonical}. Crawlers may credit that URL instead.`,
          "Make the canonical match the URL you want cited, or confirm the other URL is intended."));
  }

  const desc = doc.meta["description"] || "";
  checks.push(!desc
    ? check("description", "cite", "Description", 6, "warn", "No meta description, so search and AI tools write their own summary.",
        "Add a one-sentence meta description of what the page offers.")
    : check("description", "cite", "Description", 6, desc.length > 170 ? "warn" : "pass",
        `“${desc.length > 160 ? desc.slice(0, 157) + "…" : desc}”`, desc.length > 170 ? "Trim the description to about 155 characters." : ""));

  const og = { title: doc.meta["og:title"], description: doc.meta["og:description"], image: doc.meta["og:image"] };
  const have = Object.entries(og).filter(([, v]) => v).map(([k]) => k);
  let imageOk = false;
  if (og.image) {
    const img = await tryFetch(new URL(og.image, finalUrl).toString(), { method: "HEAD", timeoutMs: 5000 });
    imageOk = img.status === 200 && /^image\//i.test(img.headers?.get?.("content-type") || "");
  }
  checks.push(have.length === 3 && imageOk
    ? check("preview", "cite", "Link preview", 10, "pass", `Title, description and image are set; the image loads.`)
    : have.length === 0
      ? check("preview", "cite", "Link preview", 10, "fail", "No Open Graph tags, so shared links show a bare URL.",
          "Add og:title, og:description and a 1200×630 og:image.")
      : check("preview", "cite", "Link preview", 10, "warn",
          og.image && !imageOk ? "The og:image doesn't load as an image." : `Missing ${["title", "description", "image"].filter((k) => !og[k]).map((k) => "og:" + k).join(", ")}.`,
          "Set og:title, og:description and an og:image that loads (1200×630)."));

  return {
    url: target,
    finalUrl,
    status: page.status,
    redirects: page.redirects,
    ms: page.ms,
    truncated: page.truncated,
    score: score(checks),
    checks,
    crawlers: publicCrawlers(site.crawlers),
    fixFirst: fixFirst(checks),
    robotsTxt: site.robotsOk,
  };
}
