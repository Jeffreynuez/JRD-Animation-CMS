// Shared auth core for the JRD CMS (files starting with _ are not exposed as routes).
// Zero dependencies: scrypt for password hashing, hand-rolled HS256 JWT, Brevo via REST.
//
// REQUIRED ENV (Vercel project settings):
//   USERS_REPO   - a PRIVATE GitHub repo that stores data/users.json, e.g. "Jeffreynuez/JRD-CMS-users".
//                  MUST be private: it holds password hashes (never plaintext).
//                  The GITHUB_TOKEN fine-grained PAT must have Contents R/W on it.
//   JWT_SECRET   - long random string (e.g. 64 hex chars). Rotating it signs everyone out.
// OPTIONAL ENV:
//   BREVO_API_KEY    - enables invite / reset emails. Without it, invite links are
//                      shown in the admin for copy-paste instead of emailed.
//   MAIL_FROM_EMAIL  - a verified Brevo sender (e.g. jdelanuez@gcwindsor.com)
//   MAIL_FROM_NAME   - display name for emails       (default "JRD Site Editor")
//   ADMIN_URL        - default https://jrd-animation-cms.vercel.app/admin
//   GOOGLE_CLIENT_ID - enables "Sign in with Google" on the gate. Public value,
//                      not a secret. No client secret is needed: we verify the
//                      ID token the browser gets, we do not run a redirect flow.
'use strict';
const crypto = require('crypto');
const { gh, parseB64Json, FILE_RE, SLUG_RE } = require('./_lib.js');

const USERS_REPO = process.env.USERS_REPO || '';
const USERS_BRANCH = process.env.USERS_BRANCH || 'main';
const USERS_PATH = 'data/users.json';
const SECRET = process.env.JWT_SECRET || '';
const BREVO_KEY = process.env.BREVO_API_KEY || '';
const ADMIN_URL = (process.env.ADMIN_URL || 'https://jrd-animation-cms.vercel.app/admin').replace(/\/$/, '');
const MAIL_FROM = process.env.MAIL_FROM_EMAIL || '';
const MAIL_NAME = process.env.MAIL_FROM_NAME || 'JRD Site Editor';
const COOKIE = 'jrd_session';
const SESSION_DAYS = 14;

function configured(res) {
  if (!USERS_REPO) { res.status(501).json({ error: 'Set the USERS_REPO env var to a PRIVATE repo (e.g. Jeffreynuez/JRD-CMS-users) and redeploy.' }); return false; }
  if (!SECRET) { res.status(501).json({ error: 'Set the JWT_SECRET env var (a long random string) and redeploy.' }); return false; }
  return true;
}

/* ---------- users.json in the private repo ---------- */
async function loadUsers() {
  const r = await gh(`/repos/${USERS_REPO}/contents/${USERS_PATH}?ref=${USERS_BRANCH}`);
  if (r.status === 200) {
    const json = parseB64Json(r.json.content);
    return { users: json.users || [], sha: r.json.sha };
  }
  if (r.status === 404) return { users: [], sha: null };
  throw new Error('users store unreachable (' + r.status + '): check USERS_REPO + token scope');
}
async function saveUsers(users, sha, message) {
  const body = {
    message: message || 'cms: update users',
    content: Buffer.from(JSON.stringify({ users }, null, 2)).toString('base64'),
    branch: USERS_BRANCH,
  };
  if (sha) body.sha = sha;
  const r = await gh(`/repos/${USERS_REPO}/contents/${USERS_PATH}`, { method: 'PUT', body: JSON.stringify(body) });
  if (r.status >= 300) throw new Error('users store write failed (' + r.status + ')');
  return r.json.content.sha;
}

