// Draft review queue (Phase 2). Drafts are saved by api/save.js for users
// without publish rights; they live in the private users repo, so they never
// trigger a site rebuild until approved.
//   GET  /api/drafts?site=<id>                       -> pending drafts (admins: all; editors: their own)
//   POST /api/drafts {action:'approve', site, file}  -> publish the draft to the site repo (admin)
//   POST /api/drafts {action:'reject',  site, file}  -> discard the draft (admin)
'use strict';
const { getSite, getSites, canWrite, gh } = require('./_lib.js');
const A = require('./_auth.js');

module.exports = async (req, res) => {
  if (!A.configured(res)) return;
  /* ?cron=1 -> publish due SCHEDULED drafts (folded in here to stay under the
     Vercel Hobby 12-function cap). Auth: the Vercel cron's CRON_SECRET bearer,
     or any signed-in user (the admin UI pokes this periodically). */
  if (req.query.cron) return cronSweep(req, res);
  const me = await A.authUser(req).catch(() => null);
  if (!me) return res.status(401).json({ error: 'unauthorized' });

  if (req.method === 'GET') {
    const siteId = String(req.query.site || '');
    if (!siteId) return res.status(400).json({ error: 'missing site' });
    if (!A.siteAllowed(me, siteId)) return res.status(403).json({ error: 'no access to this site' });
    let drafts = await A.listDrafts(siteId);
    if (!A.isAdmin(me)) drafts = drafts.filter(d => d.author && d.author.id === me.id);
    return res.status(200).json({ drafts });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
  if (!A.isAdmin(me)) return res.status(403).json({ error: 'Admins only.' });
  const b = A.readBody(req);
  const siteId = String(b.site || ''), file = String(b.file || '');
  if (!siteId || !file || /[/\\]/.test(file)) return res.status(400).json({ error: 'missing site/file' });

  if (b.action === 'reject') {
    const ok = await A.deleteDraft(siteId, file);
    return res.status(ok ? 200 : 502).json(ok ? { ok: true } : { error: 'could not remove draft' });
  }

  if (b.action === 'approve') {
    const site = await getSite(siteId);
    if (!site) return res.status(400).json({ error: 'unknown site' });
    if (!canWrite(site, file)) return res.status(400).json({ error: 'file not editable' });
    const draft = await A.readDraft(siteId, file);
    if (!draft) return res.status(404).json({ error: 'draft no longer exists' });

    /* current sha of the live file (the draft may be based on an older one -
       approving takes the draft as the new truth) */
    const ref = site.branch ? '?ref=' + encodeURIComponent(site.branch) : '';
    const cur = await gh(`/repos/${site.repo}/contents/data/${file}${ref}`);
    if (cur.status !== 200) return res.status(502).json({ error: 'could not read the live file (' + cur.status + ')' });

    let text;
    try { text = JSON.stringify(draft.data.content, null, 1) + '\n'; }
    catch (e) { return res.status(400).json({ error: 'draft content not serializable' }); }

    const body = {
      message: ('cms: publish draft ' + file + ' by ' + ((draft.data.author && draft.data.author.email) || 'editor') +
        ' (approved by ' + me.email + ')').slice(0, 200) + '\n\nCommitted via /admin CMS',
      content: Buffer.from(text, 'utf8').toString('base64'),
      sha: cur.json.sha,
    };
    if (site.branch) body.branch = site.branch;
    const wr = await gh(`/repos/${site.repo}/contents/data/${file}`, { method: 'PUT', body: JSON.stringify(body) });
    if (wr.status !== 200 && wr.status !== 201)
      return res.status(502).json({ error: 'publish failed', status: wr.status, detail: wr.json && wr.json.message });
    await A.deleteDraft(siteId, file);
    return res.status(200).json({ ok: true, sha: wr.json.content && wr.json.content.sha });
  }

  res.status(400).json({ error: 'Unknown action.' });
};

async function cronSweep(req, res) {
  const secret = process.env.CRON_SECRET || '';
  const okCron = !!secret && req.headers.authorization === 'Bearer ' + secret;
  const okUser = okCron ? true : !!(await A.authUser(req).catch(() => null));
  if (!okCron && !okUser) return res.status(401).json({ error: 'unauthorized' });

  const now = Date.now();
  const published = [], failed = [];
  let sites = [];
  try { sites = await getSites(); } catch (e) { return res.status(502).json({ error: 'registry unavailable' }); }

  for (const site of sites) {
    let drafts = [];
    try { drafts = await A.listDrafts(site.id); } catch (e) { continue; }
    for (const d of drafts) {
      /* only drafts WITH a schedule are touched - a client's for-review
         draft (no publishAt) is never auto-published */
      if (!d.publishAt || new Date(d.publishAt).getTime() > now) continue;
      if (!canWrite(site, d.file)) continue;
      try {
        const full = await A.readDraft(site.id, d.file);
        if (!full || !full.data || !full.data.content) continue;
        const ref = site.branch ? '?ref=' + encodeURIComponent(site.branch) : '';
        const cur = await gh(`/repos/${site.repo}/contents/data/${d.file}${ref}`);
        if (cur.status !== 200) { failed.push(site.id + '/' + d.file); continue; }
        const body = {
          message: ('cms: scheduled publish ' + d.file + ' (set by ' + ((full.data.author && full.data.author.email) || 'editor') + ')').slice(0, 200) +
            '\n\nCommitted via /admin CMS',
          content: Buffer.from(JSON.stringify(full.data.content, null, 1) + '\n', 'utf8').toString('base64'),
          sha: cur.json.sha,
        };
        if (site.branch) body.branch = site.branch;
        const wr = await gh(`/repos/${site.repo}/contents/data/${d.file}`, { method: 'PUT', body: JSON.stringify(body) });
        if (wr.status === 200 || wr.status === 201) {
          await A.deleteDraft(site.id, d.file);
          published.push(site.id + '/' + d.file);
        } else failed.push(site.id + '/' + d.file);
      } catch (e) { failed.push(site.id + '/' + d.file); }
    }
  }
  res.status(200).json({ ok: true, published, failed });
}
