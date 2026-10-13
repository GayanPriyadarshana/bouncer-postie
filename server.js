// Mochi (email + website checker) — tiny zero-dependency server (Node 18+).
// Serves the UI and proxies requests to Bouncer so your API key never reaches the browser.
//
//   1. Put your key in a .env file next to this file:  BOUNCER_API_KEY=your_key_here
//   2. Run:  node server.js
//   3. Open: http://localhost:3000
//
// No key? The app runs in demo mode with sample answers so you can try the UI.

const http = require("http");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const { checkSite } = require("./sitecheck");
const store = require("./store");

function readJSON(req, limit = 200 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

// --- load .env (simple KEY=VALUE parser) ---
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const salesforce = require("./salesforce");   // after .env is loaded - it reads SF_* settings
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.BOUNCER_API_KEY || "";
const DEMO = !API_KEY;
const VERIFY_URL = "https://api.usebouncer.com/v1.1/email/verify";
const CREDITS_URL = "https://api.usebouncer.com/v1.1/credits";
const APOLLO_KEY = process.env.APOLLO_API_KEY || "";
const APOLLO_URL = "https://api.apollo.io/api/v1/people/bulk_match";

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};

async function callBouncer(email, timeoutSec) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = `${VERIFY_URL}?email=${encodeURIComponent(email)}&timeout=${timeoutSec}`;
    const r = await fetch(url, {
      headers: { "x-api-key": API_KEY },
      signal: AbortSignal.timeout((timeoutSec + 25) * 1000),
    });
    if (r.status === 429) { await sleep(3000 * (attempt + 1)); continue; }
    if (r.status === 401) return [401, { error: "Your Bouncer API key was rejected. Check the key in .env." }];
    if (r.status === 402) return [402, { error: "You're out of Bouncer credits. Top up to keep checking." }];
    if (!r.ok) return [502, { error: `Bouncer returned an error (${r.status}).` }];
    return [200, await r.json()];
  }
  return [429, { error: "Bouncer is busy right now." }];
}

const sleep = ms => new Promise(s => setTimeout(s, ms));

// --- Mochi's three answers: safe / risk / dead (never "unknown") ---
const DEAD_REASONS = new Set(["invalid_email", "invalid_domain", "dns_error", "rejected_email", "no_mail_server"]);
function classify(d) {
  if (d.status === "deliverable") return "safe";
  if (d.status === "undeliverable") return "dead";
  if (d.status === "risky") return "risk";
  return DEAD_REASONS.has(d.reason) ? "dead" : "risk";
}

// Last resort when Bouncer can't give a clear answer: does the domain accept mail at all?
async function mailDomainCheck(domain) {
  if (!domain) return "none";
  try {
    const mx = await dns.resolveMx(domain);
    if (mx.some(x => x.exchange && x.exchange !== ".")) return "mx";
    if (mx.length) return "none";                    // "null MX" - domain says it accepts no mail
  } catch (e) {
    if (!["ENOTFOUND", "ENODATA", "NXDOMAIN"].includes(e.code)) return "error";   // DNS itself failed - don't call it dead
  }
  try { if ((await dns.resolve4(domain)).length) return "a"; } catch (e) {
    if (!["ENOTFOUND", "ENODATA", "NXDOMAIN"].includes(e.code)) return "error";
  }
  return "none";
}

