// POST /api/auth/login { email, password }  -> session cookie + user
// First run (no users yet): { email, password, name, adminKey } bootstraps the owner account.
// GET  /api/auth/login?google=config       -> { clientId } so the gate knows whether to show the button
// POST /api/auth/login?google=1 { credential } -> same session cookie, via a verified Google ID token
'use strict';
const A = require('../_auth.js');

/* Sign in with a Google ID token. Deliberately a query mode on this file:
   api/ is at Vercel Hobby's 12-function ceiling, so no new endpoint may exist.
   Two rules make this safe to expose:
     1. the token is cryptographically verified (see verifyGoogleToken), and
     2. it only ever signs in an account that ALREADY exists in users.json.
   Everyone on earth has a Google account, so auto-creating one here would turn
   an invite-only CMS into an open door. It never creates a user. */
async function googleLogin(req, res) {
  if (!A.configured(res)) return;
  const b = A.readBody(req);

  let g;
  try { g = await A.verifyGoogleToken(b.credential); }
  catch (e) { return res.status(401).json({ error: e.message }); }

  let store;
  try { store = await A.loadUsers(); } catch (e) { return res.status(502).json({ error: e.message }); }

  const u = store.users.find(x => String(x.email).toLowerCase() === g.email);
  if (!u) return res.status(403).json({ error: 'No editor account exists for ' + g.email + '. Ask your site owner to invite you first.' });
  if (u.status === 'disabled') return res.status(403).json({ error: 'That account has been disabled.' });

  /* First Google sign-in turns an invited account into an active one, with no
     password and no emailed link. Done before the 2FA branch so an invited
     account that also requires 2FA cannot get stuck as "invited" forever. */
  if (u.status === 'invited') {
    u.status = 'active';
    if (!u.name && g.name) u.name = g.name;
    try { await A.saveUsers(store.users, store.sha, 'cms: ' + u.email + ' activated via Google sign-in'); }
    catch (e) { return res.status(502).json({ error: e.message }); }
  }

  /* two-factor: identical rules to the password path, Google does not skip it */
  if (u.totp && u.totp.enabled) {
    if (!b.code && !b.backup) return res.status(200).json({ totp: true });
    const okCode = b.code && A.totpCheck(u.totp.secret, b.code);
    const okBackup = b.backup && A.useBackupCode(u, b.backup);
    if (!okCode && !okBackup)
      return res.status(401).json({ error: b.backup ? 'Backup code not recognized (each works once).' : 'That code did not match.', totp: true });
    if (okBackup) {
      try { await A.saveUsers(store.users, store.sha, 'cms: backup code used by ' + u.email); } catch (e) { /* non-fatal */ }
    }
  } else if (u.totpRequired) {
    return res.status(200).json({ enrollRequired: true, preToken: A.signToken({ uid: u.id, purpose: 'totp-enroll' }, 600) });
  }

  A.setSessionCookie(res, A.signToken({ uid: u.id, role: u.role, purpose: 'session' }, A.SESSION_DAYS * 86400));
  return res.status(200).json({ user: A.publicUser(u) });
}

module.exports = async (req, res) => {
  /* the gate asks this before anyone is signed in; the client id is public */
  if (req.query && req.query.google === 'config')
    return res.status(200).json({ clientId: A.GOOGLE_CLIENT_ID || null });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (req.query && req.query.google) return googleLogin(req, res);
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
  /* ---- two-factor ---- */
  if (u.totp && u.totp.enabled) {
    if (!b.code && !b.backup) { A.recordOk(tKey); return res.status(200).json({ totp: true }); }
    const okCode = b.code && A.totpCheck(u.totp.secret, b.code);
    const okBackup = b.backup && A.useBackupCode(u, b.backup);
    if (!okCode && !okBackup) {
      A.recordFail(tKey);
      return res.status(401).json({ error: b.backup ? 'Backup code not recognized (each works once).' : 'That code did not match.' , totp: true });
    }
    if (okBackup) {
      try { await A.saveUsers(store.users, store.sha, 'cms: backup code used by ' + u.email); } catch (e) { /* non-fatal */ }
    }
  } else if (u.totpRequired) {
    /* admin requires 2FA on this account but it is not enrolled yet */
    A.recordOk(tKey);
    return res.status(200).json({ enrollRequired: true, preToken: A.signToken({ uid: u.id, purpose: 'totp-enroll' }, 600) });
  }

  A.recordOk(tKey);
  A.setSessionCookie(res, A.signToken({ uid: u.id, role: u.role, purpose: 'session' }, A.SESSION_DAYS * 86400));
  res.status(200).json({ user: A.publicUser(u) });
};
