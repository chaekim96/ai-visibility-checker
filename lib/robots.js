// robots.txt: parse groups, then decide whether a crawler may fetch a path.
// Matching follows RFC 9309: the most specific (longest) matching rule wins, and
// Allow wins a tie. `*` matches any characters and `$` anchors the end.

export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      if (current) current.rules.push({ allow: key === "allow", path: value });
      lastWasAgent = false;
    } else if (key === "sitemap") {
      if (value) sitemaps.push(value);
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return { groups, sitemaps };
}

function ruleToRegex(path) {
  const anchored = path.endsWith("$");
  const body = (anchored ? path.slice(0, -1) : path)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + body + (anchored ? "$" : ""));
}

/** The groups that apply to this crawler: its own if any name it, otherwise `*`. */
export function groupsFor(robots, crawler) {
  const token = crawler.toLowerCase();
  const own = robots.groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  if (own.length) return { groups: own, named: true };
  return { groups: robots.groups.filter((g) => g.agents.includes("*")), named: false };
}

export function isAllowed(robots, crawler, path) {
  const { groups, named } = groupsFor(robots, crawler);
  let best = null;
  for (const g of groups) {
    for (const r of g.rules) {
      if (r.path === "") continue; // "Disallow:" with no path allows everything
      if (!ruleToRegex(r.path).test(path)) continue;
      const len = r.path.replace(/\*/g, "").length;
      if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { ...r, len };
    }
  }
  return { allowed: best ? best.allow : true, rule: best ? `${best.allow ? "Allow" : "Disallow"}: ${best.path}` : null, named };
}

// Crawlers that decide whether a page shows up in search and AI answers.
// `kind` separates search and live fetching (blocking hurts visibility) from
// model training (blocking is a legitimate choice that doesn't remove you from answers).
export const CRAWLERS = [
  { ua: "Googlebot", owner: "Google", purpose: "Google Search and AI Overviews", kind: "search" },
  { ua: "Bingbot", owner: "Microsoft", purpose: "Bing and Copilot", kind: "search" },
  { ua: "OAI-SearchBot", owner: "OpenAI", purpose: "ChatGPT search results", kind: "search" },
  { ua: "ChatGPT-User", owner: "OpenAI", purpose: "pages ChatGPT opens for a user", kind: "search" },
  { ua: "Claude-SearchBot", owner: "Anthropic", purpose: "Claude search results", kind: "search" },
  { ua: "Claude-User", owner: "Anthropic", purpose: "pages Claude opens for a user", kind: "search" },
  { ua: "PerplexityBot", owner: "Perplexity", purpose: "Perplexity answers", kind: "search" },
  { ua: "GPTBot", owner: "OpenAI", purpose: "model training", kind: "training" },
  { ua: "ClaudeBot", owner: "Anthropic", purpose: "model training", kind: "training" },
  { ua: "Google-Extended", owner: "Google", purpose: "Gemini training", kind: "training" },
  { ua: "CCBot", owner: "Common Crawl", purpose: "an open dataset many models train on", kind: "training" },
];