/* ---------- passwords (scrypt, no deps) ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$16384$8$1$' + salt.toString('base64') + '$' + hash.toString('base64');
}
function verifyPassword(pw, stored) {
  try {
    const p = String(stored || '').split('$');
    if (p[0] !== 'scrypt') return false;
    const salt = Buffer.from(p[4], 'base64'), want = Buffer.from(p[5], 'base64');
    const got = crypto.scryptSync(String(pw), salt, want.length, { N: +p[1], r: +p[2], p: +p[3] });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch (e) { return false; }
}

/* ---------- JWT (HS256, no deps) ---------- */
const b64u = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function signToken(payload, expSeconds) {
  const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + expSeconds };
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest();
  return h + '.' + p + '.' + b64u(sig);
}
function verifyToken(token) {
  try {
    if (!SECRET || !token) return null;
    const [h, p, s] = String(token).split('.');
    const want = crypto.createHmac('sha256', SECRET).update(h + '.' + p).digest();
    const got = unb64u(s);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    const body = JSON.parse(unb64u(p).toString('utf8'));
    if (!body.exp || body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch (e) { return null; }
}

/* ---------- session cookie ---------- */
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}
function sessionFromReq(req) {
  const c = String(req.headers.cookie || '');
  const m = c.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  return m ? verifyToken(m[1]) : null;
}

/* A session minted before the account's last password set is void, so a
   password reset (or a set after an invite) signs out every older cookie.
   Compared in whole seconds: the cookie set-password issues right after the
   change carries the same second and stays valid. */
const sessionPredatesPassword = (s, u) =>
  !!u.passwordSetAt && Number(s.iat) < Math.floor(Date.parse(u.passwordSetAt) / 1000);
/* Resolve the calling user from the session cookie, the only credential.
   Returns null when unauthenticated. */
async function authUser(req) {
  const s = sessionFromReq(req);
  if (!(s && s.purpose === 'session' && s.uid)) return null;
  const { users } = await loadUsers();
  const u = users.find(x => x.id === s.uid);
  if (u && u.status === 'active' && !sessionPredatesPassword(s, u)) return u;
  return null;
}
/* Does the request carry a session that could authenticate it? Pure CPU (an
   HMAC check), so endpoints call it BEFORE any GitHub read: anonymous traffic
   then cannot spend the shared GitHub budget. */
function hasCredentials(req) {
  const { checkAuth } = require('./_lib.js');
  return checkAuth(req);
}
/* Endpoint auth in one call: { me } on success, else { code, error } to send.
   A users-store outage (rate limit, GitHub 5xx, token scope) is a 503, not a
   401, so the admin does not treat it as a sign-out and reload the page. */
async function authed(req) {
  if (!hasCredentials(req)) return { code: 401, error: 'unauthorized' };
  let me;
  try { me = await authUser(req); }
  catch (e) { return { code: 503, error: 'The account store is unavailable right now. Try again in a moment.' }; }
  return me ? { me } : { code: 401, error: 'unauthorized' };
}
const isAdmin = u => !!u && (u.role === 'owner' || u.role === 'admin');
/* how a commit names the editor who made it. A display name, never the email:
   client site repos can be public, and commit messages are permanent. */
const who = u => String((u && (u.name || (u.email ? String(u.email).split('@')[0] : ''))) || 'an editor').replace(/[\r\n]+/g, ' ').slice(0, 60);
const publicUser = u => ({ id: u.id, email: u.email, name: u.name || '', role: u.role, sites: u.sites || [], perms: u.perms || {}, caps: u.caps || {}, status: u.status, twoFactor: !!(u.totp && u.totp.enabled), totpRequired: !!u.totpRequired, createdAt: u.createdAt });

/* ---------- in-memory login throttle (best effort per lambda instance) ---------- */
const attempts = new Map();
function throttle(key) {
  const now = Date.now();
  const a = attempts.get(key) || { fails: 0, lockUntil: 0 };
  if (a.lockUntil > now) return Math.ceil((a.lockUntil - now) / 1000);
  return 0;
}
function recordFail(key) {
  const a = attempts.get(key) || { fails: 0, lockUntil: 0 };
  a.fails++;
  if (a.fails >= 5) { a.lockUntil = Date.now() + 10 * 60 * 1000; a.fails = 0; }
  attempts.set(key, a);
}
function recordOk(key) { attempts.delete(key); }

/* ---------- Brevo transactional email ---------- */
async function sendMail(toEmail, toName, subject, html) {
  if (!BREVO_KEY || !MAIL_FROM) return false;
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: MAIL_NAME, email: MAIL_FROM },
        to: [{ email: toEmail, name: toName || toEmail }],
        subject, htmlContent: html,
      }),
    });
    return r.status < 300;
  } catch (e) { return false; }
}
/* Invite / reset email.
   Built for email clients, not browsers: tables rather than divs (Outlook's Word
   engine ignores max-width on a div), a table-wrapped button (it ignores padding
   on an <a>), every color stated explicitly (clients that auto-invert for dark
   mode otherwise produce unreadable pairs), and no images at all, since most
   clients block them by default and a header that vanishes is worse than none.
   The visible URL under the button is the fallback for anything that strips the
   button entirely, which would otherwise leave the recipient with no way in. */
