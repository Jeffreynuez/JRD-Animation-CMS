'use strict';
const { getSite, canRead, canWrite, gh, parseB64Json, FILE_RE, histBlocks, histParts } = require('./_lib.js');
const A = require('./_auth.js');

/* ================= version history of a page, a section or the whole site =================
   ?history=1&files=a.json,b.json[&sections=x,y][&until=<iso>]
   One timeline built from two sources: publishes and code deploys (commits on
   data/<file> in the site repo) and saves (commits on drafts/<site>/<file> in
   the users repo). Saves by one person with no gap over 10 minutes form one
   editing session; publishes by one person within 3 minutes form one entry; a
   code deploy is one entry however many files it touched. Each entry lists the
   schema sections it changed, found by comparing the files before and after it.
   With sections=, only entries that changed one of them are returned. Paging:
   `until` from the previous answer continues where it stopped.

   ?asof=<iso>&files=...&mode=editor|live
   The content of each file at that moment: what the editor showed (a draft
   shadows the live file) or, with mode=live, what was published. */
const PER = 100;                 /* commits listed per file and source */
const HIST_ROWS = 25;            /* entries returned per answer */
const HIST_READS = 70;           /* file versions read from GitHub per answer */
const HIST_MS = 6500;            /* stop early rather than run into the function timeout */
const SESSION_GAP = 10 * 60000, PUBLISH_GAP = 3 * 60000;

/* a file at a commit never changes, so versions are cached by commit (promise
   cache: parallel lookups of one version share a single read) */
const VCACHE = new Map(), VCACHE_MAX = 200;
function cached(key, fn) {
  if (VCACHE.has(key)) { const v = VCACHE.get(key); VCACHE.delete(key); VCACHE.set(key, v); return v; }
  const p = fn();
  VCACHE.set(key, p);
  p.catch(() => VCACHE.delete(key));
  while (VCACHE.size > VCACHE_MAX) VCACHE.delete(VCACHE.keys().next().value);
  return p;
}
function siteVersion(site, file, sha, ctx) {
  return cached('s|' + site.repo + '|' + file + '|' + sha, async () => {
    if (ctx) ctx.reads++;
    const r = await gh(`/repos/${site.repo}/contents/data/${file}?ref=${encodeURIComponent(sha)}`, { noEtag: true });
    if (r.status === 404) return null;
    if (r.status !== 200 || !r.json || typeof r.json.content !== 'string') throw new Error('read ' + r.status);
    return parseB64Json(r.json.content);
  });
}
function draftVersion(site, file, sha, ctx) {
  return cached('d|' + site.id + '|' + file + '|' + sha, async () => {
    if (ctx) ctx.reads++;
    return A.readDraftAt(site.id, file, sha);
  });
}

const headOf = m => String(m || '').split('\n')[0];
const whenOf = c => (c && c.commit && ((c.commit.committer && c.commit.committer.date) || (c.commit.author && c.commit.author.date))) || null;
function siteEvent(c, file) {
  const msg = (c.commit && c.commit.message) || '', head = headOf(msg), at = whenOf(c);
  const author = (c.commit && c.commit.author && c.commit.author.name) || '';
  const e = { src: 'site', sha: c.sha, at, t: Date.parse(at), file, by: author, sub: null };
  if (!/^cms:/.test(head)) return Object.assign(e, { kind: 'deploy', title: head.slice(0, 140) });
  let m;
  if ((m = msg.match(/Published in the JRD editor by (.+)$/m))) e.by = m[1].trim();
  else if ((m = head.match(/^cms: publish draft \S+ by (.+?) \(approved by (.+?)\)/))) { e.by = m[1] + ', approved by ' + m[2]; e.sub = 'approved'; }
  else if ((m = head.match(/^cms: scheduled publish \S+ \(set by (.+?)\)/))) { e.by = m[1]; e.sub = 'scheduled'; }
  return Object.assign(e, { kind: 'publish' });
}
function draftEvent(c, file) {
  const msg = (c.commit && c.commit.message) || '', head = headOf(msg), at = whenOf(c);
  const kind = /^cms: clear draft\b/.test(head) ? 'clear' : /^cms: autosave\b/.test(head) ? 'autosave'
    : /^cms: schedule\b/.test(head) ? 'schedule' : 'save';
  const m = msg.match(/Saved in the JRD editor by (.+)$/m);
  return { src: 'draft', kind, sha: c.sha, at, t: Date.parse(at), file, by: m ? m[1].trim() : null };
}
async function siteCommits(site, file, until, perPage) {
  const q = 'path=' + encodeURIComponent('data/' + file) + '&per_page=' + (perPage || PER) +
    (site.branch ? '&sha=' + encodeURIComponent(site.branch) : '') + (until ? '&until=' + encodeURIComponent(until) : '');
  const r = await gh(`/repos/${site.repo}/commits?${q}`);
  if (r.status !== 200 || !Array.isArray(r.json)) throw new Error('could not list versions (' + r.status + ')');
  return r.json;
}
const iso = t => new Date(t).toISOString();