// Ask Bouncer, and if the answer is "unknown" (or the call fails), keep trying with
// more patience. If it still can't tell, decide from the domain's mail records.
const PLAN = [10, 20, 30];          // Bouncer timeout (seconds) per try
const WAIT = [3000, 8000];          // pause between tries
async function verify(email) {
  let last = null, lastErr = null, tries = 0;
  for (let i = 0; i < PLAN.length; i++) {
    tries++;
    try {
      const [code, body] = await callBouncer(email, PLAN[i]);
      if (code === 401 || code === 402) return [code, body];
      if (code === 200) {
        last = body;
        if (body.status && body.status !== "unknown") return [200, finish(body, tries)];
        if (DEAD_REASONS.has(body.reason)) break;     // e.g. dns_error - retrying won't help, go check DNS
      } else lastErr = body.error;
    } catch (err) { lastErr = err.name === "TimeoutError" ? "Bouncer took too long" : "Couldn't reach Bouncer"; }
    if (i < WAIT.length) await sleep(WAIT[i]);
  }

  // Still no clear answer - look up the domain ourselves
  const domain = (last?.domain?.name || email.split("@").pop() || "").toLowerCase();
  const dnsResult = await mailDomainCheck(domain);
  const base = last || { email, domain: { name: domain } };
  if (dnsResult === "none")
    return [200, finish({ ...base, status: "undeliverable", reason: "no_mail_server" }, tries, last?.status)];
  return [200, finish({ ...base, reason: "unverified", score: typeof base.score === "number" ? base.score : null,
    _note: lastErr || "The mail server never gave a clear answer" }, tries, last?.status || "error", "risk")];
}

function finish(d, tries, rawStatus, force) {
  const status = force || classify(d);
  return { ...d, bouncerStatus: rawStatus || d.status, bouncerReason: d.reason, status, tries };
}

// ================= APOLLO: did this person change jobs? =================
// Uses Apollo's Bulk People Enrichment (up to 10 people per call, 1 credit per person found).
const FREE = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|proton|protonmail|gmx|mail|zoho|yandex)\./i;
function rootDomain(d) {
  d = String(d || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  const p = d.split(".");
  if (p.length > 2 && /^(co|com|net|org|gov|ac|edu)$/.test(p[p.length - 2]) && p[p.length - 1].length === 2) return p.slice(-3).join(".");
  return p.slice(-2).join(".");
}
const real = e => e && !/email_not_unlocked|domain\.com$/i.test(e) ? e : "";

// Does the old email's domain now redirect to the new company's site? (= company acquired / renamed)
async function redirectsTo(oldDomain, newDomain) {
  for (const u of [`https://${oldDomain}`, `http://${oldDomain}`]) {
    try {
      const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(10000), headers: { "User-Agent": "Mozilla/5.0" } });
      return rootDomain(new URL(r.url).hostname) === newDomain;
    } catch { /* try next */ }
  }
  return false;
}
const squash = x => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const RESULT_VERSION = 3;
const CONTACTS_URL = "https://api.apollo.io/api/v1/contacts/search";
const slug = u => { const m = String(u || "").toLowerCase().match(/linkedin\.com\/in\/([^/?#]+)/); return m ? decodeURIComponent(m[1]) : ""; };
const fullName = x => x ? (x.name || [x.first_name, x.last_name].filter(Boolean).join(" ")) : "";

// POST to Apollo with retry on rate limits. Returns [status, json or text]
async function apolloPost(url, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "x-api-key": APOLLO_KEY },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
    });
    if (r.status === 429) { await sleep(5000 * (attempt + 1)); continue; }
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return [r.status, json ?? text];
  }
  return [429, "rate limited"];
}

// Step 1 (free): is this email one of YOUR saved Apollo contacts?
async function findContact(email) {
  const [code, body] = await apolloPost(CONTACTS_URL, { q_keywords: email, page: 1, per_page: 10 });
  if (code === 401 || code === 403) throw Object.assign(new Error("no contacts access"), { perm: true, detail: typeof body === "string" ? body : JSON.stringify(body).slice(0, 300) });
  if (code !== 200 || !body) return null;
  const e = email.toLowerCase();
  const list = body.contacts || [];
  return list.find(c => [c.email, ...(c.contact_emails || []).map(x => x.email)].filter(Boolean).some(x => x.toLowerCase() === e)) || null;
}

function contactInfo(c) {
  return {
    name: fullName(c), title: c.title || "", company: c.organization_name || c.account?.name || "",
    linkedin: c.linkedin_url || "", personId: c.person_id || "",
    about: c.account?.short_description || c.organization?.short_description || "",
  };
}

