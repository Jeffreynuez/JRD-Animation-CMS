// Two-factor enrollment & management.
//   POST {action:'setup'}                    -> new pending secret + otpauth:// URI
//   POST {action:'confirm', code}            -> verify code, enable 2FA, return backup codes (shown ONCE)
//   POST {action:'disable', code|backup}     -> turn 2FA off for yourself
// Auth: a normal session, OR a preToken (purpose 'totp-enroll') issued by login
// when an account has 2FA required but not yet enrolled.
'use strict';
const A = require('../_auth.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!A.configured(res)) return;
  const b = A.readBody(req);

  /* resolve the acting account (session or enrollment pre-token) */
  let uid = null, viaPre = false;
  const me = await A.authUser(req).catch(() => null);
  if (me && me.id !== '__legacy__') uid = me.id;
  if (!uid && b.preToken) {
    const t = A.verifyToken(String(b.preToken));
    if (t && t.purpose === 'totp-enroll') { uid = t.uid; viaPre = true; }
  }
  if (!uid) return res.status(401).json({ error: 'unauthorized' });

  let store;
  try { store = await A.loadUsers(); } catch (e) { return res.status(502).json({ error: e.message }); }
  const u = store.users.find(x => x.id === uid);
  if (!u) return res.status(404).json({ error: 'account not found' });

  if (b.action === 'setup') {
    const secret = A.newTotpSecret();
    u.totp = Object.assign({}, u.totp, { pending: secret });
    try { await A.saveUsers(store.users, store.sha, 'cms: 2fa setup started for ' + u.email); }
    catch (e) { return res.status(502).json({ error: e.message }); }
    return res.status(200).json({ secret, otpauth: A.otpauthURI(u.email, secret) });
  }

  if (b.action === 'confirm') {
    const pending = u.totp && u.totp.pending;
    if (!pending) return res.status(400).json({ error: 'No setup in progress - start again.' });
    if (!A.totpCheck(pending, b.code)) return res.status(401).json({ error: 'That code did not match. Check the app and try again.' });
    const codes = A.newBackupCodes();
    u.totp = { enabled: true, secret: pending, backup: codes.map(A.hashBackup), enabledAt: new Date().toISOString() };
    try { await A.saveUsers(store.users, store.sha, 'cms: 2fa enabled for ' + u.email); }
    catch (e) { return res.status(502).json({ error: e.message }); }
    if (viaPre) A.setSessionCookie(res, A.signToken({ uid: u.id, role: u.role, purpose: 'session' }, A.SESSION_DAYS * 86400));
    return res.status(200).json({ ok: true, backupCodes: codes, user: A.publicUser(u) });
  }

  if (b.action === 'disable') {
    if (!(u.totp && u.totp.enabled)) return res.status(400).json({ error: '2FA is not enabled.' });
    const okCode = b.code && A.totpCheck(u.totp.secret, b.code);
    const okBackup = b.backup && A.useBackupCode(u, b.backup);
    if (!okCode && !okBackup) return res.status(401).json({ error: 'Enter a valid authenticator or backup code to disable 2FA.' });
    if (u.totpRequired) return res.status(403).json({ error: 'Your admin requires 2FA on this account. Ask them to lift the requirement first.' });
    delete u.totp;
    try { await A.saveUsers(store.users, store.sha, 'cms: 2fa disabled for ' + u.email); }
    catch (e) { return res.status(502).json({ error: e.message }); }
    return res.status(200).json({ ok: true, user: A.publicUser(u) });
  }

  res.status(400).json({ error: 'Unknown action.' });
};
