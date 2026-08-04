'use strict';
const { getSite, canRead, gh } = require('./_lib.js');
const A = require('./_auth.js');

module.exports = async (req, res) => {
  const me = await A.authUser(req).catch(() => null);
  if (!me) return res.status(401).json({ error: 'unauthorized' });
  const file = String(req.query.file || '');
  const site = await getSite(req.query.site ? String(req.query.site) : '');
  if (!site) return res.status(400).json({ error: 'unknown site' });
  if (!A.siteAllowed(me, site.id)) return res.status(403).json({ error: 'Your account does not have access to this site.' });
  if (!canRead(site, file)) return res.status(400).json({ error: 'file not editable' });
  const ref = site.branch ? '?ref=' + encodeURIComponent(site.branch) : '';
  const r = await gh(`/repos/${site.repo}/contents/data/${file}${ref}`);
  if (r.status !== 200) return res.status(502).json({ error: 'github read failed', status: r.status, detail: r.json && r.json.message });
  let content;
  try {
    content = JSON.parse(Buffer.from(r.json.content, 'base64').toString('utf8'));
  } catch (e) {
    return res.status(500).json({ error: 'repo file is not valid JSON' });
  }
  /* a saved-but-unpublished draft shadows the live file in the editor, so
     work-in-progress survives leaving and coming back. The sha returned is
     always the LIVE file's sha - publishing uses it for conflict detection. */
  let draft = null;
  try { draft = await A.readDraft(site.id, file); } catch (e) { /* drafts unavailable - fall through to live */ }
  if (draft && draft.data && draft.data.content)
    return res.status(200).json({ content: draft.data.content, sha: r.json.sha, draft: true, draftAt: draft.data.savedAt || null, publishAt: draft.data.publishAt || null, draftBy: (draft.data.author && draft.data.author.email) || null });
  res.status(200).json({ content, sha: r.json.sha });
};
