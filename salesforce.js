// Salesforce connection for Mochi: fetch Leads / Contacts whose email verification has
// expired, and write the new verification results back.
//
// .env settings
//   SF_CLIENT_ID      Consumer Key of the Connected App / External Client App
//   SF_CLIENT_SECRET  Consumer Secret
//   SF_DOMAIN         Your org's My Domain URL, e.g. https://yourcompany.my.salesforce.com
//                     (sandbox: https://yourcompany--sandboxname.sandbox.my.salesforce.com)
//   SF_AUTH           optional: "client_credentials" (keys only, no login) or "login" (sign in once in the browser).
//                     Default: use keys only; if Salesforce refuses, the app offers "Sign in with Salesforce".
//   SF_API_VERSION    optional, default v62.0
//
// Keys-only ("client credentials") needs a one-time setting in Salesforce Setup:
//   App Manager → your app → Manage → Edit Policies → Client Credentials Flow → Run As = an integration user,
//   and in the app's OAuth settings "Enable Client Credentials Flow" must be ticked.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CLIENT_ID = process.env.SF_CLIENT_ID || "";
const CLIENT_SECRET = process.env.SF_CLIENT_SECRET || "";
const RAW_DOMAIN = (process.env.SF_DOMAIN || "").trim().replace(/\/+$/, "");
const DOMAIN = RAW_DOMAIN && !/^https?:\/\//i.test(RAW_DOMAIN) ? "https://" + RAW_DOMAIN : RAW_DOMAIN;
const AUTH_MODE = (process.env.SF_AUTH || "auto").toLowerCase();
const API = process.env.SF_API_VERSION || "v62.0";
// Salesforce sets Email_Verified_Date__c itself when the status changes, so by default Mochi only writes the status.
// Set SF_WRITE_DATE=1 in .env to also write today's date.
const WRITE_DATE = process.env.SF_WRITE_DATE === "1";
const DEMO = !CLIENT_ID || process.env.SF_DEMO === "1";
const LOGIN_BASE = DOMAIN || process.env.SF_LOGIN_URL || "https://login.salesforce.com";
const TOKEN_FILE = path.join(__dirname, "data", "salesforce-auth.json");

const OBJECTS = {
  Lead:    { id18: "Lead_ID_18_Digit__c",    extra: ["Name", "Company"], where: "IsConverted = false" },
  Contact: { id18: "Contact_ID_18_Digit__c", extra: ["Name", "Account.Name"], where: "" },
};
const STATUS_F = "Email_Verification_Status__c", DATE_F = "Email_Verified_Date__c";

let session = null;           // { access_token, instance_url, how }
let lastError = "";
let pkce = null;              // { verifier, state, redirect }

const sfError = (msg, extra = {}) => Object.assign(new Error(msg), extra);

