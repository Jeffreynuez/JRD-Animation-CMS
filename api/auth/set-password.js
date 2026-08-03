// POST /api/auth/set-password { token, password }
// Completes an invite OR a password reset (the token's purpose decides), then signs the user in.
'use strict';
const A = require('../_auth.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!A.configured(res)) return;
  const b = A.readBody(req);
  const t = A.verifyToken(String(b.token || ''));
  if (!t || !['invite', 'reset'].includes(t.purpose))
    return res.status(401).json({ error: 'This link is invalid or has expired. Ask for a new one.' });
  const password = String(b.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  let store;
  try { store = await A.loadUsers(); } catch (e) { return res.status(502).json({ error: e.message }); }
  const u = store.users.find(x => x.id === t.uid);
  if (!u) return res.status(404).json({ error: 'Account no longer exists.' });

  u.hash = A.hashPassword(password);
  u.status = 'active';
  u.passwordSetAt = new Date().toISOString();
  try { await A.saveUsers(store.users, store.sha, 'cms: password set for ' + u.email); }
  catch (e) { return res.status(502).json({ error: e.message }); }

  A.setSessionCookie(res, A.signToken({ uid: u.id, role: u.role, purpose: 'session' }, A.SESSION_DAYS * 86400));
  res.status(200).json({ user: A.publicUser(u) });
};
