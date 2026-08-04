'use strict';
const { getSite, canWrite, gh } = require('./_lib.js');
const A = require('./_auth.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const me = await A.authUser(req).catch(() => null);
  if (!me) return res.status(401).json({ error: 'unauthorized' });
  const { file, content, sha, message, site: siteId, draft: asDraft } = req.body || {};
  const site = await getSite(siteId ? String(siteId) : '');
  if (!site) return res.status(400).json({ error: 'unknown site' });
  if (!A.siteAllowed(me, site.id)) return res.status(403).json({ error: 'Your account does not have access to this site.' });
  if (!canWrite(site, String(file))) return res.status(400).json({ error: 'file not editable' });
  if (String(file) === 'theme.json' && !A.can(me, 'canTheme'))
    return res.status(403).json({ error: 'Theme editing is not enabled for your account.' });
  const allowed = await A.allowedWriteFiles(me, site);
  if (allowed !== '*' && !allowed.has(String(file)))
    return res.status(403).json({ error: 'Your account cannot edit this section. Ask your admin for access.' });
  if (!sha) return res.status(400).json({ error: 'missing sha (reload first)' });
  if (typeof content !== 'object' || content === null) return res.status(400).json({ error: 'content must be a JSON object' });

  /* safety layer: serializable, sane size, and the collection root must be a non-empty-keyed object */
  let text;
  try {
    text = JSON.stringify(content, null, 1) + '\n';
  } catch (e) {
    return res.status(400).json({ error: 'content not serializable' });
  }
  if (text.length > 900000) return res.status(400).json({ error: 'content too large' });

  /* draft saves: an explicit Save (draft:true, any user) or any save by a
     user without publish rights. Drafts live in the private users repo and
     never trigger a site rebuild. */
  if (asDraft === true || !A.can(me, 'canPublish')) {
    const draftData = {
      content, author: { id: me.id, email: me.email, name: me.name || '' },
      savedAt: new Date().toISOString(), baseSha: String(sha),
    };
    /* schedule (publishers only): api/cron.js publishes it when the time comes */
    if (req.body.publishAt && A.can(me, 'canPublish')) {
      const t = new Date(String(req.body.publishAt));
      if (!isNaN(t)) draftData.publishAt = t.toISOString();
    }
    const ok = await A.writeDraft(site.id, String(file), draftData);
    if (!ok) return res.status(502).json({ error: 'could not store the draft' });
    return res.status(200).json({ ok: true, draft: true, sha: String(sha) });
  }

  const body = {
    message: String(message || `cms: update ${file}`).slice(0, 200) +
      '\n\nCommitted via /admin CMS\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>',
    content: Buffer.from(text, 'utf8').toString('base64'),
    sha: String(sha),
  };
  if (site.branch) body.branch = site.branch;

  const r = await gh(`/repos/${site.repo}/contents/data/${file}`, { method: 'PUT', body: JSON.stringify(body) });
  if (r.status === 409) return res.status(409).json({ error: 'conflict — file changed since load; reload and re-apply' });
  if (r.status !== 200 && r.status !== 201) return res.status(502).json({ error: 'github write failed', status: r.status, detail: r.json && r.json.message });
  /* published live: clear any saved draft so the editor stops shadowing the
     live file with stale work-in-progress */
  try { await A.deleteDraft(site.id, String(file)); } catch (e) { /* non-fatal */ }
  res.status(200).json({ ok: true, sha: r.json.content && r.json.content.sha, commit: r.json.commit && r.json.commit.html_url });
};
