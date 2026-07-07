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
      if (fs.existsSync(p)) return (JSON.parse(fs.readFileSync(p, 'utf8')).sites) || [];
    }
  } catch (e) { /* fall through */ }
  return [];
}

/* live registry from the home repo; returns { sites, sha } (sha is null when served from fallback) */
async function getRegistry() {
  try {
    const r = await gh(`/repos/${HOME_REPO}/contents/${REGISTRY_PATH}?ref=${HOME_BRANCH}`);
    if (r.status === 200) {
      const json = JSON.parse(Buffer.from(r.json.content, 'base64').toString('utf8'));
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

function checkAuth(req) {
  const key = req.headers['x-admin-key'] || '';
  const pass = process.env.ADMIN_PASSWORD || '';
  if (!key || !pass) return false;
  const a = Buffer.from(String(key));
  const b = Buffer.from(String(pass));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function gh(path, opts = {}) {
  const res = await fetch('https://api.github.com' + path, {
    ...opts,
    headers: {
      Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jrd-portfolio-admin',
      ...(opts.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

module.exports = { HOME_REPO, HOME_BRANCH, REGISTRY_PATH, bundledSites, getRegistry, getSites, getSite, canRead, canWrite, checkAuth, gh };
