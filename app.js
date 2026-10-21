const $ = (s) => document.querySelector(s);
const form = $("#form"), input = $("#url"), go = $("#go"), statusEl = $("#status"), report = $("#report");

const GROUPS = [
  ["find", "Can AI find it?"],
  ["read", "Can AI read it?"],
  ["cite", "Can AI understand and cite it?"],
];
const LABEL = { pass: "Pass", warn: "Improve", fail: "Fix", info: "Note" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function verdict(score) {
  if (score >= 90) return "Ready for AI answers";
  if (score >= 70) return "Mostly visible, a few gaps";
  if (score >= 50) return "Partly visible";
  return "Hard for AI to use";
}

function ring(score) {
  const r = 46, c = 2 * Math.PI * r, off = c * (1 - score / 100);
  const tone = score >= 90 ? "pass" : score >= 60 ? "warn" : "fail";
  return `<svg class="ring ring--${tone}" viewBox="0 0 110 110" role="img" aria-label="Score ${score} out of 100">
    <circle cx="55" cy="55" r="${r}" class="ring__bg"/>
    <circle cx="55" cy="55" r="${r}" class="ring__fg" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/>
    <text x="55" y="61" text-anchor="middle">${score}</text></svg>`;
}

function render(r) {
  const host = new URL(r.finalUrl).host + new URL(r.finalUrl).pathname.replace(/\/$/, "");
  const fixes = r.fixFirst.length
    ? `<div class="fixes"><h3>Fix first</h3><ol>${r.fixFirst.map((f) => `<li><b>${esc(f.label)}</b><span>${esc(f.fix)}</span></li>`).join("")}</ol></div>`
    : `<div class="fixes fixes--clear"><h3>Nothing urgent</h3><p>Every scored check passes.</p></div>`;
  const groups = GROUPS.map(([id, title]) => {
    const rows = r.checks.filter((c) => c.group === id);
    if (!rows.length) return "";
    return `<div class="group"><h3>${title}</h3><ul class="checks">${rows.map((c) => `
      <li class="check check--${c.status}">
        <span class="chip chip--${c.status}">${LABEL[c.status]}</span>
        <div><b>${esc(c.label)}</b><p>${esc(c.detail)}</p>${c.fix && c.status !== "pass" && c.status !== "info" ? `<p class="fix">${esc(c.fix)}</p>` : ""}</div>
      </li>`).join("")}</ul></div>`;
  }).join("");
  const crawlers = r.crawlers.length ? `<div class="group"><h3>Who robots.txt lets in${r.robotsTxt ? "" : " <small>(no robots.txt: everyone)</small>"}</h3>
    <div class="table"><table><thead><tr><th>Crawler</th><th>Used for</th><th>This page</th></tr></thead><tbody>
    ${r.crawlers.map((c) => `<tr><td><b>${esc(c.ua)}</b><small>${esc(c.owner)}</small></td><td>${esc(c.purpose)}</td>
      <td><span class="chip chip--${c.allowed ? "pass" : c.kind === "search" ? "warn" : "info"}">${c.allowed ? "Allowed" : "Blocked"}</span>${c.rule ? `<small class="rule">${esc(c.rule)}</small>` : ""}</td></tr>`).join("")}
    </tbody></table></div></div>` : "";
  const redirect = r.redirects?.length ? `<p class="meta">Redirected ${r.redirects.length}× to ${esc(r.finalUrl)}</p>` : "";
  report.innerHTML = `
    <div class="summary">
      ${ring(r.score)}
      <div><p class="summary__k">${esc(host)}</p><h2>${r.partial ? "Partial check" : verdict(r.score)}</h2>
      <p class="meta">${r.partial ? `The site refused this checker (HTTP ${r.status}), so only its public files were checked. ` : ""}${r.checks.filter((c) => c.status === "pass").length} of ${r.checks.filter((c) => c.status !== "info").length} checks pass · fetched in ${(r.ms / 1000).toFixed(1)}s</p>${redirect}</div>
    </div>
    ${fixes}${groups}${crawlers}`;
  report.hidden = false;
}

async function run(raw) {
  const url = raw.trim();
  if (!url) return;
  go.disabled = true;
  report.hidden = true;
  statusEl.className = "status status--busy";
  statusEl.textContent = "Reading the page, robots.txt, sitemap and llms.txt…";
  const qs = new URLSearchParams({ url });
  history.replaceState(null, "", "?" + qs);
  try {
    const res = await fetch("/api/check?" + qs);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    statusEl.textContent = "";
    statusEl.className = "status";
    render(data);
    report.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  } catch (e) {
    statusEl.className = "status status--error";
    statusEl.textContent = e.message === "Failed to fetch" ? "Couldn't reach the checker. Try again." : e.message;
  } finally {
    go.disabled = false;
  }
}

form.addEventListener("submit", (e) => { e.preventDefault(); run(input.value); });
document.querySelectorAll("[data-try]").forEach((b) => b.addEventListener("click", () => { input.value = b.dataset.try; run(b.dataset.try); }));
const preset = new URLSearchParams(location.search).get("url");
if (preset) { input.value = preset; run(preset); }
