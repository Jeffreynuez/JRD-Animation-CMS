'use strict';
/* Site registry endpoint for /admin.
   GET              -> full site list for the authenticated admin (no token — tokens aren't in the registry).
   GET ?download=id -> a short-lived GitHub archive link for that site's repo (see downloadSite).
   POST             -> { op:'add'|'edit', site:{...} } or { op:'delete', id } — mutates data/sites.json in the home repo.
   Auth-gated. The browser sends site details; the server validates and commits.
   New behavior rides here as a query mode: Vercel Hobby caps this project at 12
   serverless functions and api/ is already at 12, so no new file may be added. */
const { getRegistry, HOME_REPO, HOME_BRANCH, REGISTRY_PATH, gh, FILE_RE, parseB64Json } = require('./_lib.js');

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const full = s => ({ id: s.id, label: s.label, repo: s.repo, branch: s.branch || 'main', liveUrl: s.liveUrl || '', group: s.group || '', schema: s.schema || '_schema.json', files: s.files || [] });

/* resolve editable files: use the manual list if given, else derive from the repo's data/<schema>
   (section files AND block files, since a block may keep its own file) */
async function resolveFiles(repo, branch, schema, files) {
  if (files && files.length) return { files };
  const sr = await gh(`/repos/${repo}/contents/data/${schema}?ref=${encodeURIComponent(branch)}`);
  if (sr.status === 200) {
    let sj;
    try { sj = parseB64Json(sr.json.content); }
    catch (e) { return { error: 'data/' + schema + ' in ' + repo + ' is not valid JSON.' }; }
    const set = new Set();
    (sj.sections || []).forEach(x => {
      if (x.file) set.add(String(x.file));
      (x.blocks || []).forEach(b => { if (b && b.file) set.add(String(b.file)); });
    });
    return { files: [...set] };
  }
  if (sr.status === 404) {
    const rr = await gh(`/repos/${repo}`);
    if (rr.status !== 200) return { error: 'Cannot access repo ' + repo + ' with the configured token (' + rr.status + '). Scope the GitHub token to that repo.' };
    return { error: 'No data/' + schema + ' found in ' + repo + ' (' + branch + '). Add one to that repo, or list the editable files manually.' };
  }
  return { error: 'Could not read data/' + schema + ' from ' + repo + ' (' + sr.status + '). Check the repo, branch, and token scope.' };
}

/* GET ?download=<siteId> -> { url, filename, repo, branch }
   Hands back GitHub's signed archive URL rather than streaming the zip through
   this function. Streaming would hit two hard limits: the 4.5 MB serverless
   response cap and the 10 s execution limit. /repos/:owner/:repo/zipball/:ref
   answers 302 with a short-lived signed codeload.github.com URL that needs no
   token, so the browser pulls the bytes straight from GitHub.
   Gated twice: the caller must be allowed on the site AND hold canDownload,
   which is opt-in. Any account may be granted it: the site belongs to the
   client, so exporting it is theirs to do. */
