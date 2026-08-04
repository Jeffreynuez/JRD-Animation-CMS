// Scheduled publishing: publishes any draft whose publishAt time has passed.
// Fired two ways so schedules land close to their time:
//   1. the Vercel cron (vercel.json "crons") — the daily guarantee
//   2. an opportunistic poke from the admin UI whenever someone is signed in
// Only drafts WITH a publishAt are touched — a client's for-review draft
// (no schedule) is never auto-published.
'use strict';
const { getSites, canWrite, gh } = require('./_lib.js');
const A = require('./_auth.js');

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  const okCron = !!secret && req.headers.authorization === 'Bearer ' + secret;
  let okUser = false;
  if (!okCron) okUser = !!(await A.authUser(req).catch(() => null));
  if (!okCron && !okUser) return res.status(401).json({ error: 'unauthorized' });

  const now = Date.now();
  const published = [], failed = [];
  let sites = [];
  try { sites = await getSites(); } catch (e) { return res.status(502).json({ error: 'registry unavailable' }); }

  for (const site of sites) {
    let drafts = [];
    try { drafts = await A.listDrafts(site.id); } catch (e) { continue; }
    for (const d of drafts) {
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
};