// Turn Apollo's person record into a simple answer for a dead email.
// ctx.contact = your saved Apollo contact (if found), ctx.matchedBy = how we asked Apollo
async function jobAnswer(email, person, ctx = {}) {
  const now = new Date().toISOString();
  const oldDomain = rootDomain(email.split("@").pop());
  const contact = ctx.contact || null;
  const meta = { checked: now, v: RESULT_VERSION, matchedBy: ctx.matchedBy || "email", contact: contact || undefined };
  if (!person) return { ...meta, job: "not_found",
    evidence: contact ? `Apollo has no current record for ${contact.name} — your saved contact says ${[contact.title, contact.company].filter(Boolean).join(" at ")}` : "" };

  const org = person.organization || {};
  const hist = person.employment_history || [];
  const cur = hist.find(j => j.current) || null;
  const company = org.name || cur?.organization_name || "";
  const newDomain = rootDomain(org.primary_domain || org.website_url || "");
  const newEmail = real(person.email);
  const stems = [squash(oldDomain.split(".")[0]), squash(contact?.company)].filter(x => x && x.length >= 3);
  const isOld = name => { const n = squash(name); return !!n && stems.some(st => n.includes(st) || (st.includes(n) && n.length >= 4)); };
  const oldJob = hist.find(j => !j.current && isOld(j.organization_name));
  const emails = [person.email, ...(person.personal_emails || [])].filter(Boolean).map(e => e.toLowerCase());
  const name = fullName(person);

  const base = {
    ...meta, name,
    title: person.title || cur?.title || "", company, companyDomain: newDomain, since: cur?.start_date || "",
    newEmail: newEmail && newEmail.toLowerCase() !== email.toLowerCase() ? newEmail : "",
    emailStatus: person.email_status || "", linkedin: person.linkedin_url || "",
    leftOn: oldJob?.end_date || "",
    history: hist.slice(0, 6).map(j => ({ title: j.title || "", org: j.organization_name || "", from: j.start_date || "", to: j.current ? "now" : j.end_date || "" })),
  };

  // Is this the same person as your saved contact?
  if (contact) {
    const same = (contact.personId && person.id === contact.personId) || (slug(contact.linkedin) && slug(contact.linkedin) === slug(person.linkedin_url)) ||
      (squash(contact.name) && squash(contact.name) === squash(name));
    if (!same) return { ...base, job: "unconfirmed", evidence: `Apollo returned ${name || "someone"}, but your saved contact is ${contact.name} — different person, ignore this result` };
  }

  const evidence = [];
  if (contact) evidence.push(`same person as your saved contact (${contact.personId && person.id === contact.personId ? "Apollo ID" : slug(contact.linkedin) && slug(contact.linkedin) === slug(person.linkedin_url) ? "LinkedIn" : "name"} matches)`);
  else if (emails.includes(email.toLowerCase())) evidence.push("Apollo has this exact email on their record");
  if (oldJob) evidence.push(`their job history shows they left ${oldJob.organization_name}`);
  const why = extra => [extra, ...evidence].filter(Boolean).join("; ");

  if (FREE.test(oldDomain)) return { ...base, job: base.newEmail ? "new_email" : "same", evidence: why() };
  if (!company && !cur) return { ...base, job: evidence.length ? "no_current_job" : "unconfirmed", evidence: why() || `Nothing on this record links them to ${oldDomain}` };
  if ((newDomain && newDomain === oldDomain) || isOld(company)) return { ...base, job: base.newEmail ? "new_email" : "same", evidence: why() };

  // Different company now. Was the old company bought / renamed into the new one?
  const aboutSaysAcquired = contact?.about && squash(company).length >= 4 && squash(contact.about).includes(squash(company).slice(0, 8));
  if (aboutSaysAcquired || (newDomain && await redirectsTo(oldDomain, newDomain)))
    return { ...base, job: "acquired", evidence: why(`${contact?.company || oldDomain} was acquired by / renamed to ${company} — they may still be with the same employer`) };
  if (oldJob || contact) return { ...base, job: "moved", evidence: why(contact ? `your saved contact lists them at ${contact.company || oldDomain}; Apollo now lists them at ${company}` : "") };
  if (evidence.length) return { ...base, job: "other_company",
    evidence: `Apollo has this email on ${name || "this person"}'s record and lists them at ${company}, but shows no job at ${oldDomain} and no date they moved — this may be the same employer after an acquisition or rename, not a job change` };
  return { ...base, job: "unconfirmed", evidence: `Apollo returned ${name || "someone"} at ${company || "another company"}, but nothing on the record links them to ${oldDomain} — this may be a different person` };
}