async function downloadSite(req, res, me, reg, A) {
  const id = String(req.query.download || '').trim();
  const site = reg.sites.find(s => s.id === id);
  if (!site) return res.status(404).json({ error: 'No site with id "' + id + '".' });
  if (!A.siteAllowed(me, site.id)) return res.status(403).json({ error: 'You do not have access to that site.' });
  if (!A.can(me, 'canDownload')) return res.status(403).json({ error: 'Your account cannot download site code. Ask the owner to switch on "Download site code" for your account.' });

  const branch = site.branch || 'main';
  const zr = await gh(`/repos/${site.repo}/zipball/${encodeURIComponent(branch)}`, { redirect: 'manual' });
  const loc = (zr.headers && typeof zr.headers.get === 'function') ? zr.headers.get('location') : '';
  if (!loc) {
    if (zr.status === 404) return res.status(404).json({ error: 'GitHub has no ' + branch + ' branch in ' + site.repo + ', or the configured token cannot see that repo.' });
    return res.status(502).json({ error: 'GitHub did not return an archive link (' + zr.status + '). Try again in a moment.' });
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return res.status(200).json({ url: loc, filename: site.id + '-' + branch + '-' + stamp + '.zip', repo: site.repo, branch });
}

async function commitRegistry(sites, sha, message, by) {
  const text = JSON.stringify({ version: 1, sites }, null, 1) + '\n';
  const body = {
    message: message + '\n\nChanged in the JRD editor by ' + (by || 'an admin'),
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch: HOME_BRANCH,
  };
  if (sha) body.sha = sha;
  return gh(`/repos/${HOME_REPO}/contents/${REGISTRY_PATH}`, { method: 'PUT', body: JSON.stringify(body) });
}
const writeErr = (res, wr) => wr.status === 409
  ? res.status(409).json({ error: 'The registry changed since it was loaded. Reopen the picker and retry.' })
  : res.status(502).json({ error: 'Failed to write registry: ' + (wr.json && wr.json.message) });

module.exports = async (req, res) => {
  const A = require('./_auth.js');
  /* anonymous callers stop here, before any GitHub read; the two reads a real
     user needs are independent, so they run side by side */
  if (!A.hasCredentials(req)) return res.status(401).json({ error: 'unauthorized' });
  const [auth, reg] = await Promise.all([A.authed(req), getRegistry()]);
  if (!auth.me) return res.status(auth.code).json({ error: auth.error });
  const me = auth.me;

  if (!req.method || req.method === 'GET') {
    if (req.query && req.query.download) return downloadSite(req, res, me, reg, A);
    return res.status(200).json({ sites: reg.sites.filter(s => A.siteAllowed(me, s.id)).map(full) });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
  if (!A.isAdmin(me)) return res.status(403).json({ error: 'Admins only.' });

  const b = A.readBody(req);
  const op = b.op || 'add';

  if (op === 'delete') {
    const id = String(b.id || '').trim();
    if (!id) return res.status(400).json({ error: 'missing id' });
    if (!reg.sites.some(s => s.id === id)) return res.status(404).json({ error: 'No site with id "' + id + '".' });
    const sites = reg.sites.filter(s => s.id !== id);
    const wr = await commitRegistry(sites, reg.sha, 'cms: remove site ' + id + ' from registry', A.who(me));
    if (wr.status !== 200 && wr.status !== 201) return writeErr(res, wr);
    return res.status(200).json({ ok: true, removed: id, sites: sites.map(full) });
  }

  if (op === 'add' || op === 'edit') {
    const inp = (b.site && typeof b.site === 'object') ? b.site : {};
    const id = String(inp.id || '').trim();
    const label = String(inp.label || '').trim();
    const repo = String(inp.repo || '').trim();
    const branch = (String(inp.branch || '').trim()) || 'main';
    const liveUrl = String(inp.liveUrl || '').trim();
    const group = String(inp.group || '').trim().slice(0, 40);
    let files = Array.isArray(inp.files) ? inp.files.map(f => String(f).trim()).filter(Boolean) : [];

    if (!SLUG.test(id)) return res.status(400).json({ error: 'Site ID must be lowercase letters, numbers, and hyphens (e.g. my-portfolio).' });
    if (!label) return res.status(400).json({ error: 'Label is required.' });
    if (!REPO_RE.test(repo)) return res.status(400).json({ error: 'Repo must look like owner/name.' });
    if (!/^https?:\/\//.test(liveUrl)) return res.status(400).json({ error: 'Live URL must start with http:// or https://' });

    const prev = reg.sites.find(s => s.id === id);
    if (op === 'add' && prev) return res.status(409).json({ error: 'A site with id "' + id + '" already exists.' });
    if (op === 'edit' && !prev) return res.status(404).json({ error: 'No site with id "' + id + '" to edit.' });
    /* the edit form does not send the schema name, so an edit keeps the one already on record */
    const schema = (String(inp.schema || '').trim()) || (prev && prev.schema) || '_schema.json';
    if (!FILE_RE.test(schema)) return res.status(400).json({ error: 'Schema must be a file name like _schema.json.' });

    /* a file name becomes a GitHub path (data/<file>), so only plain names or
       one-folder-down names are accepted: pages.json, es/pages.json */
    const badFile = list => list.find(f => !FILE_RE.test(f));
    if (badFile(files)) return res.status(400).json({ error: 'Editable files must look like pages.json or es/pages.json (not "' + badFile(files) + '").' });

    const rf = await resolveFiles(repo, branch, schema, files);
    if (rf.error) return res.status(400).json({ error: rf.error });
    files = rf.files;
    if (badFile(files)) return res.status(400).json({ error: 'data/' + schema + ' names a file the CMS cannot use: "' + badFile(files) + '". Use names like pages.json or es/pages.json.' });
    if (!files.length) return res.status(400).json({ error: 'No editable files resolved. List them manually (one per line).' });

    const entry = { id, label, repo, branch, liveUrl, group, schema, files };
    const sites = op === 'add' ? reg.sites.concat([entry]) : reg.sites.map(s => (s.id === id ? entry : s));
    const wr = await commitRegistry(sites, reg.sha, (op === 'add' ? 'cms: add site ' : 'cms: edit site ') + id + ' in registry', A.who(me));
    if (wr.status !== 200 && wr.status !== 201) return writeErr(res, wr);
    const out = { ok: true, files, sites: sites.map(full) };
    out[op === 'add' ? 'added' : 'edited'] = full(entry);
    return res.status(200).json(out);
  }

  return res.status(400).json({ error: 'unsupported op' });
};
