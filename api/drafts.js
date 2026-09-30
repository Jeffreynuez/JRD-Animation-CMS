// Draft review queue (Phase 2). Drafts are saved by api/save.js for users
// without publish rights; they live in the private users repo, so they never
// trigger a site rebuild until approved.
//   GET  /api/drafts?site=<id>                       -> pending drafts (admins: all; editors: their own)
//   POST /api/drafts {action:'approve', site, file}  -> publish the draft to the site repo (admin)
//   POST /api/drafts {action:'reject',  site, file}  -> discard the draft (admin)
//   POST /api/drafts?cron=1                          -> publish due scheduled drafts; answers
//        { ok, published, failed, next } where next is the earliest future publishAt (ISO) or null
// `file` may sit in a subfolder (es/pages.json) exactly as in the site's registry entry.
'use strict';
const { getSite, getSites, canWrite, gh } = require('./_lib.js');
const A = require('./_auth.js');

module.exports = async (req, res) => {
  if (!A.configured(res)) return;
  /* ?cron=1 -> publish due SCHEDULED drafts (folded in here to stay under the
     Vercel Hobby 12-function cap). Auth: the Vercel cron's CRON_SECRET bearer,
     or any signed-in user (the admin UI pokes this periodically). */
  if (req.query.cron) return cronSweep(req, res);
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
  /* anonymous callers stop before any GitHub read. The site must be a
     registry entry (its id is a slug, so it can never walk out of drafts/ in
     the private repo); it resolves in parallel with the account. */
  if (!A.hasCredentials(req)) return res.status(401).json({ error: 'unauthorized' });
  const b = req.method === 'POST' ? A.readBody(req) : {};
  const siteId = String((req.method === 'GET' ? req.query.site : b.site) || '');
  const [auth, site] = await Promise.all([A.authed(req), siteId ? getSite(siteId).catch(() => null) : null]);
  if (!auth.me) return res.status(auth.code).json({ error: auth.error });
  const me = auth.me;

  if (req.method === 'GET') {
    if (!site) return res.status(400).json({ error: 'missing site' });
    if (!A.siteAllowed(me, site.id)) return res.status(403).json({ error: 'no access to this site' });
    let drafts = await A.listDrafts(site.id).catch(() => []);
    if (!A.isAdmin(me)) drafts = drafts.filter(d => d.author && d.author.id === me.id);
    return res.status(200).json({ drafts });
  }

  if (!A.isAdmin(me)) return res.status(403).json({ error: 'Admins only.' });
  const file = String(b.file || '');
  /* both must name a real registry entry and one of its editable files */
  if (!site || !file || !canWrite(site, file)) return res.status(400).json({ error: 'missing site/file' });
  if (!A.siteAllowed(me, site.id)) return res.status(403).json({ error: 'no access to this site' });

  if (b.action === 'reject') {
    const ok = await A.deleteDraft(site.id, file).catch(() => false);
    return res.status(ok ? 200 : 502).json(ok ? { ok: true } : { error: 'could not remove draft' });
  }

  if (b.action === 'approve') {
    const draft = await A.readDraft(site.id, file).catch(() => null);
    if (!draft || !draft.data || !draft.data.content) return res.status(404).json({ error: 'draft no longer exists' });

    /* current sha of the live file (the draft may be based on an older one -
       approving takes the draft as the new truth) */
    const ref = site.branch ? '?ref=' + encodeURIComponent(site.branch) : '';
    const cur = await gh(`/repos/${site.repo}/contents/data/${file}${ref}`);
    if (cur.status !== 200) return res.status(502).json({ error: 'could not read the live file (' + cur.status + ')' });

    let text;
    try { text = JSON.stringify(draft.data.content, null, 1) + '\n'; }
    catch (e) { return res.status(400).json({ error: 'draft content not serializable' }); }

    const body = {
      message: ('cms: publish draft ' + file + ' by ' + A.who(draft.data.author) +
        ' (approved by ' + me.email + ')').slice(0, 200) + '\n\nCommitted via /admin CMS',
      content: Buffer.from(text, 'utf8').toString('base64'),
      sha: cur.json.sha,
    };
    if (site.branch) body.branch = site.branch;
    const wr = await gh(`/repos/${site.repo}/contents/data/${file}`, { method: 'PUT', body: JSON.stringify(body) });
    if (wr.status !== 200 && wr.status !== 201)
      return res.status(502).json({ error: 'publish failed', status: wr.status, detail: wr.json && wr.json.message });
    /* published: a failed cleanup must not report the publish as failed */
    await A.deleteDraft(site.id, file, draft.sha).catch(() => false);
    return res.status(200).json({ ok: true, sha: wr.json.content && wr.json.content.sha });
  }

  res.status(400).json({ error: 'Unknown action.' });
};

async function cronSweep(req, res) {
  const secret = process.env.CRON_SECRET || '';
  const okCron = !!secret && req.headers.authorization === 'Bearer ' + secret;
  if (!okCron && !A.hasCredentials(req)) return res.status(401).json({ error: 'unauthorized' });
  /* the account check, the registry and one listing of drafts/ (which sites
     have drafts at all; null = unknown, check all) are independent reads */
  const [auth, sites, withDrafts] = await Promise.all([
    okCron ? { me: true } : A.authed(req),
    getSites().catch(() => null),
    A.draftSites().catch(() => null),
  ]);
  if (!auth.me) return res.status(auth.code).json({ error: auth.error });
  if (!sites) return res.status(502).json({ error: 'registry unavailable' });

  const now = Date.now();
  const published = [], failed = [];
  let next = null;   /* earliest schedule still in the future, so the admin knows when to poke again */
  const todo = sites.filter(s => !withDrafts || withDrafts.has(s.id));

  /* sites run side by side (different repos); within a site, one commit at a
     time, since parallel writes to one branch can conflict */
  await Promise.all(todo.map(async site => {
    let drafts;
    try { drafts = await A.collectDrafts(site.id); } catch (e) { failed.push(site.id); return; }
    for (const d of drafts) {
      /* only drafts WITH a schedule are touched - a client's for-review
         draft (no publishAt) is never auto-published */
      if (!d.data.publishAt) continue;
      const due = new Date(d.data.publishAt).getTime();
      if (isNaN(due)) continue;
      if (due > now) { if (next === null || due < next) next = due; continue; }
      if (!canWrite(site, d.file) || !d.data.content) continue;
      try {
        const ref = site.branch ? '?ref=' + encodeURIComponent(site.branch) : '';
        const cur = await gh(`/repos/${site.repo}/contents/data/${d.file}${ref}`);
        if (cur.status !== 200) { failed.push(site.id + '/' + d.file); continue; }
        const body = {
          message: ('cms: scheduled publish ' + d.file + ' (set by ' + A.who(d.data.author) + ')').slice(0, 200) +
            '\n\nCommitted via /admin CMS',
          content: Buffer.from(JSON.stringify(d.data.content, null, 1) + '\n', 'utf8').toString('base64'),
          sha: cur.json.sha,
        };
        if (site.branch) body.branch = site.branch;
        const wr = await gh(`/repos/${site.repo}/contents/data/${d.file}`, { method: 'PUT', body: JSON.stringify(body) });
        if (wr.status === 200 || wr.status === 201) {
          await A.deleteDraft(site.id, d.file, d.sha).catch(() => false);
          published.push(site.id + '/' + d.file);
        } else failed.push(site.id + '/' + d.file);
      } catch (e) { failed.push(site.id + '/' + d.file); }
    }
  }));
  res.status(200).json({ ok: true, published, failed, next: next === null ? null : new Date(next).toISOString() });
}
