// Website checker: follows redirects, classifies the result, tries other
// versions of the address, and looks up the Wayback Machine for broken sites.

const TIMEOUT_MS = 10000;
const MAX_HOPS = 10;
const MAX_BODY = 1024 * 1024;   // read up to 1 MB (LinkedIn links usually sit in the footer)
const SCAN = 300 * 1024;        // classify on the first 300 KB
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

const PARKED_HOSTS = /(^|\.)(sedo\.com|sedoparking\.com|afternic\.com|dan\.com|hugedomains\.com|bodis\.com|parkingcrew\.net|above\.com|undeveloped\.com|squadhelp\.com|atom\.com|buydomains\.com|domainmarket\.com|parklogic\.com|uniregistry\.com|epik\.com|namebright\.com|smartname\.com|godaddy\.com|porkbun\.com)$/i;
const PARKED_TEXT = [
  /this domain (name )?(is|may be) for sale/i, /domain (is )?for sale/i, /buy this domain/i, /make an offer on this domain/i,
  /the domain .{0,60} is for sale/i, /is available for purchase/i, /domain has expired/i, /this domain has expired/i,
  /parked (free|domain|by)/i, /domain parking/i, /sedoparking|parkingcrew|bodis\.com|hugedomains|afternic|dan\.com\/buy/i,
  /inquire about this domain/i, /get this domain/i, /this domain is registered,? but/i,
];
const PLACEHOLDER_TEXT = [
  /account (has been )?suspended/i, /this account is suspended/i, /website (is )?(temporarily )?suspended/i,
  /welcome to nginx/i, /apache2 (ubuntu|debian) default page/i, /<title>\s*it works!?\s*<\/title>/i, /test page for the (apache|nginx)/i,
  /iis windows server/i, /internet information services/i, /default (web )?(site|server) page/i, /web server'?s default page/i,
  /coming soon/i, /under construction/i, /site (is )?under maintenance/i, /future home of/i, /launching soon/i,
  /there is no website configured at this address/i, /site not found/i, /no such app/i, /domain not configured/i,
  /<title>\s*index of \//i, /plesk/i, /cpanel/i, /hostinger.{0,40}(parked|default)/i, /this site can.?t be reached/i,
];

function normalize(raw) {
  let s = String(raw || "").trim().replace(/^["'<]+|["'>]+$/g, "");
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s.replace(/^\/+/, "");
  try {
    const u = new URL(s);
    if (!u.hostname.includes(".")) return null;
    return u;
  } catch { return null; }
}

const bare = h => h.toLowerCase().replace(/^www\./, "");
// rough "registrable domain" (handles co.uk, com.au, etc.)
function siteOf(host) {
  if (/^[\d.]+$|:/.test(host)) return host;
  const parts = bare(host).split(".");
  if (parts.length <= 2) return parts.join(".");
  const sld = parts[parts.length - 2], tld = parts[parts.length - 1];
  const two = tld.length === 2 && /^(co|com|net|org|gov|edu|ac|or|ne|go|gob|nic|ltd|plc|sch)$/.test(sld);
  return parts.slice(two ? -3 : -2).join(".");
}

function errText(err) {
  const c = err?.cause?.code || err?.code || err?.name || "";
  if (/ENOTFOUND/.test(c)) return "Domain doesn't exist (no DNS record)";
  if (/EAI_AGAIN/.test(c)) return "DNS lookup failed";
  if (/ECONNREFUSED/.test(c)) return "Server refused the connection";
  if (/ECONNRESET|UND_ERR_SOCKET/.test(c)) return "Connection was dropped";
  if (/Timeout|UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|AbortError/i.test(c) || /cancel|abort/i.test(err?.message || "")) return "Timed out";
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_SSL/i.test(c) || /certificate|ssl|tls/i.test(err?.cause?.message || "")) return "SSL certificate problem";
  if (/EHOSTUNREACH|ENETUNREACH/.test(c)) return "Server unreachable";
  return (err?.cause?.message || err?.message || "Couldn't connect").slice(0, 120);
}

async function readBody(res) {
  if (!res.body) return "";
  const reader = res.body.getReader(); const chunks = []; let size = 0;
  try {
    while (size < MAX_BODY) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.length;
    }
  } catch { /* partial body is fine */ }
  try { await reader.cancel(); } catch {}
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf8");
}

