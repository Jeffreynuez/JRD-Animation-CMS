'use strict';
const { getSite, canWrite, gh } = require('./_lib.js');
const A = require('./_auth.js');

/* GitHub's contents API returns a file's content inline only up to 1 MiB, so a
   bigger data file could be saved but never loaded again. Measured in UTF-8
   bytes (accented text is 2 bytes a character, CJK 3, emoji 4). */
const MAX_BYTES = 900000;

/* Two people editing the same file: the second save must not silently replace
   the first person's draft. The editor sends the draftSha it last saw (from
   load, or from its previous save); if the stored draft is now a different
   version, answer 409 and let the person choose. */
function draftConflict(res, file, c) {
  const by = A.who(c.author);
  const lead = by === 'an editor' ? 'An editor' : by;
  return res.status(409).json({
    code: 'draft-conflict',
    error: lead + ' saved newer changes to ' + file + (c.savedAt ? ' at ' + c.savedAt : '') + '. Choose which version to keep.',
    by, savedAt: c.savedAt || null,
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!A.hasCredentials(req)) return res.status(401).json({ error: 'unauthorized' });
  const b = A.readBody(req);
  const { file, content, sha, message, site: siteId, draft: asDraft } = b;
  const [auth, site] = await Promise.all([
    A.authed(req),
    getSite(siteId ? String(siteId) : '').catch(() => null),
  ]);
  if (!auth.me) return res.status(auth.code).json({ error: auth.error });
  const me = auth.me;
  if (!site) return res.status(400).json({ error: 'unknown site' });
  if (!A.siteAllowed(me, site.id)) return res.status(403).json({ error: 'Your account does not have access to this site.' });
  if (!canWrite(site, String(file))) return res.status(400).json({ error: 'file not editable' });
  if (String(file) === 'theme.json' && !A.can(me, 'canTheme'))
    return res.status(403).json({ error: 'Theme editing is not enabled for your account.' });
  if (!sha) return res.status(400).json({ error: 'missing sha (reload first)' });
  if (typeof content !== 'object' || content === null) return res.status(400).json({ error: 'content must be a JSON object' });

  /* safety layer: serializable, sane size, and the collection root must be a non-empty-keyed object */
  let text;
  try {
    text = JSON.stringify(content, null, 1) + '\n';
  } catch (e) {
    return res.status(400).json({ error: 'content not serializable' });
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return res.status(400).json({ error: 'content too large' });

  /* draft check: skipped entirely when the body has no draftSha key (an editor
     tab opened before this existed) or when force:true ("keep mine") */
  const expect = Object.prototype.hasOwnProperty.call(b, 'draftSha') && b.force !== true
    ? (b.draftSha == null || b.draftSha === '' ? null : String(b.draftSha))
    : undefined;
  /* draft saves: an explicit Save (draft:true, any user) or any save by a
     user without publish rights. Drafts live in the private users repo and
     never trigger a site rebuild. */
  const toDraft = asDraft === true || !A.can(me, 'canPublish');

  /* the section check and, for a publish, one read of the stored draft run
     side by side. The draft read replaces the lookup the post-publish cleanup
     used to do, so it costs no extra GitHub call. */
  const [perm, state] = await Promise.all([
    A.allowedWriteFiles(me, site).then(v => ({ v }), () => ({ err: true })),
    toDraft ? null : A.draftState(site.id, String(file)).catch(() => ({ exists: false, sha: null, unknown: true })),
  ]);
  if (perm.err) return res.status(502).json({ error: 'Could not read the site schema to check your access. Try again in a moment.' });
  if (perm.v !== '*' && !perm.v.has(String(file)))
    return res.status(403).json({ error: 'Your account cannot edit this section. Ask your admin for access.' });

  if (toDraft) {
    const draftData = {
      content, author: { id: me.id, email: me.email, name: me.name || '' },
      savedAt: new Date().toISOString(), baseSha: String(sha),
    };
    /* schedule (publishers only): the drafts.js ?cron=1 sweep publishes it when the time comes */
    if (b.publishAt && A.can(me, 'canPublish')) {
      const t = new Date(String(b.publishAt));
      if (!isNaN(t)) draftData.publishAt = t.toISOString();
    }
    /* the editor labels its saves; the label only picks one of three words for
       the version history, nothing from the request reaches the commit text */
    const kind = /^cms: autosave\b/.test(String(message || '')) ? 'autosave'
      : /^cms: schedule\b/.test(String(message || '')) ? 'schedule' : 'save';
    const w = await A.writeDraft(site.id, String(file), draftData, expect, { kind }).catch(() => ({ ok: false }));
    if (w.conflict) return draftConflict(res, String(file), w.conflict);
    if (!w.ok) return res.status(502).json({ error: 'could not store the draft' });
    return res.status(200).json({ ok: true, draft: true, sha: String(sha), draftSha: w.sha });
  }

  if (expect !== undefined && state.exists && state.sha !== expect) return draftConflict(res, String(file), state);

  /* the commit names the editor account that published, so version history
     (and the planned audit log) can tell who changed what */
  const body = {
    message: String(message || `cms: update ${file}`).slice(0, 200) +
      '\n\nPublished in the JRD editor by ' + A.who(me),
    content: Buffer.from(text, 'utf8').toString('base64'),
    sha: String(sha),
  };
  if (site.branch) body.branch = site.branch;

  const r = await gh(`/repos/${site.repo}/contents/data/${file}`, { method: 'PUT', body: JSON.stringify(body) });
  if (r.status === 409) return res.status(409).json({ error: 'conflict: the file changed since you loaded it. Reload and re-apply.' });
  if (r.status !== 200 && r.status !== 201) return res.status(502).json({ error: 'github write failed', status: r.status, detail: r.json && r.json.message });
  /* published live: clear the draft so the editor stops shadowing the live
     file with stale work-in-progress. Only the version read above is deleted;
     a draft saved in the meantime is someone's newer work and stays. If that
     read failed, an old-style editor still gets the old lookup-and-delete. */
  if (state.exists) await A.deleteDraft(site.id, String(file), state.sha).catch(() => false);
  else if (state.unknown && expect === undefined) await A.deleteDraft(site.id, String(file)).catch(() => false);
  res.status(200).json({ ok: true, sha: r.json.content && r.json.content.sha, commit: r.json.commit && r.json.commit.html_url, draftSha: null });
};
