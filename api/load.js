'use strict';
const { getSite, canRead, canWrite, gh, parseB64Json } = require('./_lib.js');
const A = require('./_auth.js');

module.exports = async (req, res) => {
  /* anonymous callers stop here, before any GitHub read, so they cannot spend
     the shared token budget; then the two independent reads run side by side */
  if (!A.hasCredentials(req)) return res.status(401).json({ error: 'unauthorized' });
  const file = String(req.query.file || '');
  const [auth, site] = await Promise.all([
    A.authed(req),
    getSite(req.query.site ? String(req.query.site) : '').catch(() => null),
  ]);
  if (!auth.me) return res.status(auth.code).json({ error: auth.error });
  const me = auth.me;
  if (!site) return res.status(400).json({ error: 'unknown site' });
  if (!A.siteAllowed(me, site.id)) return res.status(403).json({ error: 'Your account does not have access to this site.' });
  if (!canRead(site, file)) return res.status(400).json({ error: 'file not editable' });

  /* version history modes (folded in here to stay under the Vercel Hobby
     12-function cap): ?history=1 lists versions (100 per page, &page=N for
     older ones; more:true when another page may exist); ?at=<sha> reads one */
  if (req.query.at) {
    const r0 = await gh(`/repos/${site.repo}/contents/data/${file}?ref=${encodeURIComponent(String(req.query.at))}`);
    if (r0.status !== 200) return res.status(502).json({ error: 'could not read that version (' + r0.status + ')' });
    try { return res.status(200).json({ content: parseB64Json(r0.json.content) }); }
    catch (e) { return res.status(500).json({ error: 'that version is not valid JSON' }); }
  }
  if (req.query.history) {
    const PER = 100;
    const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 100);
    const branch = site.branch ? '&sha=' + encodeURIComponent(site.branch) : '';
    const r0 = await gh(`/repos/${site.repo}/commits?path=${encodeURIComponent('data/' + file)}&per_page=${PER}&page=${page}${branch}`);
    if (r0.status !== 200 || !Array.isArray(r0.json)) return res.status(502).json({ error: 'could not list versions (' + r0.status + ')' });
    return res.status(200).json({
      versions: r0.json.map(c => ({
        sha: c.sha,
        at: (c.commit && c.commit.author && c.commit.author.date) || null,
        by: (c.commit && c.commit.author && c.commit.author.name) || '',
        message: ((c.commit && c.commit.message) || '').split('\n')[0].slice(0, 120),
      })),
      page, more: r0.json.length === PER,
    });
  }

  const ref = site.branch ? '?ref=' + encodeURIComponent(site.branch) : '';
  /* the live file and its draft are independent reads. Files that can never
     be saved (the schema, other always-readable files outside site.files)
     cannot have a draft, so do not ask for one. */
  const [r, draft] = await Promise.all([
    gh(`/repos/${site.repo}/contents/data/${file}${ref}`),
    canWrite(site, file) ? A.readDraft(site.id, file).catch(() => null) : null,
  ]);
  if (r.status !== 200) return res.status(502).json({ error: 'github read failed', status: r.status, detail: r.json && r.json.message });
  let content;
  try {
    content = parseB64Json(r.json.content);
  } catch (e) {
    return res.status(500).json({ error: 'repo file is not valid JSON' });
  }
  /* a saved-but-unpublished draft shadows the live file in the editor, so
     work-in-progress survives leaving and coming back. The sha returned is
     always the LIVE file's sha - publishing uses it for conflict detection.
     draftSha is the stored draft's own sha (null when there is none): the
     editor sends it back with its next save so a newer draft by someone else
     is caught instead of overwritten. */
  const draftSha = (draft && draft.sha) || null;
  if (draft && draft.data && draft.data.content)
    return res.status(200).json({ content: draft.data.content, sha: r.json.sha, draft: true, draftAt: draft.data.savedAt || null, publishAt: draft.data.publishAt || null, draftBy: (draft.data.author && draft.data.author.email) || null, draftSha });
  res.status(200).json({ content, sha: r.json.sha, draftSha });
};
