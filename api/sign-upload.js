'use strict';
const crypto = require('crypto');
const A = require('./_auth.js');

/* The cloud a managed site delivers from is declared in its own
   data/_schema.json ("cloudName"), and the admin passes it here. The signature
   only covers the timestamp, so the cloud is a routing choice, not a secret --
   but we still allow-list it so a bad schema can't send uploads somewhere odd.
   Falls back to CLOUDINARY_CLOUD_NAME, then to the legacy default. */
const ALLOWED = (process.env.CLOUDINARY_CLOUDS || 'dlgc3fj6w,dfmofrlt3')
  .split(',').map(s => s.trim()).filter(Boolean);
const DEFAULT_CLOUD = process.env.CLOUDINARY_CLOUD_NAME || ALLOWED[0];

module.exports = async (req, res) => {
  /* GET ?list=1&site=<id>[&cursor=..] -> media library (folded in here to
     stay under the Vercel Hobby 12-function cap - do NOT add new api files) */
  if (req.method === 'GET' && req.query.list) return mediaLibrary(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const me = await A.authUser(req).catch(() => null);
  if (!me) return res.status(401).json({ error: 'unauthorized' });
  if (!A.can(me, 'canUpload')) return res.status(403).json({ error: 'Uploads are not enabled for your account.' });

  const apiKey = process.env.CLOUDINARY_API_KEY, secret = process.env.CLOUDINARY_API_SECRET;
  if (!apiKey || !secret) return res.status(501).json({ error: 'Cloudinary env vars not configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const asked = String(body.cloudName || '').trim();
  const cloudName = ALLOWED.includes(asked) ? asked : DEFAULT_CLOUD;

  /* An optional folder keeps each site's media tidy (e.g. "gcwindsor"). */
  const folder = String(body.folder || '').replace(/[^a-zA-Z0-9_\-/]/g, '');

  const timestamp = Math.floor(Date.now() / 1000);

  /* Incoming transformation: images are capped at 2600px on the long edge at
     UPLOAD time, so a 40MB phone photo is stored as a lean web-ready master.
     Delivery URLs add f_auto,q_auto on top, so what visitors download is
     optimized twice over. Videos are stored as-is (capping video re-encodes). */
  const kind = String(body.kind || 'image') === 'video' ? 'video' : 'image';
  const transformation = kind === 'image' ? 'c_limit,w_2600,h_2600' : '';

  /* Every signed param must be in the signature, sorted by key. */
  const params = { timestamp: String(timestamp) };
  if (folder) params.folder = folder;
  if (transformation) params.transformation = transformation;
  const toSign = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const signature = crypto.createHash('sha1').update(toSign + secret).digest('hex');

  res.status(200).json({ cloudName, apiKey, timestamp, signature, folder: folder || undefined, transformation: transformation || undefined });
};

/* Media library: list what's already uploaded to this site's Cloudinary
   folder so editors can reuse images instead of re-uploading. */
async function mediaLibrary(req, res) {
  const { getSite } = require('./_lib.js');
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
  if (!apiKey || !apiSecret) return res.status(501).json({ error: 'Cloudinary env vars not configured' });

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
}
