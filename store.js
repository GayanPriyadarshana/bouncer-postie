// Saves every run (lists and single checks) to disk so results survive restarts.
//
//   data/runs/<id>/meta.json      small summary (rewritten as the run progresses)
//   data/runs/<id>/input.json     the uploaded list (written once)
//   data/runs/<id>/results.jsonl  one line per checked item (append-only)

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "data", "runs");
fs.mkdirSync(ROOT, { recursive: true });

const okId = id => /^[\w-]{4,80}$/.test(id || "");
const dir = id => path.join(ROOT, id);
const newId = () => new Date().toISOString().slice(0, 10) + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// emails: safe / risk / dead (older saved runs used Bouncer's raw words - map them)
const LEGACY = { deliverable: "safe", risky: "risk", undeliverable: "dead", unknown: "risk" };
const statusOf = (type, r) => type === "emails" ? (LEGACY[r.status] || r.status || "risk") : (r.verdict || "unknown");

function readMeta(id) {
  try { return JSON.parse(fs.readFileSync(path.join(dir(id), "meta.json"), "utf8")); } catch { return null; }
}
function writeMeta(id, meta) {
  const f = path.join(dir(id), "meta.json");
  fs.writeFileSync(f + ".tmp", JSON.stringify(meta));
  fs.renameSync(f + ".tmp", f);
}
const cache = new Map();   // id -> Map(key -> result), so big runs aren't re-read on every save
function resultMap(id) {
  if (cache.has(id)) return cache.get(id);
  const f = path.join(dir(id), "results.jsonl");
  const map = new Map();
  if (!fs.existsSync(f)) { cache.set(id, map); return map; }
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line) continue;
    try { const x = JSON.parse(line); map.set(x.k, x.r); } catch { /* skip a half-written line */ }
  }
  if (cache.size > 20) cache.delete(cache.keys().next().value);
  cache.set(id, map);
  return map;
}
const readResults = id => [...resultMap(id)].map(([k, r]) => ({ k, r }));
function summarize(type, results) {
  const counts = {}; let linkedin = 0, fixes = 0;
  for (const { r } of results) {
    const s = statusOf(type, r); counts[s] = (counts[s] || 0) + 1;
    if (r.linkedin_url) linkedin++;
    if (r.working_variant) fixes++;
  }
  return { counts, done: results.length, linkedin, fixes };
}

function list() {
  return fs.readdirSync(ROOT).filter(okId).map(readMeta).filter(Boolean)
    .sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
}

function create({ type, name, input, total, demo }) {
  if (!["emails", "sites"].includes(type)) throw new Error("bad type");
  const id = newId(); const now = new Date().toISOString();
  fs.mkdirSync(dir(id), { recursive: true });
  fs.writeFileSync(path.join(dir(id), "input.json"), JSON.stringify(input || {}));
  const meta = { id, type, kind: "list", name: name || "List", created: now, updated: now, status: "running", total: total || 0, done: 0, counts: {}, linkedin: 0, fixes: 0, demo: !!demo };
  writeMeta(id, meta);
  return meta;
}

function append(id, { results = [], status }) {
  const meta = readMeta(id); if (!meta) return null;
  const map = resultMap(id);
  if (results.length) {
    fs.appendFileSync(path.join(dir(id), "results.jsonl"), results.map(x => JSON.stringify({ k: x.k, r: x.r })).join("\n") + "\n");
    for (const x of results) map.set(x.k, x.r);
  }
  Object.assign(meta, summarize(meta.type, readResults(id)), { updated: new Date().toISOString() });
  if (status) meta.status = status;
  writeMeta(id, meta);
  return meta;
}

// Single checks are grouped into one run per type per day
function addSingle({ type, key, result, demo }) {
  if (!["emails", "sites"].includes(type)) throw new Error("bad type");
  const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;  // local date
  const id = `single-${type}-${day}`;
  if (!readMeta(id)) {
    fs.mkdirSync(dir(id), { recursive: true });
    const now = new Date().toISOString();
    writeMeta(id, { id, type, kind: "single", name: `Single ${type === "emails" ? "email" : "website"} checks`, created: now, updated: now, status: "done", total: 0, done: 0, counts: {}, linkedin: 0, fixes: 0, demo: !!demo });
  }
  const meta = append(id, { results: [{ k: key, r: result }] });
  meta.total = meta.done; writeMeta(id, meta);
  return meta;
}

function get(id) {
  const meta = readMeta(id); if (!meta) return null;
  let input = {};
  try { input = JSON.parse(fs.readFileSync(path.join(dir(id), "input.json"), "utf8")); } catch {}
  return { meta, input, results: readResults(id) };
}

function remove(id) { cache.delete(id); fs.rmSync(dir(id), { recursive: true, force: true }); }

module.exports = { list, create, append, addSingle, get, remove, okId, ROOT };
