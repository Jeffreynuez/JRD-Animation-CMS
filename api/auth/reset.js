// POST /api/auth/reset { email } -> emails a 1-hour reset link.
// Always answers ok:true so the endpoint can't be used to probe which emails exist.
// Throttled per IP and per email (5 requests, then 10 minutes), so it cannot be
// used to flood someone's inbox, burn the Brevo quota or the GitHub budget. The
// email is sent before the answer (a function may be frozen once it has
// replied, and a reset email that silently never leaves is worse than a timing
// hint), and an unknown email waits a similar, jittered time so the two cases
// are hard to tell apart.
'use strict';
const A = require('../_auth.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!A.configured(res)) return;
  const email = String((A.readBody(req).email || '')).trim().toLowerCase();
  if (!A.validEmail(email)) return res.status(400).json({ error: 'Enter a valid email.' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'ip';
  const kIp = 'reset|ip|' + ip, kEmail = 'reset|email|' + email;
  if (A.throttle(kIp) || A.throttle(kEmail))
    return res.status(429).json({ error: 'Too many reset requests. Try again in 10 minutes.' });
  A.recordFail(kIp); A.recordFail(kEmail);   /* used as a request counter, not a failure */

  let sent = false;
  try {
    const { users } = await A.loadUsers();
    const u = users.find(x => String(x.email).toLowerCase() === email && x.status === 'active');
    if (u) {
      const token = A.signToken({ uid: u.id, purpose: 'reset' }, 3600);
      await A.sendMail(u.email, u.name, 'Reset your site editor password',
        A.inviteEmailHtml(u.name, A.setpwLink(token), true));
      sent = true;
    }
  } catch (e) { /* still answer ok */ }
  if (!sent) await new Promise(r => setTimeout(r, 250 + Math.floor(Math.random() * 350)));
  res.status(200).json({ ok: true, note: 'If that email has an account, a reset link is on its way.' });
};