function readSaved() { try { return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")); } catch { return null; } }
function writeSaved(x) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  if (x) fs.writeFileSync(TOKEN_FILE, JSON.stringify(x)); else try { fs.unlinkSync(TOKEN_FILE); } catch {}
}

async function tokenCall(base, params) {
  const r = await fetch(`${base}/services/oauth2/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(30000),
  });
  const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch {}
  if (!r.ok || !j.access_token) throw sfError(explainTokenError(j, r.status, text), { oauth: j.error || r.status });
  return j;
}

function explainTokenError(j, status, text) {
  const d = `${j.error || ""} ${j.error_description || ""}`.trim() || `${status} ${String(text).slice(0, 200)}`;
  if (/client credentials/i.test(d) && /enabled|user/i.test(d))
    return "Salesforce hasn't switched on keys-only access for this app yet. In Setup → App Manager → your app → Manage → Edit Policies, set a \"Run As\" user for the Client Credentials Flow (and tick \"Enable Client Credentials Flow\" in the app's OAuth settings). Or click \"Sign in with Salesforce\" instead.";
  if (/not supported on this domain|unsupported_grant_type/i.test(d))
    return `Salesforce wants this call on your org's own address. Set SF_DOMAIN in .env to your My Domain URL (e.g. https://yourcompany.my.salesforce.com). (${d})`;
  if (/invalid_client_id|client identifier invalid/i.test(d))
    return "Salesforce doesn't recognise the Consumer Key. Check SF_CLIENT_ID — new or edited apps can take up to 10 minutes to start working.";
  if (/invalid_client|invalid client credentials/i.test(d))
    return "Salesforce rejected the Consumer Secret. Check SF_CLIENT_SECRET in .env.";
  if (/expired|revoked|inactive/i.test(d)) return "Your Salesforce sign-in expired. Sign in again.";
  return `Salesforce login failed: ${d}`;
}

// Get a working access token (cached)
async function auth(force) {
  if (session && !force) return session;
  session = null;
  if (!CLIENT_ID || !CLIENT_SECRET) throw sfError("Add SF_CLIENT_ID and SF_CLIENT_SECRET to .env, then restart Mochi.", { setup: true });
  const saved = readSaved();
  if (saved?.refresh_token && AUTH_MODE !== "client_credentials") {
    try {
      const j = await tokenCall(saved.login || LOGIN_BASE, { grant_type: "refresh_token", refresh_token: saved.refresh_token, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
      session = { access_token: j.access_token, instance_url: j.instance_url || saved.instance_url, how: "login" };
      return session;
    } catch (e) { writeSaved(null); if (AUTH_MODE === "login") throw sfError(e.message, { needsLogin: true }); }
  }
  if (AUTH_MODE === "login") throw sfError("Sign in with Salesforce to connect.", { needsLogin: true });
  if (!DOMAIN) throw sfError("Add SF_DOMAIN to .env (your org's My Domain URL, e.g. https://yourcompany.my.salesforce.com) so Mochi can connect with the keys alone — or click \"Sign in with Salesforce\".", { needsLogin: true, setup: true });
  try {
    const j = await tokenCall(DOMAIN, { grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
    session = { access_token: j.access_token, instance_url: j.instance_url || DOMAIN, how: "keys" };
    return session;
  } catch (e) { throw sfError(e.message, { needsLogin: AUTH_MODE !== "client_credentials" }); }
}

// Call the REST API; retry once with a fresh token on 401
async function sf(pathOrUrl, opts = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await auth(attempt > 0);
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : s.instance_url + pathOrUrl;
    const r = await fetch(url, {
      ...opts,
      headers: { Authorization: `Bearer ${s.access_token}`, Accept: "application/json", ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) },
      signal: AbortSignal.timeout(120000),
    });
    if (r.status === 401 && attempt === 0) { session = null; continue; }
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
    if (!r.ok) {
      const m = Array.isArray(j) ? j.map(x => x.message).join("; ") : (j?.message || text.slice(0, 300));
      throw sfError(`Salesforce said: ${m || r.status}`, { status: r.status });
    }
    return j;
  }
}

// ---------- status / login ----------
async function status() {
  if (DEMO) return { demo: true, connected: true, how: "demo", instance: "Sample data (add SF_CLIENT_ID to .env to connect)" };
  try {
    const s = await auth();
    let user = "";
    try { const u = await sf("/services/oauth2/userinfo"); user = u.preferred_username || u.email || u.name || ""; } catch {}
    lastError = "";
    return { connected: true, how: s.how, instance: s.instance_url.replace(/^https?:\/\//, ""), user };
  } catch (e) {
    lastError = e.message;
    return { connected: false, error: e.message, needsLogin: !!e.needsLogin, setup: !!e.setup, canLogin: !!(CLIENT_ID && CLIENT_SECRET) };
  }
}

function loginUrl(origin) {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  pkce = { verifier, state: crypto.randomBytes(16).toString("hex"), redirect: `${origin}/api/sf/callback` };
  const q = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: pkce.redirect,
    code_challenge: challenge, code_challenge_method: "S256", state: pkce.state, prompt: "login consent" });
  return `${LOGIN_BASE}/services/oauth2/authorize?${q}`;
}

async function callback(params) {
  if (params.get("error")) throw sfError(`Salesforce sign-in was cancelled: ${params.get("error_description") || params.get("error")}`);
  if (!pkce || params.get("state") !== pkce.state) throw sfError("That sign-in link is stale. Go back to Mochi and click \"Sign in with Salesforce\" again.");
  const j = await tokenCall(LOGIN_BASE, { grant_type: "authorization_code", code: params.get("code"), client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET, redirect_uri: pkce.redirect, code_verifier: pkce.verifier });
  pkce = null;
  if (j.refresh_token) writeSaved({ refresh_token: j.refresh_token, instance_url: j.instance_url, login: LOGIN_BASE });
  session = { access_token: j.access_token, instance_url: j.instance_url, how: "login" };
}

function logout() { session = null; writeSaved(null); }

// ---------- fields ----------
const described = {};
async function describe(object) {
  if (described[object]) return described[object];
  const d = await sf(`/services/data/${API}/sobjects/${object}/describe`);
  const by = Object.fromEntries(d.fields.map(f => [f.name, f]));
  const info = f => by[f] ? { name: f, label: by[f].label, type: by[f].type, updateable: !!by[f].updateable,
    picklist: (by[f].picklistValues || []).filter(p => p.active).map(p => ({ value: p.value, label: p.label })), restricted: !!by[f].restrictedPicklist } : null;
  const cfg = OBJECTS[object];
  const out = { objUpdateable: d.updateable !== false, status: info(STATUS_F), date: info(DATE_F), id18: info(cfg.id18), hasConverted: !!by.IsConverted, hasCompany: !!by.Company };
  described[object] = out;
  return out;
}

function cutoffDate(months) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() - months);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- fetch expired records ----------
async function fetchExpired(object, { months = 8, includeBlank = true, limit = 0 } = {}) {
  if (!OBJECTS[object]) throw sfError("Unknown object");
  months = Math.max(0, Math.min(120, Number(months) || 8));
  limit = Math.max(0, Math.min(50000, Number(limit) || 0));
  const cutoff = cutoffDate(months);
  if (DEMO) return demoFetch(object, cutoff, includeBlank, limit);

  const fi = await describe(object);
  if (!fi.status || !fi.date) throw sfError(`This ${object} object has no ${[!fi.status && STATUS_F, !fi.date && DATE_F].filter(Boolean).join(" or ")} field (or the connected user can't see it). Check the field's API name and field-level security.`);
  const cfg = OBJECTS[object];
  const fields = ["Id", "Email", STATUS_F, DATE_F, ...(fi.id18 ? [cfg.id18] : []), "Name", ...(object === "Lead" ? (fi.hasCompany ? ["Company"] : []) : ["Account.Name"])];
  const lit = fi.date.type === "datetime" ? `${cutoff}T00:00:00Z` : cutoff;
  const old = `${DATE_F} < ${lit}`;
  const where = ["Email != null", includeBlank ? `(${DATE_F} = null OR ${old})` : old];
  if (object === "Lead" && fi.hasConverted) where.push("IsConverted = false");
  const soql = `SELECT ${fields.join(", ")} FROM ${object} WHERE ${where.join(" AND ")} ORDER BY ${DATE_F} ASC NULLS FIRST, Id` + (limit ? ` LIMIT ${limit}` : "");

  let res = await sf(`/services/data/${API}/query?q=${encodeURIComponent(soql)}`);
  const rows = [...res.records];
  while (!res.done && res.nextRecordsUrl && rows.length < 50000) { res = await sf(res.nextRecordsUrl); rows.push(...res.records); }
  const records = rows.map(r => ({
    Id: r.Id, id18: fi.id18 ? r[cfg.id18] || "" : "", Name: r.Name || "", Company: r.Company || r.Account?.Name || "",
    Email: (r.Email || "").trim(), oldStatus: r[STATUS_F] ?? "", oldDate: r[DATE_F] ?? "",
  }));
  return { object, cutoff, months, includeBlank, total: res.totalSize, records, fields: fi, soql, writeDate: WRITE_DATE,
    warnings: [!fi.objUpdateable && `The Salesforce user Mochi connects as can read ${object}s but isn't allowed to edit them, so "Update in Salesforce" will fail. Give that user Edit access on ${object} (profile or permission set).`,
      !fi.id18 && `${cfg.id18} wasn't found on ${object}, so the Salesforce Id is used instead.`,
      !fi.status.updateable && `${STATUS_F} isn't editable for this user — updates will fail.`,
      WRITE_DATE && !fi.date.updateable && `${DATE_F} isn't editable for this user — updates will fail.`].filter(Boolean) };
}

// ---------- find Leads / Contacts by email (for the Emails section) ----------
const soqlStr = v => "'" + String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
async function matchEmails(emails) {
  emails = [...new Set((emails || []).map(e => String(e || "").trim().toLowerCase()).filter(e => e.includes("@") && e.length <= 254))].slice(0, 20000);
  if (DEMO) return demoMatch(emails);
  const out = {};
  for (const object of Object.keys(OBJECTS)) {
    const fi = await describe(object);
    if (!fi.status) { out[object] = { fields: fi, records: [], error: `${STATUS_F} isn't on ${object} (or this user can't see it).` }; continue; }
    const fields = ["Id", "Name", "Email", STATUS_F, ...(fi.date ? [DATE_F] : [])];
    const records = [];
    for (let i = 0; i < emails.length; i += 200) {
      const where = [`Email IN (${emails.slice(i, i + 200).map(soqlStr).join(",")})`];
      if (object === "Lead" && fi.hasConverted) where.push("IsConverted = false");
      let res = await sf(`/services/data/${API}/query?q=${encodeURIComponent(`SELECT ${fields.join(", ")} FROM ${object} WHERE ${where.join(" AND ")}`)}`);
      records.push(...res.records);
      while (!res.done && res.nextRecordsUrl) { res = await sf(res.nextRecordsUrl); records.push(...res.records); }
    }
    out[object] = { fields: fi, warning: !fi.objUpdateable ? `The connected Salesforce user can't edit ${object}s — updates will fail until it has Edit access.` : "",
      records: records.map(r => ({ Id: r.Id, Name: r.Name || "", Email: (r.Email || "").toLowerCase(), oldStatus: r[STATUS_F] ?? "", oldDate: fi.date ? r[DATE_F] ?? "" : "" })) };
  }
  return { objects: out, writeDate: WRITE_DATE };
}

// ---------- write results back ----------
async function update(object, items) {
  if (!OBJECTS[object]) throw sfError("Unknown object");
  items = (items || []).filter(x => x && /^[a-zA-Z0-9]{15,18}$/.test(x.id)).slice(0, 2000);
  if (DEMO) { await new Promise(s => setTimeout(s, 500)); return items.map((x, i) => i % 23 === 7 ? { id: x.id, success: false, error: "Sample error: FIELD_CUSTOM_VALIDATION_EXCEPTION" } : { id: x.id, success: true }); }
  const fi = await describe(object);
  const today = new Date(), ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const when = fi.date?.type === "datetime" ? today.toISOString() : ymd;
  const out = [];
  for (let i = 0; i < items.length; i += 200) {
    const chunk = items.slice(i, i + 200);
    const body = { allOrNone: false, records: chunk.map(x => ({ attributes: { type: object }, id: x.id, [STATUS_F]: String(x.status ?? "").slice(0, 255), ...(WRITE_DATE ? { [DATE_F]: when } : {}) })) };
    const res = await sf(`/services/data/${API}/composite/sobjects`, { method: "PATCH", body: JSON.stringify(body) });
    res.forEach((r, k) => out.push({ id: chunk[k].id, success: !!r.success, error: r.success ? "" : (r.errors || []).map(e => friendly(e, object)).join("; ") }));
  }
  return out;
}

function friendly(e, object) {
  const raw = `${e.statusCode}: ${e.message}`;
  if (/entity type cannot be updated/i.test(e.message || ""))
    return `No permission to edit ${object}s — give the Salesforce user Mochi connects as Edit access on ${object}. (${raw})`;
  if (e.statusCode === "INVALID_FIELD_FOR_INSERT_UPDATE" || /not.*(editable|writeable)/i.test(e.message || ""))
    return `A field can't be edited by this user — check field-level security on ${STATUS_F}${WRITE_DATE ? ` and ${DATE_F}` : ""}. (${raw})`;
  if (e.statusCode === "INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST")
    return `That status value isn't in the picklist — pick another under "What Mochi will write back". (${raw})`;
  return raw;
}

// ---------- demo data ----------
function demoMatch(emails) {
  const picklist = ["Valid", "Risky", "Invalid", "Unknown"].map(v => ({ value: v, label: v }));
  const fields = { status: { name: STATUS_F, label: "Email Verification Status", type: "picklist", updateable: true, picklist }, date: { name: DATE_F, label: "Email Verified Date", type: "date" }, objUpdateable: true };
  const pick = (k, pre) => emails.filter((e, i) => (i + k) % 3 !== 0).map((e, i) => ({ Id: (pre + "Dm" + String(5000 + i)).padEnd(15, "0"), Name: e.split("@")[0], Email: e, oldStatus: i % 2 ? "Valid" : "", oldDate: "" }));
  return { demo: true, writeDate: WRITE_DATE, objects: { Lead: { fields, records: pick(0, "00Q") }, Contact: { fields, records: pick(1, "003").slice(0, Math.ceil(emails.length / 3)) } } };
}

function demoFetch(object, cutoff, includeBlank, limit) {
  const people = ["Ava Perera", "Ben Silva", "Chen Wei", "Dina Fernando", "Eli Moss", "Fatima Khan", "Gus Ortega", "Hana Ito", "Ivan Petrov", "Jade Lim", "Kofi Mensah", "Lena Braun"];
  const emails = ["ava@acme.com", "ben@gmial.com", "info@acme.com", "dina@acme.com", "bad@acme.com", "fatima@globex.com", "maybe@acme.com", "hana@initech.com", "ivan@acme.com", "jade@globex.com", "kofi@umbrella.com", "lena@acme.com"];
  const pre = object === "Lead" ? "00Q" : "003";
  let records = people.map((n, i) => {
    const id = (pre + "Dm0000" + String(1000 + i)).padEnd(15, "0");
    const d = new Date(Date.now() - (250 + i * 30) * 864e5).toISOString().slice(0, 10);
    return { Id: id, id18: id + "AAA", Name: n, Company: ["Acme", "Globex", "Initech", "Umbrella"][i % 4], Email: emails[i],
      oldStatus: i % 3 === 0 ? "" : ["Valid", "Invalid", "Risky"][i % 3], oldDate: i % 4 === 0 ? "" : d };
  });
  if (!includeBlank) records = records.filter(r => r.oldDate);
  if (limit) records = records.slice(0, limit);
  const picklist = ["Valid", "Risky", "Invalid", "Unknown"].map(v => ({ value: v, label: v }));
  return { object, cutoff, includeBlank, total: records.length, records, demo: true,
    fields: { status: { name: STATUS_F, label: "Email Verification Status", type: "picklist", updateable: true, picklist }, date: { name: DATE_F, label: "Email Verified Date", type: "date", updateable: true } },
    warnings: [] };
}

module.exports = { status, loginUrl, callback, logout, fetchExpired, matchEmails, update, DEMO };
