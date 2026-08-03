// POST /api/auth/logout -> clears the session cookie
'use strict';
const A = require('../_auth.js');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  A.clearSessionCookie(res);
  res.status(200).json({ ok: true });
};
