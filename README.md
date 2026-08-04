# JRD Animation CMS

A standalone, multi-site content management system with real user accounts.
One admin UI manages many static websites — each site is a GitHub repo, read
and written live via the GitHub Contents API. Deployed on Vercel at
**https://jrd-animation-cms.vercel.app/admin**.

This repo contains **only the CMS** — no website content of its own. The sites
it manages (the JRD portfolio, Proguild, GC Windsor, and future clients) live
in their own repos and are registered in `data/sites.json`.

Zero npm dependencies: password hashing (scrypt), JWT sessions, and TOTP 2FA
are built on Node's `crypto`; email goes through the Brevo REST API; the QR
code for 2FA enrollment is generated in-page by an embedded MIT-licensed
encoder so secrets never leave the browser.

## Features

- **Accounts** — email + password sign-in, invite-by-link flow (clients set
  their own password), password reset, rate limiting and lockout.
- **Two-factor auth** — TOTP (any authenticator app), QR + manual key
  enrollment, one-time backup codes, admin can require or reset 2FA per user.
- **Permissions** — per-user grants enforced server-side: which sites, which
  sections (mapped to data files via each site's schema), and capabilities
  (publish directly, delete items, upload media, edit theme). Role presets:
  Site admin / Editor / Contributor.
- **Draft review** — users without publish rights submit changes for review;
  admins approve or reject from the 🕓 Drafts queue. Drafts live in the private
  users repo, so nothing rebuilds until approved.
- **Editing UX** — click-to-edit visual editor on the live page, Manage
  Content drawer, drag-and-drop image upload (drop on a list to add, on an item
  to replace), new items insert at the top, live preview sync for deletes,
  publish countdown with auto preview reload.
- **Media** — per-site Cloudinary routing, signed uploads, pre-flight size
  caps (10MB image / 100MB video), images stored web-lean via a signed
  incoming transformation (`c_limit,w_2600,h_2600`), a media library for
  reusing anything already uploaded, crop tool, and a focal-point picker so
  the important part of a photo stays centred in every crop.
- **Working like a real editor** — Save (kept as a draft, restored next
  visit) is separate from Publish (live); autosave every 30s; undo/redo
  (Ctrl+Z / Ctrl+Y); per-section version history with one-click restore;
  scheduled publishing ("go live Friday 9am"); on-page drag-and-drop to add,
  replace and reorder images; empty alt-text nudges; a first-visit tour.

## Structure

```
admin.html          The CMS single-page app (login/2FA gate, site picker,
                    users & access panel, drafts queue, content drawer,
                    visual editor bridge). Two script blocks: embedded QR
                    library + the app.
api/
  _lib.js           Registry loader, legacy auth, GitHub fetch helper.
  _auth.js          Auth core: users store, scrypt, JWT, sessions, TOTP,
                    backup codes, permissions, drafts, Brevo email.
  auth/
    login.js        Sign in (+ bootstrap first owner, 2FA challenge/enroll)
    logout.js       Clear session
    me.js           Current user
    users.js        List / invite / update access / resend link / delete
    totp.js         2FA setup / confirm / disable
    set-password.js Complete an invite or reset link
    reset.js        Request a password reset email
  load.js           GET a site's data/<file>.json   (site access enforced)
  save.js           PUT a site's data/<file>.json   (section/file + publish
                    rights enforced; non-publishers write a draft instead)
  sign-upload.js    Signs Cloudinary uploads        (upload right enforced)
  sites.js          Site registry                   (writes are admin-only)
  drafts.js         Draft queue: list / approve / reject
data/
  sites.json        The site registry (which repos this CMS manages)
index.html          Redirects / -> /admin
vercel.json         cleanUrls so /admin serves admin.html; /api/* are functions
```

## Environment variables (Vercel project settings)

| Variable                 | Purpose                                                        |
|--------------------------|----------------------------------------------------------------|
| `GITHUB_TOKEN`           | Fine-grained PAT with Contents R/W on every managed repo, this repo, **and the users repo**. |
| `GITHUB_REPO`            | Home repo where `data/sites.json` lives.                       |
| `GITHUB_BRANCH`          | Home repo branch. `main`.                                      |
| `USERS_REPO`             | **PRIVATE** repo holding `data/users.json` + `drafts/` (e.g. `Jeffreynuez/JRD-CMS-users`). Private is mandatory — it stores password hashes and 2FA secrets. |
| `JWT_SECRET`             | Long random string signing sessions/invites. Rotating it signs everyone out. |
| `ADMIN_PASSWORD`         | Legacy shared key (still accepted as owner during migration; retire later). |
| `CLOUDINARY_API_KEY`     | Cloudinary key for signed uploads.                             |
| `CLOUDINARY_API_SECRET`  | Cloudinary secret. **Never commit this.**                      |
| `CLOUDINARY_CLOUDS`      | Comma allow-list of cloud names sites may upload to.           |
| `BREVO_API_KEY`          | *(optional)* Enables invite/reset emails. Without it, links are copied to the clipboard for manual sharing. |
| `MAIL_FROM_EMAIL`        | *(optional)* A **verified Brevo sender**. Avoid bare gmail addresses (deliverability). |
| `MAIL_FROM_NAME`         | *(optional)* Email display name + 2FA issuer label. Default "JRD Site Editor". |
| `ADMIN_URL`              | *(optional)* Base URL used in invite links.                    |
| `CRON_SECRET`            | *(optional)* Random string; lets the daily Vercel cron authenticate to `/api/cron` for scheduled publishing. |

## Day-to-day

**First run** — with no users, the login screen bootstraps the owner account
(email + password + the legacy admin key).

**Inviting a client** — 👥 Users → invite by email → then open their
**Access** sheet and grant sites/sections/capabilities (new users can access
*nothing* until granted — this step is not optional). Pick a preset, tweak,
save. Send them the link (emailed automatically once Brevo is configured).

**Reviewing client work** — users without "Publish directly" submit changes;
a 🕓 Drafts badge appears when you open that site. Approve publishes with the
normal rebuild countdown; reject discards.

**Adding a website** — `/admin` → site picker → **+ Add a website** (admins
only). The repo needs `data/_schema.json`, its `data/*.json` content files, a
`scripts/build.js` that renders data → HTML, and the `?edit=1` editor bridge
in its `main.js`. Then widen `GITHUB_TOKEN` to the new repo (Contents R/W).

**After deploying the CMS itself** — browsers cache `admin.html` hard: always
hard-refresh (Ctrl+F5) before judging a change.

See `CLAUDE.md` for the working notes future development sessions should read
first, and `CMS-V2-PLAN.md` for the feature roadmap.
