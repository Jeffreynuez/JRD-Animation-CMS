// Version history for a site data file (every publish is a git commit).
//   GET /api/history?site=<id>&file=<f>            -> last 20 versions
//   GET /api/history?site=<id>&file=<f>&at=<sha>   -> that version's content
// Restoring is done client-side: the chosen content is loaded into the editor
// and goes live only through the normal Publish path (with its permissions).
'use strict';
const { getSite, canRead, gh } = require('./_lib.js');
const A = require('./_auth.js');

module.exports = async (req, res) => {
  const me = await A.authUser(req).catch(() => null);
  if (!me) return res.status(401).json({ error: 'unauthorized' });
  const file = String(req.query.file || '');
  if (!file || /[/\\]/.test(file)) return res.status(400).json({ error: 'missing file' });
  const site = await getSite(req.query.site ? String(req.query.site) : '');
  if (!site) return res.status(400).json({ error: 'unknown site' });
  if (!A.siteAllowed(me, site.id)) return res.status(403).json({ error: 'no access to this site' });
  if (!canRead(site, file)) return res.status(400).json({ error: 'file not editable' });

  if (req.query.at) {
    const r = await gh(`/repos/${site.repo}/contents/data/${file}?ref=${encodeURIComponent(String(req.query.at))}`);
    if (r.status !== 200) return res.status(502).json({ error: 'could not read that version (' + r.status + ')' });
    try { return res.status(200).json({ content: JSON.parse(Buffer.from(r.json.content, 'base64').toString('utf8')) }); }
    catch (e) { return res.status(500).json({ error: 'that version is not valid JSON' }); }
  }

  const branch = site.branch ? '&sha=' + encodeURIComponent(site.branch) : '';
  const r = await gh(`/repos/${site.repo}/commits?path=${encodeURIComponent('data/' + file)}&per_page=20${branch}`);
  if (r.status !== 200 || !Array.isArray(r.json)) return res.status(502).json({ error: 'could not list versions (' + r.status + ')' });
  res.status(200).json({
    versions: r.json.map(c => ({
      sha: c.sha,
      at: (c.commit && c.commit.author && c.commit.author.date) || null,
      by: (c.commit && c.commit.author && c.commit.author.name) || '',
      message: ((c.commit && c.commit.message) || '').split('\n')[0].slice(0, 120),
    })),
  });
};