const decode = s => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/\s+/g, " ").trim();

// One attempt: follow the redirect chain from a starting URL.
async function visit(startUrl) {
  const chain = [startUrl];
  let url = startUrl;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let res;
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" },
      });
    } catch (err) {
      return { ok: false, chain, error: errText(err) };
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      try { await res.body?.cancel(); } catch {}
      let next; try { next = new URL(loc, url).href; } catch { return { ok: false, chain, status: res.status, error: "Bad redirect address" }; }
      if (chain.includes(next)) return { ok: false, chain: [...chain, next], status: res.status, error: "Redirect loop" };
      chain.push(next); url = next; continue;
    }
    const type = res.headers.get("content-type") || "";
    const body = /html|text|^$/i.test(type) ? await readBody(res) : (await res.body?.cancel().catch(() => {}), "");
    // follow <meta http-equiv="refresh"> (very common on parked pages)
    const meta = body.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\s*\d+\s*;\s*url=([^"'>\s]+)/i);
    if (meta && res.status < 400 && hop < MAX_HOPS) {
      try {
        const next = new URL(decode(meta[1]), url).href;
        if (!chain.includes(next)) { chain.push(next); url = next; continue; }
      } catch {}
    }
    const title = decode((body.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i) || [])[1] || "");
    const protectedByBot = res.status === 403 && (res.headers.get("cf-mitigated") || /just a moment|attention required|cloudflare/i.test(body));
    return { ok: true, chain, status: res.status, title, body, finalUrl: url, protectedByBot };
  }
  return { ok: false, chain, error: "Too many redirects" };
}

function classify(v, inputHost) {
  if (!v.ok) return { verdict: "DEAD", note: v.error };
  const finalHost = new URL(v.finalUrl).hostname;
  const sample = v.body.slice(0, SCAN);
  if (PARKED_HOSTS.test(finalHost) || PARKED_TEXT.some(r => r.test(sample))) return { verdict: "PARKED_OR_FOR_SALE" };
  if (v.status >= 400) {
    if (v.protectedByBot) return { verdict: "HTTP_ERROR", note: "Blocked by bot protection — the site probably works in a normal browser" };
    return { verdict: "HTTP_ERROR", note: `The server answered with error ${v.status}` };
  }
  // placeholder checks only on small/simple pages to avoid false alarms on real sites mentioning "coming soon"
  const textLen = sample.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/\s+/g, " ").length;
  if ((textLen < 4000 || /suspended|default (web )?page|welcome to nginx|it works/i.test(v.title)) && PLACEHOLDER_TEXT.some(r => r.test(sample)))
    return { verdict: "PLACEHOLDER" };
  if (siteOf(finalHost) !== siteOf(inputHost)) return { verdict: "REDIRECT_OTHER_DOMAIN" };
  if (v.chain.length > 1) return { verdict: "REDIRECT_SAME_SITE" };
  return { verdict: "OK" };
}

