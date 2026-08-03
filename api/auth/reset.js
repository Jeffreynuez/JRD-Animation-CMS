// POST /api/auth/reset { email } -> emails a 1-hour reset link.
// Always answers ok:true so the endpoint can't be used to probe which emails exist.
'use strict';
const A = require('../_auth.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!A.configured(res)) return;
  const email = String((A.readBody(req).email || '')).trim().toLowerCase();
  if (!A.validEmail(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  try {
    const { users } = await A.loadUsers();
    const u = users.find(x => String(x.email).toLowerCase() === email && x.status === 'active');
    if (u) {
      const token = A.signToken({ uid: u.id, purpose: 'reset' }, 3600);
      await A.sendMail(u.email, u.name, 'Reset your site editor password',
        A.inviteEmailHtml(u.name, A.setpwLink(token), true));
    }
  } catch (e) { /* still answer ok */ }
  res.status(200).json({ ok: true, note: 'If that email has an account, a reset link is on its way.' });
};
