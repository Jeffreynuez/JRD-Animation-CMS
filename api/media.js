// Media library: list what's already uploaded to this site's Cloudinary folder
// so editors can reuse images instead of re-uploading.
//   GET /api/media?site=<id>[&kind=image|video][&cursor=<next_cursor>]
'use strict';
const { getSite } = require('./_lib.js');
const A = require('./_auth.js');

const ALLOWED = (process.env.CLOUDINARY_CLOUDS || 'dlgc3fj6w,dfmofrlt3')
  .split(',').map(s => s.trim()).filter(Boolean);

module.exports = async (req, res) => {
  const me = await A.authUser(req).catch(() => null);
  if (!me) return res.status(401).json({ error: 'unauthorized' });
  const site = await getSite(req.query.site ? String(req.query.site) : '');
  if (!site) return res.status(400).json({ error: 'unknown site' });
  if (!A.siteAllowed(me, site.id)) return res.status(403).json({ error: 'no access to this site' });

  let schema;
  try { schema = await A.siteSchema(site); } catch (e) { return res.status(502).json({ error: 'could not read the site schema' }); }
  const cloud = String(schema.cloudName || '').trim();
  const folder = String(schema.mediaFolder || '').trim();
  if (!cloud || !ALLOWED.includes(cloud)) return res.status(400).json({ error: 'this site has no media cloud configured' });

  const apiKey = process.env.CLOUDINARY_API_KEY, apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!apiKey || !apiSecret) return res.status(500).json({ error: 'Cloudinary credentials not configured' });

  const kind = req.query.kind === 'video' ? 'video' : 'image';
  const qs = new URLSearchParams({ max_results: '60' });
  if (folder) qs.set('prefix', folder + '/');
  if (req.query.cursor) qs.set('next_cursor', String(req.query.cursor));

  const r = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/resources/${kind}/upload?` + qs.toString(), {
    headers: { Authorization: 'Basic ' + Buffer.from(apiKey + ':' + apiSecret).toString('base64') },
  });
  const j = await r.json().catch(() => ({}));
  if (r.status !== 200) return res.status(502).json({ error: (j.error && j.error.message) || ('cloudinary list failed (' + r.status + ')') });

  const items = (j.resources || []).map(x => ({
    value: 'CDN:' + x.resource_type + '/upload/v' + x.version + '/' + x.public_id + (x.format ? '.' + x.format : ''),
    thumb: `https://res.cloudinary.com/${cloud}/${x.resource_type}/upload/` +
           (x.resource_type === 'video' ? 'so_0,' : '') + 'f_auto,q_auto,w_300,h_300,c_fill/' +
           `v${x.version}/${x.public_id}` + (x.resource_type === 'video' ? '.jpg' : (x.format ? '.' + x.format : '')),
    id: x.public_id, w: x.width, h: x.height, bytes: x.bytes, at: x.created_at,
  }));
  res.status(200).json({ items, cursor: j.next_cursor || null });
};
