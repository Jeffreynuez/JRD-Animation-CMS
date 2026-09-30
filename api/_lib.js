// Shared helpers for the JRD admin API (files starting with _ are not exposed as routes)
'use strict';
const crypto = require('crypto');

/* ---- multi-site registry ----
   The registry (data/sites.json) lives in the HOME repo (the CMS deployment repo).
   We read it LIVE from GitHub so a newly-added site is usable immediately (no rebuild wait),
   falling back to env SITES_JSON or the bundled copy if GitHub is unreachable.
   Each site: { id, label, repo, branch?, liveUrl, schema?, files[] }.
   The browser never names a repo — it sends a site id that we resolve here. */
const HOME_REPO = process.env.GITHUB_REPO || 'Jeffreynuez/JRD-Online_Portfolio';
const HOME_BRANCH = process.env.GITHUB_BRANCH || 'main';
const REGISTRY_PATH = 'data/sites.json';

function bundledSites() {
  if (process.env.SITES_JSON) {
    try { const j = JSON.parse(process.env.SITES_JSON); return j.sites || j || []; } catch (e) { /* fall through */ }
  }
  try { return require('../data/sites.json').sites || []; } catch (e) { /* fall through */ }
  try {
    const fs = require('fs'), path = require('path');
    for (const p of [path.join(__dirname, '../data/sites.json'), path.join(process.cwd(), 'data/sites.json')]) {
      if (fs.existsSync(p)) return (parseJson(fs.readFileSync(p, 'utf8')).sites) || [];
    }
  } catch (e) { /* fall through */ }
  return [];
}

/* live registry from the home repo; returns { sites, sha } (sha is null when served from fallback) */
async function getRegistry() {
  try {
    const r = await gh(`/repos/${HOME_REPO}/contents/${REGISTRY_PATH}?ref=${HOME_BRANCH}`);
    if (r.status === 200) {
      const json = parseB64Json(r.json.content);
      return { sites: json.sites || [], sha: r.json.sha };
    }
  } catch (e) { /* fall through to bundle */ }
  return { sites: bundledSites(), sha: null };
}
async function getSites() { return (await getRegistry()).sites; }
async function getSite(id) {
  const sites = await getSites();
  return id ? (sites.find(s => s.id === id) || null) : (sites[0] || null);
}

/* files always readable (so the editor can fetch a site's schema) regardless of allow-list */
const ALWAYS_READ = ['_schema.json', 'sites.json'];
const canRead = (site, file) => ALWAYS_READ.includes(file) || (!!site && Array.isArray(site.files) && site.files.includes(file));
const canWrite = (site, file) => !!site && Array.isArray(site.files) && site.files.includes(file);
/* what a registry file name may look like: pages.json, es/pages.json. No dots
   in folder names, so "../" can never reach a GitHub path. */
const FILE_RE = /^[\w-]+(\/[\w-]+)*\.json$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/* Every repo file is JSON; strip a UTF-8 BOM first (Windows PowerShell 5.1
   writes one with -Encoding UTF8, and JSON.parse rejects it). Throws on bad JSON. */
const parseJson = text => JSON.parse(String(text == null ? '' : text).replace(/^\uFEFF/, ''));
const parseB64Json = b64 => parseJson(Buffer.from(String(b64 || ''), 'base64').toString('utf8'));

function checkAuth(req) {
  /* 1. legacy shared admin key (kept during the migration to accounts) */
  const key = req.headers['x-admin-key'] || '';
  const pass = process.env.ADMIN_PASSWORD || '';
  if (key && pass) {
    const a = Buffer.from(String(key));
    const b = Buffer.from(String(pass));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  /* 2. account session cookie (lazy require avoids a circular import at load) */
  try {
    const s = require('./_auth.js').sessionFromReq(req);
    if (s && s.purpose === 'session' && s.uid) return true;
  } catch (e) { /* auth not configured yet */ }
  return false;
}

/* Conditional-request cache. GitHub does not count a 304 against the token's
   5000/h budget (shared by every managed site), so each GET re-sends the ETag
   it last saw for that path and reuses the body on a 304. Freshness is
   unchanged, GitHub still decides on every call; the cache only lives as long
   as a warm function instance. Skipped for writes, for redirect reads (the
   zipball) and for bodies over ~300 KB, and capped at 60 paths (oldest out).
   A cached body is shared between calls: treat r.json as read-only. */
const ETAGS = new Map();
const ETAG_MAX = 60, ETAG_MAX_BYTES = 300000;
async function gh(path, opts = {}) {
  const get = !opts.method || String(opts.method).toUpperCase() === 'GET';
  const cacheable = get && !opts.redirect;
  const hit = cacheable ? ETAGS.get(path) : null;
  const res = await fetch('https://api.github.com' + path, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jrd-portfolio-admin',
      ...(hit ? { 'If-None-Match': hit.etag } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 304 && hit) return { status: 200, json: hit.json, headers: res.headers };
  const json = await res.json().catch(() => ({}));
  const etag = cacheable && res.status === 200 && res.headers && typeof res.headers.get === 'function' && res.headers.get('etag');
  if (etag && !(json && json.size > ETAG_MAX_BYTES)) {
    ETAGS.delete(path); ETAGS.set(path, { etag, json });
    if (ETAGS.size > ETAG_MAX) ETAGS.delete(ETAGS.keys().next().value);
  } else if (cacheable && res.status !== 200) ETAGS.delete(path);
  /* headers are returned so callers can read things the body does not carry,
     e.g. the Location of GitHub's zipball redirect. Nothing else reads it. */
  return { status: res.status, json, headers: res.headers };
}

module.exports = { HOME_REPO, HOME_BRANCH, REGISTRY_PATH, bundledSites, getRegistry, getSites, getSite, canRead, canWrite, checkAuth, gh,
  FILE_RE, SLUG_RE, parseJson, parseB64Json };
