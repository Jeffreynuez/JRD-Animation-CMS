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

/* Is there a valid account session cookie? The only way into the API. The
   old shared x-admin-key header is ignored everywhere now.
   (lazy require avoids a circular import at load) */
function checkAuth(req) {
  try {
    const s = require('./_auth.js').sessionFromReq(req);
    return !!(s && s.purpose === 'session' && s.uid);
  } catch (e) { return false; /* auth not configured yet */ }
}

/* First-run owner bootstrap ONLY (auth/login.js, and only while users.json has
   no users): does the submitted key match ADMIN_PASSWORD? Never a credential
   for any API call. Both sides are hashed first, so the compare is constant
   time and does not leak the key's length. */
function bootstrapKeyOk(key) {
  const pass = process.env.ADMIN_PASSWORD || '';
  if (!key || !pass) return false;
  const h = v => crypto.createHash('sha256').update(String(v)).digest();
  return crypto.timingSafeEqual(h(key), h(pass));
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
  /* noEtag: reads of a file at a commit never change, so the version history
     keeps its own cache for them instead of pushing hot paths out of this one */
  const cacheable = get && !opts.redirect && !opts.noEtag;
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

/* ===== history regions: BEGIN (copied verbatim into admin.html; a test compares the two) =====
   Which schema section owns which part of a data file. A block covers the
   value at its path ('' is the file's top level); a path belongs to the
   block with the longest matching path, so a nested block of another section
   (about.story inside about) keeps what is under it. Two blocks on the same
   path are told apart by their field keys. */
function histBlocks(sections){
 const out=[];
 (sections||[]).forEach(s=>{
  if(!s||s.group||!s.id)return;
  (s.blocks||[]).forEach(b=>{
   const file=(b&&b.file)||s.file;if(!file)return;
   const keys=Array.isArray(b.fields)?b.fields.map(x=>String((x&&x.k)||'').split('.')[0]).filter(Boolean):null;
   out.push({sec:String(s.id),file:String(file),path:String(b.path||''),keys});
  });
 });
 return out;
}
function histOwner(blocks,file,x){
 let best=[],bl=-1;
 blocks.forEach(b=>{
  if(b.file!==file)return;
  const P=b.path;
  if(!(P===''||x===P||x.indexOf(P+'.')===0))return;
  const L=P===''?0:P.split('.').length;
  if(L>bl){best=[b];bl=L;}else if(L===bl)best.push(b);
 });
 if(!best.length)return '';
 if(best.length>1){
  const P=best[0].path,rest=x===P?'':(P===''?x:x.slice(P.length+1)),k=rest.split('.')[0];
  const hit=best.find(b=>b.keys&&b.keys.indexOf(k)>=0);
  if(hit)return hit.sec;
 }
 return best[0].sec;
}
/* sections with a block strictly inside path x */
function histUnder(blocks,file,x){
 const out=[];
 blocks.forEach(b=>{if(b.file===file&&b.path!==x&&(x===''?b.path!=='':b.path.indexOf(x+'.')===0))out.push(b.sec);});
 return out;
}
/* the paths where a and b differ: leaves, plus any list whose length changed
   and any value whose type changed. An object that exists on one side only is
   walked key by key, so each added or removed field is reported on its own. */
function histChanged(a,b,x,out){
 if(a===b)return;
 const po=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
 if((po(a)||po(b))&&(po(a)||a===undefined)&&(po(b)||b===undefined)){
  const A=po(a)?a:{},B=po(b)?b:{};
  Array.from(new Set(Object.keys(A).concat(Object.keys(B)))).forEach(k=>histChanged(A[k],B[k],x?x+'.'+k:k,out));
  return;
 }
 if(Array.isArray(a)&&Array.isArray(b)&&a.length===b.length){a.forEach((v,i)=>histChanged(v,b[i],x?x+'.'+i:String(i),out));return;}
 if(JSON.stringify(a)===JSON.stringify(b))return;
 out.push(x);
}
/* section ids that changed between two versions of one file ('_other' for a
   change no section owns). styles.json is keyed by the edited element's
   stamp, "<file>#<path>", so each changed key maps to that element's section. */
function histParts(blocks,file,a,b){
 const out=new Set();
 if(file==='styles.json'){
  const A=(a&&typeof a==='object')?a:{},B=(b&&typeof b==='object')?b:{};
  new Set(Object.keys(A).concat(Object.keys(B))).forEach(k=>{
   if(JSON.stringify(A[k])===JSON.stringify(B[k]))return;
   const i=k.indexOf('#');
   out.add((i>0&&histOwner(blocks,k.slice(0,i),k.slice(i+1)))||'_other');
  });
  return Array.from(out);
 }
 const xs=[];
 histChanged(a==null?{}:a,b==null?{}:b,'',xs);
 xs.forEach(x=>{
  const under=histUnder(blocks,file,x);
  const own=histOwner(blocks,file,x);
  if(own)out.add(own);else if(!under.length)out.add('_other');
  under.forEach(s=>out.add(s));
 });
 return Array.from(out);
}
/* ===== history regions: END ===== */

module.exports = { HOME_REPO, HOME_BRANCH, REGISTRY_PATH, bundledSites, getRegistry, getSites, getSite, canRead, canWrite, checkAuth, bootstrapKeyOk, gh,
  FILE_RE, SLUG_RE, parseJson, parseB64Json, histBlocks, histOwner, histUnder, histChanged, histParts };