async function wayback(host) {
  try {
    const r = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(host)}`, { signal: AbortSignal.timeout(12000) });
    const d = await r.json();
    const snap = d?.archived_snapshots?.closest;
    if (!snap?.available) return {};
    const t = snap.timestamp || "";
    return { wayback_snapshot: snap.url.replace(/^http:/, "https:"), wayback_date: t ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : "" };
  } catch { return {}; }
}

// --- LinkedIn discovery ---
const LI_RE = /(?:https?:)?\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(company|school|showcase|in)\/([^"'\s<>?#\\]+)/gi;
const LI_RANK = { company: 0, school: 1, showcase: 2, in: 3 };
function findLinkedIn(body) {
  if (!body) return "";
  const text = body.replace(/\\\//g, "/").replace(/&#x2F;|&#47;/gi, "/");
  let best = null;
  for (const m of text.matchAll(LI_RE)) {
    const kind = m[1].toLowerCase();
    let slug = m[2].replace(/\/+$/, "").split("/")[0];
    try { slug = decodeURIComponent(slug); } catch {}
    if (!slug || /^(share|sharing|login|signup|feed)$/i.test(slug)) continue;
    const rank = LI_RANK[kind];
    if (!best || rank < best.rank) best = { rank, url: `https://www.linkedin.com/${kind}/${slug}` };
    if (rank === 0) break;
  }
  return best ? best.url : "";
}

// Look for a LinkedIn link on the page we landed on, then on /contact and /about
async function linkedInFor(v) {
  const direct = findLinkedIn(v.body);
  if (direct) return { linkedin_url: direct, linkedin_found_on: v.finalUrl };
  let origin; try { origin = new URL(v.finalUrl).origin; } catch { return {}; }
  const pages = ["/contact", "/about", "/contact-us", "/about-us"].map(p => origin + p);
  const found = await Promise.all(pages.map(async pg => {
    try {
      const r = await fetch(pg, { signal: AbortSignal.timeout(6000), headers: { "User-Agent": UA, Accept: "text/html" } });
      if (!r.ok) { await r.body?.cancel().catch(() => {}); return ""; }
      const li = findLinkedIn(await readBody(r));
      return li ? { linkedin_url: li, linkedin_found_on: r.url || pg } : "";
    } catch { return ""; }
  }));
  return found.find(Boolean) || {};
}

const BROKEN = new Set(["DEAD", "HTTP_ERROR", "PARKED_OR_FOR_SALE", "PLACEHOLDER"]);
const GOOD = new Set(["OK", "REDIRECT_SAME_SITE"]);

async function checkSite(input) {
  const u = normalize(input);
  if (!u) return { input, checked_url: "", verdict: "DEAD", status_code: "", final_url: "", redirect_chain: [], title: "", note: "Not a valid website address", working_variant: "", wayback_snapshot: "", wayback_date: "", linkedin_url: "", linkedin_found_on: "" };
  const startUrl = u.href;
  const host = u.hostname;
  const v = await visit(startUrl);
  const c = classify(v, host);
  const out = {
    input, checked_url: startUrl, verdict: c.verdict, status_code: v.status || "",
    final_url: v.finalUrl || "", redirect_chain: v.chain, title: v.title || "", note: c.note || "",
    working_variant: "", wayback_snapshot: "", wayback_date: "", linkedin_url: "", linkedin_found_on: "",
  };
  let live = GOOD.has(c.verdict) || c.verdict === "REDIRECT_OTHER_DOMAIN" ? v : null;

  // Try the other versions of the address when it fails
  if (c.verdict === "DEAD" || c.verdict === "HTTP_ERROR") {
    const d = bare(host), isIP = /^[\d.]+$/.test(d);
    const port = u.port ? ":" + u.port : "", path = u.pathname + u.search;
    const variants = [];
    for (const proto of ["https", "http"]) for (const w of isIP ? [""] : ["", "www."]) {
      try { variants.push(new URL(`${proto}://${w}${d}${port}${path}`).href); } catch {}
    }
    variants.splice(0, variants.length, ...variants.filter(x => x !== startUrl));
    for (const alt of variants) {
      const av = await visit(alt);
      const ac = classify(av, host);
      if (GOOD.has(ac.verdict)) {
        out.working_variant = alt;
        out.variant_final_url = av.finalUrl;
        out.variant_title = av.title || "";
        live = av;
        break;
      }
    }
  }

  if (live) Object.assign(out, await linkedInFor(live));
  if (BROKEN.has(out.verdict) && !out.working_variant) Object.assign(out, await wayback(bare(host)));
  return out;
}

module.exports = { checkSite };