async function pageHistory(req, res, site, files) {
  const sections = req.query.sections ? String(req.query.sections).split(',').map(x => x.trim()).filter(Boolean) : null;
  const cursor = req.query.until ? Date.parse(String(req.query.until)) : NaN;
  const until = isNaN(cursor) ? '' : iso(cursor + 1000);   /* GitHub's bound, then filtered exactly below */
  let blocks = [];
  try { blocks = histBlocks((await A.siteSchema(site)).sections); } catch (e) { /* no sections: every change is "other" */ }

  const L = { site: {}, draft: {}, siteFull: {}, draftFull: {} };
  let savesMissing = false;
  try {
    await Promise.all(files.map(async f => {
      const [sc, dc] = await Promise.all([
        siteCommits(site, f, until),
        A.draftCommits(site.id, f, until).catch(() => { savesMissing = true; return []; }),
      ]);
      L.siteFull[f] = sc.length >= PER; L.draftFull[f] = dc.length >= PER;
      const keep = e => !isNaN(e.t) && (isNaN(cursor) || e.t <= cursor);
      L.site[f] = sc.map(c => siteEvent(c, f)).filter(keep);
      L.draft[f] = dc.map(c => draftEvent(c, f)).filter(keep);
    }));
  } catch (e) {
    return res.status(502).json({ error: 'Could not list the versions. Try again in a moment.' });
  }

  /* the listing window: below the oldest commit of a full list, other lists
     may be missing entries, so entries there wait for the next page */
  let floor = -Infinity;
  files.forEach(f => {
    if (L.siteFull[f] && L.site[f].length) floor = Math.max(floor, L.site[f][L.site[f].length - 1].t);
    if (L.draftFull[f] && L.draft[f].length) floor = Math.max(floor, L.draft[f][L.draft[f].length - 1].t);
  });

  /* one timeline, newest first (a publish sorts above a save in the same second) */
  const events = [].concat(...files.map(f => L.site[f].concat(L.draft[f])))
    .sort((a, b) => (b.t - a.t) || ((a.src === 'site' ? 0 : 1) - (b.src === 'site' ? 0 : 1)));
  const rows = [], bySha = new Map();
  let cur = null;
  for (const e of events) {
    if (e.kind === 'clear') continue;
    if (e.kind === 'deploy') {
      let r = bySha.get(e.sha);
      if (!r) { r = { kind: 'deploy', sha: e.sha, t: e.t, from: e.t, by: e.by, title: e.title, ev: [] }; bySha.set(e.sha, r); rows.push(r); }
      r.ev.push(e); r.from = Math.min(r.from, e.t); cur = r;
      continue;
    }
    if (e.kind === 'publish') {
      if (cur && cur.kind === 'publish' && cur.by === e.by && cur.sub === e.sub && cur.from - e.t <= PUBLISH_GAP) { cur.ev.push(e); cur.from = e.t; continue; }
      cur = { kind: 'publish', sub: e.sub, t: e.t, from: e.t, by: e.by, ev: [e] }; rows.push(cur);
      continue;
    }
    if (cur && cur.kind === 'save' && cur.by === e.by && cur.from - e.t <= SESSION_GAP) {
      cur.ev.push(e); cur.from = e.t; if (e.kind === 'schedule') cur.scheduled = true;
      continue;
    }
    cur = { kind: 'save', t: e.t, from: e.t, by: e.by, ev: [e], scheduled: e.kind === 'schedule' }; rows.push(cur);
  }

  const ctx = { reads: 0 };
  const t0 = Date.now();
  const UNK = new Error('unknown');
  const before = (list, full, t) => { for (const e of list) if (e.t < t) return e; return full ? UNK : null; };
  const liveBefore = async (f, t) => {
    const e = before(L.site[f], L.siteFull[f], t);
    if (e === UNK) throw UNK;
    return e ? siteVersion(site, f, e.sha, ctx) : null;
  };
  /* what the editor showed just before t: the draft if one was stored, else the live file */
  const editorBefore = async (f, t) => {
    const d = before(L.draft[f], L.draftFull[f], t);
    if (d === UNK) throw UNK;
    if (d && d.kind !== 'clear') {
      const data = await draftVersion(site, f, d.sha, ctx);
      if (data && data.content) return data.content;
    }
    return liveBefore(f, t);
  };
  async function rowParts(r) {
    const fs = Array.from(new Set(r.ev.map(e => e.file)));
    const parts = new Set();
    let known = 0;
    await Promise.all(fs.map(async f => {
      const evF = r.ev.filter(e => e.file === f);
      const newest = evF[0], oldest = evF[evF.length - 1];
      try {
        let a, b;
        if (r.kind === 'save') {
          const data = await draftVersion(site, f, newest.sha, ctx);
          if (r.by == null && data && data.author) r.by = A.who(data.author);   /* saves from before names were recorded */
          b = data && data.content;
          a = await editorBefore(f, oldest.t);
        } else {
          b = await siteVersion(site, f, newest.sha, ctx);
          a = await liveBefore(f, oldest.t);
        }
        histParts(blocks, f, a, b).forEach(p => parts.add(p));
        known++;
      } catch (e) { /* this file's change stays unknown */ }
    }));
    r.files = fs;
    r.parts = known ? Array.from(parts) : null;
  }
  const want = sections ? new Set(sections) : null;
  const keep = r => !want || r.parts === null || r.parts.some(p => want.has(p));

  let eligible = rows.filter(r => r.from > floor);
  if (!eligible.length && rows.length) eligible = [rows[0]];   /* one entry bigger than the window: show it anyway */
  const out = [];
  let next = null;
  let i = 0;
  for (; i < eligible.length; i += 6) {
    if (i > 0 && (out.length >= HIST_ROWS || ctx.reads >= HIST_READS || Date.now() - t0 > HIST_MS)) break;
    const batch = eligible.slice(i, i + 6);
    await Promise.all(batch.map(rowParts));
    batch.forEach(r => { if (keep(r)) out.push(r); });
  }
  /* where the next page starts. Every branch moves strictly past what was
     processed, so paging always ends. */
  const lastDone = eligible.length ? eligible[Math.min(i, eligible.length) - 1] : null;
  if (i < eligible.length) next = lastDone.from - 1000;
  else if (rows.length > eligible.length) next = rows[eligible.length].t;
  else if (floor > -Infinity) next = lastDone ? Math.min(floor, lastDone.from - 1000) : floor;

  res.status(200).json({
    rows: out.map(r => ({
      id: r.kind + ':' + r.ev[0].sha,
      kind: r.kind, sub: r.sub || null, at: iso(r.t), from: iso(r.from), by: r.by || '',
      title: r.title || '', files: r.files, parts: r.parts, count: r.ev.length,
      scheduled: !!r.scheduled,
      saves: r.kind === 'save' ? r.ev.slice(0, 120).map(e => ({ at: e.at, file: e.file, kind: e.kind })) : undefined,
    })),
    until: next === null ? null : iso(next),
    more: next !== null,
    savesMissing,
  });
}

