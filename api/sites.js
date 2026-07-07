'use strict';
/* Site registry endpoint for /admin.
   GET  -> full site list for the authenticated admin (no token — tokens aren't in the registry).
   POST -> { op:'add'|'edit', site:{...} } or { op:'delete', id } — mutates data/sites.json in the home repo.
   Auth-gated. The browser sends site details; the server validates and commits. */
const { getRegistry, HOME_REPO, HOME_BRANCH, REGISTRY_PATH, checkAuth, gh } = require('./_lib.js');

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const full = s => ({ id: s.id, label: s.label, repo: s.repo, branch: s.branch || 'main', liveUrl: s.liveUrl || '', schema: s.schema || '_schema.json', files: s.files || [] });

/* resolve editable files: use the manual list if given, else derive from the repo's data/<schema> */
async function resolveFiles(repo, branch, schema, files) {
  if (files && files.length) return { files };
  const sr = await gh(`/repos/${repo}/contents/data/${schema}?ref=${encodeURIComponent(branch)}`);
  if (sr.status === 200) {
    let sj;
    try { sj = JSON.parse(Buffer.from(sr.json.content, 'base64').toString('utf8')); }
    catch (e) { return { error: 'data/' + schema + ' in ' + repo + ' is not valid JSON.' }; }
    return { files: [...new Set((sj.sections || []).filter(x => x.file).map(x => x.file))] };
  }
  if (sr.status === 404) {
    const rr = await gh(`/repos/${repo}`);
    if (rr.status !== 200) return { error: 'Cannot access repo ' + repo + ' with the configured token (' + rr.status + '). Scope the GitHub token to that repo.' };
    return { error: 'No data/' + schema + ' found in ' + repo + ' (' + branch + '). Add one to that repo, or list the editable files manually.' };
  }
  return { error: 'Could not read data/' + schema + ' from ' + repo + ' (' + sr.status + '). Check the repo, branch, and token scope.' };
}

async function commitRegistry(sites, sha, message) {
  const text = JSON.stringify({ version: 1, sites }, null, 1) + '\n';
  const body = {
    message: message + '\n\nCommitted via /admin CMS\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>',
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch: HOME_BRANCH,
  };
  if (sha) body.sha = sha;
  return gh(`/repos/${HOME_REPO}/contents/${REGISTRY_PATH}`, { method: 'PUT', body: JSON.stringify(body) });
}
const writeErr = (res, wr) => wr.status === 409
  ? res.status(409).json({ error: 'Registry changed since load — reopen the picker and retry.' })
  : res.status(502).json({ error: 'Failed to write registry: ' + (wr.json && wr.json.message) });

module.exports = async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const reg = await getRegistry();

  if (!req.method || req.method === 'GET') return res.status(200).json({ sites: reg.sites.map(full) });
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });

  const op = (req.body && req.body.op) || 'add';

  if (op === 'delete') {
    const id = String((req.body && req.body.id) || '').trim();
    if (!id) return res.status(400).json({ error: 'missing id' });
    if (!reg.sites.some(s => s.id === id)) return res.status(404).json({ error: 'No site with id "' + id + '".' });
    const sites = reg.sites.filter(s => s.id !== id);
    const wr = await commitRegistry(sites, reg.sha, 'cms: remove site ' + id + ' from registry');
    if (wr.status !== 200 && wr.status !== 201) return writeErr(res, wr);
    return res.status(200).json({ ok: true, removed: id, sites: sites.map(full) });
  }

  if (op === 'add' || op === 'edit') {
    const inp = (req.body && req.body.site) || {};
    const id = String(inp.id || '').trim();
    const label = String(inp.label || '').trim();
    const repo = String(inp.repo || '').trim();
    const branch = (String(inp.branch || '').trim()) || 'main';
    const liveUrl = String(inp.liveUrl || '').trim();
    const schema = (String(inp.schema || '').trim()) || '_schema.json';
    let files = Array.isArray(inp.files) ? inp.files.map(f => String(f).trim()).filter(Boolean) : [];

    if (!SLUG.test(id)) return res.status(400).json({ error: 'Site ID must be lowercase letters, numbers, and hyphens (e.g. my-portfolio).' });
    if (!label) return res.status(400).json({ error: 'Label is required.' });
    if (!REPO_RE.test(repo)) return res.status(400).json({ error: 'Repo must look like owner/name.' });
    if (!/^https?:\/\//.test(liveUrl)) return res.status(400).json({ error: 'Live URL must start with http:// or https://' });

    const exists = reg.sites.some(s => s.id === id);
    if (op === 'add' && exists) return res.status(409).json({ error: 'A site with id "' + id + '" already exists.' });
    if (op === 'edit' && !exists) return res.status(404).json({ error: 'No site with id "' + id + '" to edit.' });

    const rf = await resolveFiles(repo, branch, schema, files);
    if (rf.error) return res.status(400).json({ error: rf.error });
    files = rf.files;
    if (!files.length) return res.status(400).json({ error: 'No editable files resolved. List them manually (one per line).' });

    const entry = { id, label, repo, branch, liveUrl, schema, files };
    const sites = op === 'add' ? reg.sites.concat([entry]) : reg.sites.map(s => (s.id === id ? entry : s));
    const wr = await commitRegistry(sites, reg.sha, (op === 'add' ? 'cms: add site ' : 'cms: edit site ') + id + ' in registry');
    if (wr.status !== 200 && wr.status !== 201) return writeErr(res, wr);
    const out = { ok: true, files, sites: sites.map(full) };
    out[op === 'add' ? 'added' : 'edited'] = full(entry);
    return res.status(200).json(out);
  }

  return res.status(400).json({ error: 'unsupported op' });
};
