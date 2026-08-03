// GET /api/auth/me -> the signed-in user (session cookie or legacy admin key)
'use strict';
const A = require('../_auth.js');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!A.configured(res)) return;
  try {
    const u = await A.authUser(req);
    if (!u) return res.status(401).json({ error: 'unauthenticated' });
    res.status(200).json({ user: A.publicUser(u) });
  } catch (e) { res.status(502).json({ error: e.message }); }
};
