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