async function apolloLookup(people) {
  const log = { at: new Date().toISOString(), contacts: [], sent: null, response: null };
  // Step 1: your saved Apollo contacts (free)
  let contactsNote = "";
  const contacts = [];
  for (const p of people) {
    try { const c = await findContact(p.email); contacts.push(c ? contactInfo(c) : null); log.contacts.push({ email: p.email, found: c ? { id: c.id, name: fullName(c), title: c.title, org: c.organization_name, linkedin: c.linkedin_url, person_id: c.person_id } : null }); }
    catch (e) {
      if (e.perm) { contactsNote = "Couldn't read your saved Apollo contacts with this API key (it needs access to contacts search — a Master API key works), so these were looked up by email only."; log.contactsError = e.detail; while (contacts.length < people.length) contacts.push(null); break; }
      contacts.push(null);
    }
  }
  // Step 2: enrich - by your contact's Apollo ID / LinkedIn / name when we have it, not by the (dead) email
  const how = [];
  const details = people.map((p, i) => {
    const c = contacts[i];
    if (c && (c.personId || c.linkedin || c.name)) {
      how.push("contact");
      const d = {};
      if (c.personId) d.id = c.personId;
      if (c.linkedin) d.linkedin_url = c.linkedin;
      if (c.name) { const [f, ...l] = c.name.split(" "); d.first_name = f; if (l.length) d.last_name = l.join(" "); }
      if (c.company) d.organization_name = c.company;
      return d;
    }
    const d = { email: p.email };
    for (const k of ["first_name", "last_name", "name", "organization_name", "linkedin_url"]) if (p[k]) d[k] = String(p[k]).slice(0, 200);
    how.push(d.first_name || d.name || d.linkedin_url ? "csv" : "email");
    return d;
  });
  log.sent = details;
  const [code, body] = await apolloPost(APOLLO_URL, { details });
  log.status = code; log.response = body;
  try { fs.mkdirSync(path.join(__dirname, "data"), { recursive: true }); fs.appendFileSync(path.join(__dirname, "data", "apollo-log.jsonl"), JSON.stringify(log) + "\n"); } catch {}
  if (code === 401 || code === 403) return [code, { error: "Apollo rejected the API key" + (/master/i.test(JSON.stringify(body)) ? " — this needs a Master API key (Apollo → Settings → Integrations → API)." : ". Check APOLLO_API_KEY in .env.") }];
  if (code === 402 || (code === 422 && /credit/i.test(JSON.stringify(body)))) return [402, { error: "You're out of Apollo credits." }];
  if (code === 429) return [429, { error: "Apollo is busy right now. Wait a minute and try again." }];
  if (code !== 200 || !body || typeof body !== "object") return [502, { error: `Apollo returned an error (${code}).` }];
  const matches = body.matches || [];
  const results = await Promise.all(people.map(async (p, i) => {
    const m = matches.length === people.length ? matches[i] : null;
    return { email: p.email, apollo: await jobAnswer(p.email, m, { contact: contacts[i], matchedBy: how[i] }) };
  }));
  return [200, { results, credits: body.credits_consumed ?? null, note: contactsNote }];
}

async function apolloDemo(p) {
  const e = p.email.toLowerCase(), h = [...e].reduce((n, c) => n + c.charCodeAt(0), 0) % 4;
  const fn = (p.first_name || e.split("@")[0]).replace(/\W.*/, "");
  if (h === 0) return { email: p.email, apollo: { job: "not_found", checked: new Date().toISOString() } };
  if (h === 3) return { email: p.email, apollo: { job: "same", checked: new Date().toISOString(), name: fn, title: "Marketing Manager", company: "Same Co", emailStatus: "" } };
  return { email: p.email, apollo: await jobAnswer(p.email, { name: fn, title: "Head of Growth", email: `${fn}@newco-example.com`, email_status: "verified",
    organization: { name: "NewCo (sample)", primary_domain: "newco-example.com" }, linkedin_url: "https://www.linkedin.com/in/sample",
    employment_history: [{ current: true, organization_name: "NewCo (sample)", title: "Head of Growth", start_date: "2025-03-01" },
      { current: false, organization_name: p.email.split("@").pop().split(".")[0], title: "Manager", start_date: "2019-01-01", end_date: "2025-02-01" }] }) };
}

