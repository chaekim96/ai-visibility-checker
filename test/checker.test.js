import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRobots, isAllowed } from "../lib/robots.js";
import { isPrivateAddress, normalizeUrl, assertPublicHost } from "../lib/fetch-safe.js";
import { readPage, schemaTypes } from "../lib/html.js";
import { score, fixFirst } from "../lib/audit.js";

test("robots: a named group overrides *", () => {
  const r = parseRobots("User-agent: *\nDisallow:\n\nUser-agent: GPTBot\nDisallow: /\n");
  assert.equal(isAllowed(r, "GPTBot", "/page").allowed, false);
  assert.equal(isAllowed(r, "ClaudeBot", "/page").allowed, true);
});

test("robots: longest match wins, Allow wins a tie", () => {
  const r = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow: /x\nAllow: /x\n");
  assert.equal(isAllowed(r, "Googlebot", "/private/secret").allowed, false);
  assert.equal(isAllowed(r, "Googlebot", "/private/ok/page").allowed, true);
  assert.equal(isAllowed(r, "Googlebot", "/x").allowed, true);
});

test("robots: wildcards and end anchors", () => {
  const r = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /tmp*/\n");
  assert.equal(isAllowed(r, "Bingbot", "/files/a.pdf").allowed, false);
  assert.equal(isAllowed(r, "Bingbot", "/files/a.pdf?x=1").allowed, true);
  assert.equal(isAllowed(r, "Bingbot", "/tmp123/a").allowed, false);
});

test("robots: grouped agents share rules, sitemaps are collected", () => {
  const r = parseRobots("User-agent: ClaudeBot\nUser-agent: CCBot\nDisallow: /\nSitemap: https://e.com/s.xml\n");
  assert.equal(isAllowed(r, "CCBot", "/").allowed, false);
  assert.equal(isAllowed(r, "ClaudeBot", "/").allowed, false);
  assert.equal(isAllowed(r, "Claude-SearchBot", "/").allowed, true);
  assert.deepEqual(r.sitemaps, ["https://e.com/s.xml"]);
});

test("robots: no file means everything is allowed", () => {
  assert.equal(isAllowed(parseRobots(""), "GPTBot", "/").allowed, true);
});

test("private and local addresses are refused", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "76.76.21.21", "2606:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);
  await assert.rejects(assertPublicHost("localhost"));
  await assert.rejects(assertPublicHost("127.0.0.1"));
  await assert.rejects(assertPublicHost("[::1]"));
});

test("URLs are normalized and non-web schemes refused", () => {
  assert.equal(normalizeUrl("example.com/a#top"), "https://example.com/a");
  assert.throws(() => normalizeUrl("file:///etc/passwd"));
  assert.throws(() => normalizeUrl("ftp://example.com"));
  assert.throws(() => normalizeUrl("https://user:pw@example.com"));
  assert.throws(() => normalizeUrl(""));
});

test("readPage pulls what crawlers use, from HTML only", () => {
  const html = `<!doctype html><html lang="en"><head><title>Tally &amp; friends</title>
    <meta name="description" content="Notes that add up.">
    <meta property="og:title" content="Tally"><link rel="canonical" href="https://t.app/">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":["CreativeWork","Thing"],"creator":{"@type":"Person"}}]}</script>
    <script type="application/ld+json">{ not json }</script></head>
    <body><h1>Notes that add up</h1><h2>A</h2><h2>B</h2><p>${"word ".repeat(40)}</p><script>var hidden = "not counted";</script></body></html>`;
  const d = readPage(html);
  assert.equal(d.title, "Tally & friends");
  assert.equal(d.lang, "en");
  assert.equal(d.meta.description, "Notes that add up.");
  assert.equal(d.meta["og:title"], "Tally");
  assert.equal(d.canonical, "https://t.app/");
  assert.deepEqual(d.h1s, ["Notes that add up"]);
  assert.equal(d.h2Count, 2);
  assert.equal(d.jsonld.length, 2);
  assert.equal(d.jsonld[1].ok, false);
  assert.deepEqual([...schemaTypes(d.jsonld[0].data)].sort(), ["CreativeWork", "Person", "Thing", "WebSite"]);
  assert.ok(d.wordCount >= 45 && d.wordCount <= 50, String(d.wordCount));
});

test("score: pass full, warn half, fail none, info ignored", () => {
  const checks = [
    { status: "pass", weight: 10 }, { status: "warn", weight: 10 },
    { status: "fail", weight: 20 }, { status: "info", weight: 50 },
  ];
  assert.equal(score(checks), 38);
});

test("fixFirst ranks by points lost", () => {
  const checks = [
    { id: "a", label: "A", status: "warn", weight: 12, fix: "a" },
    { id: "b", label: "B", status: "fail", weight: 8, fix: "b" },
    { id: "c", label: "C", status: "fail", weight: 14, fix: "c" },
    { id: "d", label: "D", status: "pass", weight: 15, fix: "" },
  ];
  assert.deepEqual(fixFirst(checks).map((f) => f.id), ["c", "b", "a"]);
});