async function asOf(req, res, site, files) {
  const t = Date.parse(String(req.query.asof));
  if (isNaN(t)) return res.status(400).json({ error: 'bad time' });
  const editor = req.query.mode !== 'live';
  const until = iso(t + 1000);
  const contents = {};
  try {
    await Promise.all(files.map(async f => {
      let content;
      if (editor) {
        const ds = await A.draftCommits(site.id, f, until, 5).catch(() => []);
        const d = ds.map(c => draftEvent(c, f)).filter(e => e.t <= t)[0];
        if (d && d.kind !== 'clear') {
          const data = await draftVersion(site, f, d.sha);
          if (data && data.content) content = data.content;
        }
      }
      if (content === undefined) {
        const cs = await siteCommits(site, f, until, 5);
        const e = cs.map(c => siteEvent(c, f)).filter(x => x.t <= t)[0];
        content = e ? await siteVersion(site, f, e.sha) : null;   /* null: the file did not exist yet */
      }
      contents[f] = content;
    }));
  } catch (e) {
    return res.status(502).json({ error: 'Could not read that version. Try again in a moment.' });
  }
  res.status(200).json({ contents, at: iso(t) });
}

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

  /* several files at once: the page / section / site version history */
  if (req.query.files != null) {
    const list = Array.from(new Set(String(req.query.files).split(',').map(x => x.trim()).filter(Boolean)));
    if (!list.length || list.length > 24 || list.some(f => !FILE_RE.test(f) || !canWrite(site, f)))
      return res.status(400).json({ error: 'file not editable' });
    if (req.query.asof) return asOf(req, res, site, list);
    if (req.query.history) return pageHistory(req, res, site, list);
    return res.status(400).json({ error: 'unknown request' });
  }
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