// Sample answers for demo mode
function demo(email) {
  const e = email.toLowerCase();
  const [user, domain = ""] = e.split("@");
  const base = {
    email, domain: { name: domain, acceptAll: "no", disposable: "no", free: /gmail|yahoo|outlook|hotmail/.test(domain) ? "yes" : "no" },
    account: { role: "no", disabled: "no", fullMailbox: "no" },
    provider: domain.includes("gmail") ? "google.com" : "", toxic: "unknown", toxicity: 0,
  };
  if (/gmial|gmal|gamil/.test(domain)) return { ...base, status: "undeliverable", reason: "invalid_domain", score: 0, didYouMean: `${user}@gmail.com` };
  if (/bad|nope|bounce|fake/.test(e)) return { ...base, status: "undeliverable", reason: "rejected_email", score: 0 };
  if (/^(info|admin|sales|support|hello|contact)$/.test(user)) return { ...base, status: "risky", reason: "low_quality", score: 60, account: { ...base.account, role: "yes" } };
  if (/mailinator|tempmail|10minute/.test(domain)) return { ...base, status: "risky", reason: "low_quality", score: 30, domain: { ...base.domain, disposable: "yes" } };
  if (/unknown|maybe/.test(e)) return { ...base, status: "unknown", reason: "unavailable_smtp", score: 50 };
  return { ...base, status: "deliverable", reason: "accepted_email", score: 96 };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/health") return send(res, 200, { demo: DEMO, apollo: APOLLO_KEY ? "live" : "demo" });

  if (url.pathname === "/api/apollo" && req.method === "POST") {
    let people;
    try { people = ((await readJSON(req, 1024 * 1024)).people || []).filter(p => p && typeof p.email === "string" && p.email.includes("@")).slice(0, 10); }
    catch { return send(res, 400, { error: "Bad request" }); }
    if (!people.length) return send(res, 400, { error: "No emails to look up." });
    if (!APOLLO_KEY) { await sleep(600); return send(res, 200, { results: await Promise.all(people.map(apolloDemo)), demo: true }); }
    try { const [code, body] = await apolloLookup(people); return send(res, code, body); }
    catch (err) { return send(res, 504, { error: err.name === "TimeoutError" ? "Apollo took too long. Try again." : "Couldn't reach Apollo. Check your internet connection." }); }
  }

  // ---- Salesforce: fetch expired Leads / Contacts, push results back ----
  if (url.pathname.startsWith("/api/sf/")) {
    const what = url.pathname.slice(8);
    try {
      if (what === "status") return send(res, 200, await salesforce.status());
      if (what === "login") { res.writeHead(302, { Location: salesforce.loginUrl(`http://localhost:${PORT}`) }); return res.end(); }
      if (what === "callback") {
        let msg = "Connected to Salesforce. You can close this tab and go back to Mochi.";
        try { await salesforce.callback(url.searchParams); } catch (e) { msg = e.message; }
        return send(res, 200, `<!doctype html><meta charset="utf-8"><title>Mochi</title><body style="font:600 17px system-ui;padding:40px;max-width:560px;margin:auto;background:#F2EADF;color:#3B2F2A"><p>${msg.replace(/</g, "&lt;")}</p><p><a href="/#salesforce">Back to Mochi</a></p><script>setTimeout(()=>location.href="/#salesforce",${/Connected/.test(msg) ? 1200 : 60000})</script>`, "text/html; charset=utf-8");
      }
      if (what === "logout" && req.method === "POST") { salesforce.logout(); return send(res, 200, { ok: true }); }
      if (what === "fetch") {
        const object = url.searchParams.get("object");
        return send(res, 200, await salesforce.fetchExpired(object, { months: url.searchParams.get("months"),
          includeBlank: url.searchParams.get("blank") !== "0", limit: url.searchParams.get("limit") }));
      }
      if (what === "match" && req.method === "POST") {
        const b = await readJSON(req, 5 * 1024 * 1024);
        return send(res, 200, await salesforce.matchEmails(b.emails));
      }
      if (what === "update" && req.method === "POST") {
        const b = await readJSON(req, 5 * 1024 * 1024);
        return send(res, 200, { results: await salesforce.update(b.object, b.items) });
      }
      return send(res, 404, { error: "Not found" });
    } catch (err) {
      return send(res, err.needsLogin || err.setup ? 401 : 502, { error: err.name === "TimeoutError" ? "Salesforce took too long to answer." : err.message, needsLogin: !!err.needsLogin });
    }
  }

  if (url.pathname === "/api/credits") {
    if (DEMO) return send(res, 200, { credits: null, demo: true });
    try {
      const r = await fetch(CREDITS_URL, { headers: { "x-api-key": API_KEY } });
      return send(res, r.ok ? 200 : r.status, r.ok ? await r.json() : { error: "Couldn't load credits." });
    } catch { return send(res, 502, { error: "Couldn't reach Bouncer." }); }
  }

  if (url.pathname === "/api/verify") {
    const email = (url.searchParams.get("email") || "").trim();
    if (!email || email.length > 254) return send(res, 400, { error: "Please enter an email address." });
    if (DEMO) { await new Promise(s => setTimeout(s, url.searchParams.get("bulk") ? 250 + Math.random() * 500 : 1400)); const d = demo(email); return send(res, 200, { ...finish(d.status === "unknown" ? { ...d, reason: "unverified" } : d, 1, d.status, d.status === "unknown" ? "risk" : undefined), _demo: true }); }
    try {
      const [code, body] = await verify(email);
      return send(res, code, body);
    } catch (err) {
      return send(res, 500, { error: "Something went wrong checking that email: " + (err.message || err) });
    }
  }

  // Website check — no API key needed, runs from your own computer
  if (url.pathname === "/api/site") {
    const site = (url.searchParams.get("url") || "").trim();
    if (!site || site.length > 2000) return send(res, 400, { error: "Please enter a website address." });
    try { return send(res, 200, await checkSite(site)); }
    catch (err) { return send(res, 500, { error: "Something went wrong checking that site: " + (err.message || err) }); }
  }

  // --- saved runs (history) ---
  if (url.pathname.startsWith("/api/runs") || url.pathname === "/api/singles") {
    try {
      if (url.pathname === "/api/singles" && req.method === "POST") {
        const b = await readJSON(req);
        return send(res, 200, store.addSingle({ ...b, demo: b.type === "emails" && DEMO }));
      }
      const id = url.pathname.split("/")[3];
      if (!id) {
        if (req.method === "GET") return send(res, 200, store.list());
        if (req.method === "POST") { const b = await readJSON(req); return send(res, 200, store.create({ ...b, demo: b.type === "emails" && DEMO })); }
      } else {
        if (!store.okId(id)) return send(res, 400, { error: "Bad id" });
        const sub = url.pathname.split("/")[4];
        if (req.method === "GET" && !sub) { const r = store.get(id); return r ? send(res, 200, r) : send(res, 404, { error: "Run not found" }); }
        if (req.method === "POST" && sub === "results") { const m = store.append(id, await readJSON(req)); return m ? send(res, 200, m) : send(res, 404, { error: "Run not found" }); }
        if (req.method === "DELETE" && !sub) { store.remove(id); return send(res, 200, { ok: true }); }
      }
      return send(res, 405, { error: "Not allowed" });
    } catch (err) { return send(res, 500, { error: "Couldn't save: " + err.message }); }
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return send(res, 200, fs.readFileSync(path.join(__dirname, "index.html")), "text/html; charset=utf-8");
  }
  send(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`\n  Mochi is running at http://localhost:${PORT}`);
  console.log(DEMO ? "  (demo mode — add BOUNCER_API_KEY to .env for real checks)\n" : "  (live mode — using your Bouncer API key)\n");
});
