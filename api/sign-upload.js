'use strict';
const crypto = require('crypto');
const { checkAuth } = require('./_lib.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!checkAuth(req)) return res.status(401).json({ error: 'unauthorized' });
  const apiKey = process.env.CLOUDINARY_API_KEY, secret = process.env.CLOUDINARY_API_SECRET;
  if (!apiKey || !secret) return res.status(501).json({ error: 'Cloudinary env vars not configured' });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHash('sha1').update(`timestamp=${timestamp}${secret}`).digest('hex');
  res.status(200).json({ cloudName: 'dfmofrlt3', apiKey, timestamp, signature });
};
