'use strict';
const { getSite, canRead, checkAuth, gh } = require('./_lib.js');

module.exports = async (req, res) => {
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const file = String(req.query.file || '');
  const site = await getSite(req.query.site ? String(req.query.site) : '');
  if (!site) return res.status(400).json({ error: 'unknown site' });
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
  res.status(200).json({ content, sha: r.json.sha });
};
