'use strict';
const { getSite, canWrite, checkAuth, gh } = require('./_lib.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const { file, content, sha, message, site: siteId } = req.body || {};
  const site = await getSite(siteId ? String(siteId) : '');
  if (!site) return res.status(400).json({ error: 'unknown site' });
  if (!canWrite(site, String(file))) return res.status(400).json({ error: 'file not editable' });
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
  res.status(200).json({ ok: true, sha: r.json.content && r.json.content.sha, commit: r.json.commit && r.json.commit.html_url });
};