const emailEsc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function inviteEmailHtml(name, link, isReset) {
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const who = emailEsc(String(name || '').split(' ')[0] || 'there');
  const href = emailEsc(link);
  const shown = emailEsc(String(link).replace(/^https?:\/\//, ''));

  const c = isReset ? {
    pre: 'Choose a new password for your site editor account.',
    title: 'Reset your password',
    lead: 'a password reset was requested for your site editor account.',
    btn: 'Choose a new password',
    expiry: 'This link expires in 1 hour.',
    tail: 'If you did not ask for this, ignore this email and nothing changes.',
    body: '',
  } : {
    pre: 'Your website editor is ready. Sign in with Google or set a password.',
    title: 'Your website editor is ready',
    lead: 'you can now edit your own website whenever you like. Change text, swap photos, update hours or pricing, and it goes live on your real site. Nothing to install.',
    btn: 'Open your editor',
    expiry: 'This link expires in 7 days.',
    tail: 'If you were not expecting this, you can ignore this email.',
    body: `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px">
              <tr>
                <td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px 20px">
                  <p style="margin:0 0 10px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#0284c7">Two ways to sign in</p>
                  <p style="margin:0 0 7px;font-family:${FONT};font-size:14px;line-height:1.55;color:#334155"><strong style="color:#0f172a">Use Google.</strong> Fastest way in, and there is no password to remember.</p>
                  <p style="margin:0;font-family:${FONT};font-size:14px;line-height:1.55;color:#334155"><strong style="color:#0f172a">Or set a password.</strong> Same screen, if you would rather not use Google.</p>
                </td>
              </tr>
            </table>`,
  };

  return `<!--[if !mso]><!--><div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${emailEsc(c.pre)}</div><!--<![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef2f7;margin:0;padding:0;width:100%">
  <tr>
    <td align="center" style="padding:28px 12px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="width:560px;max-width:100%;background-color:#ffffff;border:1px solid #e2e8f0;border-radius:14px">
        <tr>
          <td style="background-color:#0f172a;padding:20px 32px;border-radius:13px 13px 0 0">
            <span style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:.24em;text-transform:uppercase;color:#38bdf8">JRD Site Editor</span>
          </td>
        </tr>
        <tr>
          <td style="padding:34px 32px 30px">
            <h1 style="margin:0 0 14px;font-family:${FONT};font-size:23px;line-height:1.3;font-weight:700;color:#0f172a">${emailEsc(c.title)}</h1>
            <p style="margin:0 0 24px;font-family:${FONT};font-size:15px;line-height:1.65;color:#475569">Hi ${who}, ${emailEsc(c.lead)}</p>${c.body}
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="#0ea5e9" style="border-radius:9px">
                  <a href="${href}" style="display:inline-block;padding:15px 34px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:9px">${emailEsc(c.btn)}</a>
                </td>
              </tr>
            </table>
            <p style="margin:24px 0 0;font-family:${FONT};font-size:12px;line-height:1.6;color:#94a3b8">Button not working? Paste this into your browser:<br>
              <a href="${href}" style="color:#0284c7;text-decoration:underline;word-break:break-all">${shown}</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px">
            <div style="height:1px;background-color:#e2e8f0;font-size:0;line-height:0">&nbsp;</div>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 32px 24px;border-radius:0 0 13px 13px">
            <p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:#94a3b8">${emailEsc(c.expiry)} ${emailEsc(c.tail)}</p>
            <p style="margin:10px 0 0;font-family:${FONT};font-size:12px;line-height:1.6;color:#cbd5e1">Sent by JRD Animation</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}
const setpwLink = token => ADMIN_URL + '?setpw=' + encodeURIComponent(token);

/* ---------- Google sign-in (zero dependencies) ----------
   Google Identity Services hands the BROWSER a signed ID token; we verify it
   here rather than running an OAuth redirect flow, so there is no callback
   endpoint (the api/ folder is full) and no client secret to store.
   Verification is RS256 against Google's published JWKS using Node's own
   crypto, then issuer, audience, expiry and email_verified. Checking `aud`
   against our own client id is the one that matters most: without it, a token
   any other site minted for its own users would be accepted here.
   Google rotates signing keys, so the key set is cached for an hour and
   refetched once when a token arrives with a kid we have not seen. */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_ISS = ['https://accounts.google.com', 'accounts.google.com'];
let googleKeys = { t: 0, keys: [] };

async function googleJwks(force) {
  if (!force && googleKeys.keys.length && Date.now() - googleKeys.t < 3600000) return googleKeys.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error('Could not reach Google to check that sign-in.');
  const j = await r.json().catch(() => ({}));
  googleKeys = { t: Date.now(), keys: j.keys || [] };
  return googleKeys.keys;
}

/* Resolves to { email, name } for a genuine token, throws with a safe message. */
async function verifyGoogleToken(credential) {
  if (!GOOGLE_CLIENT_ID) throw new Error('Google sign-in is not configured on this server.');
  const parts = String(credential || '').split('.');
  if (parts.length !== 3) throw new Error('That Google token is malformed.');
  const dec = i => JSON.parse(Buffer.from(parts[i], 'base64url').toString('utf8'));

  let head;
  try { head = dec(0); } catch (e) { throw new Error('That Google token is malformed.'); }
  if (head.alg !== 'RS256') throw new Error('Unexpected Google token algorithm.');

  let keys = await googleJwks(false);
  let jwk = keys.find(k => k.kid === head.kid);
  if (!jwk) { keys = await googleJwks(true); jwk = keys.find(k => k.kid === head.kid); }
  if (!jwk) throw new Error('Google signing key not recognized.');

  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('That Google token failed signature checks.');

  let c;
  try { c = dec(1); } catch (e) { throw new Error('That Google token is malformed.'); }
  const now = Math.floor(Date.now() / 1000);
  if (GOOGLE_ISS.indexOf(c.iss) < 0) throw new Error('That token was not issued by Google.');
  if (c.aud !== GOOGLE_CLIENT_ID) throw new Error('That Google token was issued for a different app.');
  if (!(Number(c.exp) > now - 60)) throw new Error('That Google sign-in expired. Try again.');
  if (c.email_verified !== true && c.email_verified !== 'true') throw new Error('That Google account has no verified email address.');
  if (!c.email) throw new Error('Google did not return an email address.');
  return { email: String(c.email).trim().toLowerCase(), name: String(c.name || '').slice(0, 80) };
}

/* ---------- permissions (Phase 2) ---------- */
function siteAllowed(u, siteId) {
  if (isAdmin(u)) return true;
  const s = u.sites || [];
  return s.includes('*') || s.includes(siteId);
}
/* caps: canPublish + canTheme + canDownload are OPT-IN; canUpload + canDelete default ON.
   canDownload lets an account pull its own site's source as a zip from the picker.
   It is opt-in because can() treats an unlisted cap as ON, and a default-ON
   export right would switch itself on for every existing account on deploy. */
const OPT_IN_CAPS = ['canPublish', 'canTheme', 'canDownload'];
function can(u, cap) {
  if (isAdmin(u)) return true;
  const c = (u && u.caps) || {};
  if (OPT_IN_CAPS.indexOf(cap) >= 0) return c[cap] === true;
  return c[cap] !== false;
}
/* section grants -> the data files they map to (per the site's own schema).
   No TTL cache any more: gh() revalidates with the ETag, so an unchanged
   schema costs a 304 (free against the budget) and a schema change applies to
   permissions on the very next request. A failed read throws rather than
   passing for "no sections", so callers can say so instead of refusing edits. */
async function siteSchema(site) {
  const ref = site.branch ? '?ref=' + encodeURIComponent(site.branch) : '';
  const r = await gh(`/repos/${site.repo}/contents/data/${site.schema || '_schema.json'}${ref}`);
  if (r.status !== 200 || !r.json || typeof r.json.content !== 'string')
    throw new Error('could not read the site schema (' + r.status + ')');
  return parseB64Json(r.json.content);
}
const USER_ALWAYS_WRITE = ['styles.json'];  // inline text styling rides along with any grant
async function allowedWriteFiles(u, site) {
  if (isAdmin(u)) return '*';
  const p = ((u.perms || {})[site.id]) || {};
  const secs = p.sections || [];
  if (secs.includes('*')) return '*';
  const schema = await siteSchema(site);
  const set = new Set(USER_ALWAYS_WRITE);
  (schema.sections || []).forEach(sec => {
    if (sec.group || !secs.includes(sec.id)) return;
    if (sec.file) set.add(sec.file);
    (sec.blocks || []).forEach(b => { if (b.file) set.add(b.file); });
  });
  return set;
}

/* ---------- drafts (live in the private users repo - never trigger a site rebuild) ----------
   A draft of data/<file> lives at drafts/<siteId>/<file>, so data files in a
   subfolder (Inca's es/pages.json) get a subfolder under drafts/ as well.
   Every path is checked here, whatever the caller already checked: the site
   id must be a registry slug and the file a registry-style name, so nothing
   can walk out of drafts/ into the rest of the private repo (users.json). */
function draftPath(siteId, file) {
  if (!SLUG_RE.test(String(siteId)) || !FILE_RE.test(String(file))) throw new Error('bad draft path');
  return `/repos/${USERS_REPO}/contents/drafts/${siteId}/${file}`;
}
async function readDraft(siteId, file) {
  const r = await gh(draftPath(siteId, file) + `?ref=${USERS_BRANCH}`);
  if (r.status !== 200 || !r.json || typeof r.json.content !== 'string') return null;   /* missing, or a folder */
  return { data: parseB64Json(r.json.content), sha: r.json.sha };
}
/* One read of what is stored for a draft now: { exists, sha, author, savedAt }.
   A draft that no longer parses still reports its sha (so it can be replaced
   or deleted), just without an author. unknown:true means GitHub did not give
   a clean answer (not a 404), so the caller cannot rely on "no draft". */
async function draftState(siteId, file) {
  const r = await gh(draftPath(siteId, file) + `?ref=${USERS_BRANCH}`);
  if (r.status === 404) return { exists: false, sha: null };
  if (r.status !== 200 || !r.json || Array.isArray(r.json) || typeof r.json.sha !== 'string')
    return { exists: false, sha: null, unknown: true };
  let data = null;
  try { data = typeof r.json.content === 'string' ? parseB64Json(r.json.content) : null; } catch (e) { /* keep the sha */ }
  return { exists: true, sha: r.json.sha, author: (data && data.author) || null, savedAt: (data && data.savedAt) || null };
}
/* Write a draft. `expect` is the draft sha the editor last saw:
     undefined   no check (an editor tab from before draftSha existed, or force)
     null        the editor saw no draft
     '<sha>'     the editor saw that version
   With an expectation the write is a compare-and-swap done by GitHub: the PUT
   carries the expected sha (or none), and GitHub refuses it if the draft has
   changed. The usual save is therefore ONE call with no read-then-write race;
   only a refused write reads the draft, to say who changed it.
   Resolves { ok:true, sha } | { ok:false, conflict:{ sha, author, savedAt } } | { ok:false }. */
async function writeDraft(siteId, file, data, expect) {
  const path = draftPath(siteId, file);
  const put = sha => {
    const body = {
      message: 'cms: draft ' + siteId + '/' + file,
      content: Buffer.from(JSON.stringify(data, null, 1)).toString('base64'),
      branch: USERS_BRANCH,
    };
    if (sha) body.sha = sha;
    return gh(path, { method: 'PUT', body: JSON.stringify(body) });
  };
  const wrote = r => (r.status === 200 || r.status === 201) ? { ok: true, sha: (r.json && r.json.content && r.json.content.sha) || null } : null;

  if (expect === undefined) {
    /* no expectation: overwrite whatever is there (needs its sha) */
    const cur = await draftState(siteId, file);
    return wrote(await put(cur.exists ? cur.sha : null)) || { ok: false };
  }
  const first = wrote(await put(expect));
  if (first) return first;
  /* refused: see what is there now */
  const cur = await draftState(siteId, file);
  if (cur.exists && cur.sha !== expect) return { ok: false, conflict: cur };
  /* the draft the editor saw was published or rejected meanwhile: nothing to overwrite */
  if (!cur.exists && !cur.unknown && expect) return wrote(await put(null)) || { ok: false };
  return { ok: false };
}
/* Every draft of a site with its parsed data: [{ file, sha, data }]. Walks
   subfolders (drafts/<site>/es/home.json -> file "es/home.json"). One
   unreadable draft is skipped, never allowed to hide the rest of the queue. */
async function collectDrafts(siteId, sub, depth) {
  if (!SLUG_RE.test(String(siteId))) return [];
  const r = await gh(`/repos/${USERS_REPO}/contents/drafts/${siteId}${sub ? '/' + sub : ''}?ref=${USERS_BRANCH}`);
  if (r.status !== 200 || !Array.isArray(r.json)) return [];
  /* entries are read side by side; the result keeps GitHub's listing order */
  const parts = await Promise.all(r.json.map(async f => {
    const rel = sub ? sub + '/' + f.name : f.name;
    if (f.type === 'dir') return (depth || 0) < 4 ? collectDrafts(siteId, rel, (depth || 0) + 1) : [];
    if (f.type !== 'file') return [];
    const d = await readDraft(siteId, rel).catch(() => null);
    return d && d.data ? [{ file: rel, sha: d.sha, data: d.data }] : [];
  }));
  return [].concat(...parts);
}
async function listDrafts(siteId) {
  return (await collectDrafts(siteId)).map(d => ({ file: d.file, author: d.data.author, savedAt: d.data.savedAt, publishAt: d.data.publishAt || null }));
}
/* which sites have a drafts/ folder at all: one listing instead of one per
   site. null means "could not tell", so the caller checks every site. */
async function draftSites() {
  const r = await gh(`/repos/${USERS_REPO}/contents/drafts?ref=${USERS_BRANCH}`);
  if (r.status === 404) return new Set();
  if (r.status !== 200 || !Array.isArray(r.json)) return null;
  return new Set(r.json.filter(f => f.type === 'dir').map(f => f.name));
}
/* With knownSha (from a read the caller already did) only THAT version is
   deleted, with no lookup: if GitHub refuses, the draft changed after the
   caller read it, i.e. someone saved newer work, and it is left alone.
   Without knownSha whatever draft is there is looked up and deleted. */
async function deleteDraft(siteId, file, knownSha) {
  const path = draftPath(siteId, file);
  const del = sha => gh(path, {
    method: 'DELETE',
    body: JSON.stringify({ message: 'cms: clear draft ' + siteId + '/' + file, sha, branch: USERS_BRANCH }),
  });
  if (knownSha) {
    const d = await del(knownSha);
    return d.status === 200 || d.status === 404;
  }
  const r = await gh(path + `?ref=${USERS_BRANCH}`);
  if (r.status !== 200 || !r.json || typeof r.json.sha !== 'string' || Array.isArray(r.json)) return true;
  const d = await del(r.json.sha);
  return d.status === 200;
}

/* ---------- TOTP two-factor (RFC 6238, no deps) ---------- */
const B32A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32A[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32A[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(str) {
  let bits = 0, val = 0; const out = [];
  for (const c of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    val = (val << 5) | B32A.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secretBuf, counter) {
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secretBuf).update(b).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
function totpCheck(secretB32, code, windowSteps) {
  const sec = b32decode(secretB32);
  const t = Math.floor(Date.now() / 30000);
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return false;
  const w = windowSteps == null ? 1 : windowSteps;
  for (let i = -w; i <= w; i++) if (hotp(sec, t + i) === c) return true;
  return false;
}
const newTotpSecret = () => b32encode(crypto.randomBytes(20));
function otpauthURI(email, secret) {
  const issuer = encodeURIComponent(MAIL_NAME);
  return 'otpauth://totp/' + issuer + ':' + encodeURIComponent(email) + '?secret=' + secret + '&issuer=' + issuer + '&digits=6&period=30';
}
const hashBackup = c => crypto.createHash('sha256').update(String(c).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
function newBackupCodes() {
  const codes = [];
  for (let i = 0; i < 8; i++) {
    const raw = b32encode(crypto.randomBytes(5)).slice(0, 8);
    codes.push(raw.slice(0, 4) + '-' + raw.slice(4));
  }
  return codes;
}
/* consume a backup code; returns true (and mutates u.totp.backup) on match */
function useBackupCode(u, code) {
  if (!u.totp || !Array.isArray(u.totp.backup)) return false;
  const h = hashBackup(code);
  const i = u.totp.backup.indexOf(h);
  if (i < 0) return false;
  u.totp.backup.splice(i, 1);
  return true;
}

/* Only a body Vercel already parsed as application/json counts. A string body
   means text/plain (or similar), which a cross-site form can send without a
   CORS preflight, so it is ignored rather than parsed. The admin always sends
   application/json. */
function readBody(req) {
  const b = req.body;
  return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
}
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());

module.exports = {
  configured, loadUsers, saveUsers, hashPassword, verifyPassword,
  signToken, verifyToken, setSessionCookie, clearSessionCookie, sessionFromReq,
  authUser, hasCredentials, authed, isAdmin, who, publicUser, throttle, recordFail, recordOk,
  sendMail, inviteEmailHtml, setpwLink, readBody, validEmail, SESSION_DAYS,
  siteAllowed, can, allowedWriteFiles, siteSchema, readDraft, draftState, writeDraft, listDrafts, collectDrafts, draftSites, deleteDraft,
  totpCheck, newTotpSecret, otpauthURI, newBackupCodes, hashBackup, useBackupCode,
  GOOGLE_CLIENT_ID, verifyGoogleToken,
};
