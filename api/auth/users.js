// Admin user management. All calls require an owner/admin session.
//   GET    /api/auth/users                          -> list users (no hashes)
//   POST   /api/auth/users {action:'invite', email, name, role}   -> create + email invite link
//   POST   /api/auth/users {action:'resend', id}                  -> fresh invite/reset link
//   POST   /api/auth/users {action:'delete', id}                  -> remove a user
'use strict';
const crypto = require('crypto');
const A = require('../_auth.js');

module.exports = async (req, res) => {
  if (!A.configured(res)) return;
  let me;
  try { me = await A.authUser(req); } catch (e) { return res.status(502).json({ error: e.message }); }
  if (!A.isAdmin(me)) return res.status(403).json({ error: 'Admins only.' });

  let store;
  try { store = await A.loadUsers(); } catch (e) { return res.status(502).json({ error: e.message }); }

  if (req.method === 'GET')
    return res.status(200).json({ users: store.users.map(A.publicUser) });

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
  const b = A.readBody(req);
  const action = String(b.action || '');

  if (action === 'invite') {
    const email = String(b.email || '').trim().toLowerCase();
    const name = String(b.name || '').slice(0, 80);
    let role = ['admin', 'editor'].includes(b.role) ? b.role : 'editor';
    if (role === 'admin' && me.role !== 'owner') role = 'editor';   // only the owner mints admins
    if (!A.validEmail(email)) return res.status(400).json({ error: 'Enter a valid email.' });
    if (store.users.some(u => String(u.email).toLowerCase() === email))
      return res.status(409).json({ error: 'That email already has an account.' });
    const u = {
      id: crypto.randomUUID(), email, name, role,
      sites: [], caps: { canPublish: false }, status: 'invited',
      invitedBy: me.email, createdAt: new Date().toISOString(),
    };
    store.users.push(u);
    try { await A.saveUsers(store.users, store.sha, 'cms: invite ' + email); }
    catch (e) { return res.status(502).json({ error: e.message }); }
    const token = A.signToken({ uid: u.id, purpose: 'invite' }, 7 * 86400);
    const link = A.setpwLink(token);
    const emailed = await A.sendMail(email, name, 'You have been invited to edit your website', A.inviteEmailHtml(name, link, false));
    return res.status(200).json({ user: A.publicUser(u), link, emailed });
  }

  const target = store.users.find(u => u.id === String(b.id || ''));
  if (!target) return res.status(404).json({ error: 'User not found.' });

  if (action === 'resend') {
    const isReset = target.status === 'active';
    const token = A.signToken({ uid: target.id, purpose: isReset ? 'reset' : 'invite' }, isReset ? 3600 : 7 * 86400);
    const link = A.setpwLink(token);
    const emailed = await A.sendMail(target.email, target.name,
      isReset ? 'Reset your site editor password' : 'You have been invited to edit your website',
      A.inviteEmailHtml(target.name, link, isReset));
    return res.status(200).json({ link, emailed });
  }

  if (action === 'update') {
    if (target.role === 'owner' && me.role !== 'owner')
      return res.status(403).json({ error: 'Only the owner can modify an owner.' });
    if (b.role !== undefined && b.role !== target.role) {
      if (me.role !== 'owner') return res.status(403).json({ error: 'Only the owner can change roles.' });
      if (target.id === me.id) return res.status(400).json({ error: 'You cannot change your own role.' });
      if (['admin', 'editor'].includes(b.role)) target.role = b.role;
    }
    if (Array.isArray(b.sites)) target.sites = b.sites.map(String).slice(0, 100);
    if (b.perms && typeof b.perms === 'object') target.perms = b.perms;
    if (b.caps && typeof b.caps === 'object') target.caps = Object.assign({}, target.caps, b.caps);
    try { await A.saveUsers(store.users, store.sha, 'cms: update access for ' + target.email); }
    catch (e) { return res.status(502).json({ error: e.message }); }
    return res.status(200).json({ user: A.publicUser(target) });
  }

  if (action === 'delete') {
    if (target.id === me.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
    if (target.role === 'owner' && me.role !== 'owner') return res.status(403).json({ error: 'Only the owner can remove an owner.' });
    store.users = store.users.filter(u => u.id !== target.id);
    try { await A.saveUsers(store.users, store.sha, 'cms: remove ' + target.email); }
    catch (e) { return res.status(502).json({ error: e.message }); }
    return res.status(200).json({ ok: true });
  }

  res.status(400).json({ error: 'Unknown action.' });
};
