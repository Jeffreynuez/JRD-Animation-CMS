'use strict';
const crypto = require('crypto');
const A = require('./_auth.js');

/* The cloud and folder a managed site uploads to are declared in its own
   data/_schema.json ("cloudName", "mediaFolder"). The browser only names the
   SITE; the server checks the caller may use that site and reads the cloud and
   folder from its schema, so an account cannot sign uploads into another
   client's folder or another cloud. The cloud is still allow-listed so a bad
   schema can't send uploads somewhere odd. Falls back to CLOUDINARY_CLOUD_NAME,
   then to the legacy default. A site without mediaFolder uploads to the cloud
   root, as before. */
const ALLOWED = (process.env.CLOUDINARY_CLOUDS || 'dlgc3fj6w,dfmofrlt3')
  .split(',').map(s => s.trim()).filter(Boolean);
const DEFAULT_CLOUD = process.env.CLOUDINARY_CLOUD_NAME || ALLOWED[0];
const cleanFolder = f => String(f || '').trim().replace(/[^a-zA-Z0-9_\-/]/g, '');

/* shared by both modes: auth, then the site (resolved in parallel), then access */
async function siteFor(req, res, siteId) {
  const { getSite } = require('./_lib.js');
  if (!A.hasCredentials(req)) { res.status(401).json({ error: 'unauthorized' }); return null; }
  const [auth, site] = await Promise.all([
    A.authed(req),
    siteId ? getSite(siteId).catch(() => null) : null,
  ]);
  if (!auth.me) { res.status(auth.code).json({ error: auth.error }); return null; }
  if (!siteId) { res.status(400).json({ error: 'Missing site. Reload the editor and try again.' }); return null; }
  if (!site) { res.status(400).json({ error: 'unknown site' }); return null; }
  if (!A.siteAllowed(auth.me, site.id)) { res.status(403).json({ error: 'no access to this site' }); return null; }
  return { me: auth.me, site };
}

module.exports = async (req, res) => {
  /* GET ?list=1&site=<id>[&cursor=..] -> media library (folded in here to
     stay under the Vercel Hobby 12-function cap - do NOT add new api files) */
  if (req.method === 'GET' && req.query.list) return mediaLibrary(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  /* POST { site, kind } -> a signed upload for that site's cloud + folder */
  const body = A.readBody(req);
  const ctx = await siteFor(req, res, String(body.site || ''));
  if (!ctx) return;
  if (!A.can(ctx.me, 'canUpload')) return res.status(403).json({ error: 'Uploads are not enabled for your account.' });

  const apiKey = process.env.CLOUDINARY_API_KEY, secret = process.env.CLOUDINARY_API_SECRET;
  if (!apiKey || !secret) return res.status(501).json({ error: 'Cloudinary env vars not configured' });

  let schema;
  try { schema = await A.siteSchema(ctx.site); }
  catch (e) { return res.status(502).json({ error: 'Could not read the site schema. Try again in a moment.' }); }
  const asked = String(schema.cloudName || '').trim();
  const cloudName = ALLOWED.includes(asked) ? asked : DEFAULT_CLOUD;
  /* An optional folder keeps each site's media tidy (e.g. "gcwindsor"). */
  const folder = cleanFolder(schema.mediaFolder);

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
  const ctx = await siteFor(req, res, req.query.site ? String(req.query.site) : '');
  if (!ctx) return;

  let schema;
  try { schema = await A.siteSchema(ctx.site); } catch (e) { return res.status(502).json({ error: 'could not read the site schema' }); }
  const cloud = String(schema.cloudName || '').trim();
  const folder = cleanFolder(schema.mediaFolder);
  if (!cloud || !ALLOWED.includes(cloud)) return res.status(400).json({ error: 'this site has no media cloud configured' });
  /* no folder means no prefix, which would list the WHOLE shared cloud (every
     other client's assets), so the library stays empty until one is set */
  if (!folder) return res.status(200).json({ items: [], cursor: null, note: 'Set "mediaFolder" in this site\'s data/_schema.json to use the media library.' });

  const apiKey = process.env.CLOUDINARY_API_KEY, apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!apiKey || !apiSecret) return res.status(501).json({ error: 'Cloudinary env vars not configured' });

  const kind = req.query.kind === 'video' ? 'video' : 'image';
  const qs = new URLSearchParams({ max_results: '60' });
  qs.set('prefix', folder + '/');
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
