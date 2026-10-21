// GET /api/check?url=example.com  →  the audit as JSON.
import { audit } from "../lib/audit.js";

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost").searchParams.get("url");
  res.setHeader("content-type", "application/json; charset=utf-8");
  try {
    const result = await audit(url);
    res.setHeader("cache-control", "public, max-age=0, s-maxage=300, stale-while-revalidate=600");
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (e) {
    const message = e?.name === "TimeoutError" || /aborted|timeout/i.test(e?.message || "")
      ? "The site took too long to answer."
      : /ENOTFOUND|EAI_AGAIN/.test(e?.message || e?.cause?.code || "")
        ? "That domain doesn't resolve."
        : e?.message || "Something went wrong.";
    res.setHeader("cache-control", "no-store");
    res.statusCode = 400;
    res.end(JSON.stringify({ error: message }));
  }
}
