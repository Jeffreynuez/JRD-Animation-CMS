// POST /api/auth/login { email, password }  -> session cookie + user
// First run (no users yet): { email, password, name, adminKey } bootstraps the owner account.
'use strict';
const A = require('../_auth.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!A.configured(res)) return;
  const b = A.readBody(req);
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  if (!A.validEmail(email) || !password) return res.status(400).json({ error: 'Email and password required.' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'ip';
  const tKey = email + '|' + ip;
  const wait = A.throttle(tKey);
  if (wait) return res.status(429).json({ error: 'Too many attempts. Try again in ' + Math.ceil(wait / 60) + ' min.' });

  let store;
  try { store = await A.loadUsers(); } catch (e) { return res.status(502).json({ error: e.message }); }

  /* ---- first run: no users exist yet -> bootstrap the owner ---- */
  if (!store.users.length) {
    if (!b.adminKey) return res.status(409).json({ error: 'no-users' }); // admin.html shows the bootstrap form
    const { checkAuth } = require('../_lib.js');
    if (!checkAuth({ headers: { 'x-admin-key': String(b.adminKey) } }))
      return res.status(401).json({ error: 'Admin key incorrect.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const owner = {
      id: require('crypto').randomUUID(), email, name: String(b.name || 'Owner').slice(0, 80),
      role: 'owner', sites: ['*'], caps: { canPublish: true }, status: 'active',
      hash: A.hashPassword(password), createdAt: new Date().toISOString(),
    };
    try { await A.saveUsers([owner], store.sha, 'cms: bootstrap owner account'); }
    catch (e) { return res.status(502).json({ error: e.message }); }
    A.setSessionCookie(res, A.signToken({ uid: owner.id, role: owner.role, purpose: 'session' }, A.SESSION_DAYS * 86400));
    return res.status(200).json({ user: A.publicUser(owner), bootstrapped: true });
  }

  /* ---- normal login ---- */
  await new Promise(r => setTimeout(r, 250)); // flatten timing
  const u = store.users.find(x => String(x.email).toLowerCase() === email);
  if (!u || u.status !== 'active' || !A.verifyPassword(password, u.hash)) {
    A.recordFail(tKey);
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  A.recordOk(tKey);
  A.setSessionCookie(res, A.signToken({ uid: u.id, role: u.role, purpose: 'session' }, A.SESSION_DAYS * 86400));
  res.status(200).json({ user: A.publicUser(u) });
};
