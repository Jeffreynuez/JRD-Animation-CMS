# CLAUDE.md — working notes for sessions editing this CMS

Read this before touching anything. It records where the last session left off
(2026-08-03) and the constraints that are easy to get wrong.

## What this is

Multi-site git-backed CMS for Jeffrey's client-site business (sold via Fiverr
gigs). `admin.html` is the entire front end; `api/*.js` are Vercel serverless
functions; GitHub repos are the database; Cloudinary is media storage. There is
deliberately **no build step and zero npm dependencies** — keep it that way.
Auth (scrypt/JWT/TOTP) is hand-rolled on Node `crypto`; email is Brevo via
REST; the 2FA QR encoder is embedded in `admin.html` as its own `<script>`.

Deep architectural memory lives in Pinecone (index `claude-memory`, namespace
`webflow`, records prefixed `jrdcms-`). Search it at session start.

## Status (2026-08-04)

Shipped and live: UX overhaul (drag-and-drop uploads, add-at-top, live delete
sync, publish countdown, upload size caps + incoming transformation), Phase 1
accounts (bootstrap owner, invites, resets, sessions), Phase 2 permissions
(server-enforced site/section/capability grants, Access editor with presets,
draft-for-approval queue), Phase 3 TOTP 2FA (QR + manual key, backup codes,
admin require/reset). Jeffrey's owner account has 2FA enabled.

Editor v3 (2026-08-04): Save (draft) / Publish split — load.js prefers a
saved draft so work persists across sessions (save.js draft:true writes it;
live publish deletes it); undo/redo (snapshot history hooked on
renderSidebar, Ctrl+Z/Y); autosave every 30s (drafts, preserves publishAt);
on-page file-drop add/replace with buffer transfer (Files cloned across the
iframe boundary fail to read — bytes are read in the iframe and transferred);
on-page drag-reorder with a gold insertion divider; media library
(api/media.js, Cloudinary Admin API); version history + restore
(api/history.js, git commits per data file); focal point picker (stores a
`#fp=x,y` suffix on the media value — build.js strips it from URLs and emits
object-position; admin cdn()/cloudParts strip it too); alt-text nudges;
first-visit tour (localStorage jrd-tour-done); scheduled publishing
(draft.publishAt + api/cron.js, fired by the vercel.json daily cron with
CRON_SECRET *and* opportunistic pokes from the admin every 5 min).
GC-Windsor build.js chains stored crop transforms BEFORE the delivery
transform (order matters: crop coords are in original pixels).

**Not configured yet:** `CRON_SECRET` (any random string - Vercel then
authenticates the daily cron; without it only the in-editor pokes fire
scheduled publishes) and `BREVO_API_KEY` / `MAIL_FROM_EMAIL` env vars — invites
currently copy their link to the clipboard instead of emailing. Jeffrey wants a
sender that is NOT his GC Windsor address; options discussed: second verified
sender in his existing Brevo account, or a separate Brevo account.

**Next planned (see CMS-V2-PLAN.md):** Phase 4 = version history / one-click
rollback + audit log mined from the git commits every publish already creates.
Then media library, soft delete, autosave, white-label, onboarding tour,
mobile pass. Also open: per-user "sites at a glance" in the users list,
"last active" column, retiring the legacy `ADMIN_PASSWORD` path once accounts
are fully adopted, and adding the `item-remove` bridge handler to Proguild and
the JRD portfolio `main.js` (only GC-Windsor has it — live delete sync does
nothing on the other sites until then).

## Deploy workflow (this is the part people break)

- Claude sessions CANNOT push to GitHub from the Cowork cloud sandbox (the
  GitHub API is proxied and returns 403). Write files to Jeffrey's local repo
  (`App creation business/JRD-Animation-CMS`) via the device bridge; **Jeffrey
  commits and pushes in GitHub Desktop**. Vercel auto-deploys.
- Browsers cache `admin.html` hard — always tell Jeffrey to Ctrl+F5 after a
  deploy before judging whether a change worked.
- `admin.html` has TWO `<script>` blocks (QR lib, then the app). When syntax-
  checking, extract and `node --check` them separately.
- Managed-site repos (GC-Windsor etc.) deploy differently: files are written
  to the local repo and Jeffrey runs `npm run build` + `npm run push` (their
  push.js commits via the GitHub API; afterwards his local git is behind →
  discard + pull). Rule: if push.js sent the change, discard+pull is safe; if
  files were only written to disk, commit+push — never discard.

## Sharp edges

- **users.json + drafts/ live in the PRIVATE `USERS_REPO`** — never move them
  to a public repo (password hashes, TOTP secrets, backup-code hashes).
- `_lib.js` ⇄ `_auth.js` have a deliberate lazy circular require
  (`checkAuth` ↔ `sessionFromReq`). Keep requires inside functions there.
- Permissions enforce per **data file** server-side but per **section** in the
  UI. Sections sharing a file (several Home sections share `pages.json`) are
  only separated visually — don't promise file-level isolation between them.
- Section grants map to files via each site's `data/_schema.json`, cached 60s
  in `_auth.js` (`schemaCache`). New schema sections take up to a minute to
  reflect in permissions.
- `canPublish` and `canTheme` are **opt-in** caps (default false);
  `canUpload` and `canDelete` are **default-on** (false only when explicitly
  set). `can()` in `_auth.js` is the single source of truth.
- Newly invited users have `sites: []` — access to nothing until the admin
  grants it in their Access sheet. This is intentional; don't "fix" it.
- The legacy `x-admin-key` header still authenticates as a synthetic owner
  (`id: '__legacy__'`). The admin UI sends it alongside the session cookie;
  several fetches rely on either working.
- 2FA: TOTP secrets must never leave the page or hit third-party services
  (that's why the QR is generated locally). `hotp()` is verified against the
  RFC-4226 test vectors — if you touch it, re-verify.
- Uploads: Cloudinary free-plan hard caps are 10MB image / 100MB video —
  the client-side pre-check in `uploadToCloudinary` mirrors them. Images get a
  signed incoming transformation `c_limit,w_2600,h_2600` from
  `api/sign-upload.js`; the signature covers it, so client and server must
  agree on the string.
- The editor iframe shows the LAST PUBLISHED build. Text edits sync live via
  the `?edit=1` postMessage bridge in each site's `main.js`; structural
  changes only sync for deletes (`{jrd:'item-remove'}`, which also re-indexes
  `data-edit`/`data-edit-item` stamps). Everything else appears after
  Save & publish (~1 min Vercel rebuild — hence the publish countdown).

## Testing an end-to-end client flow

Invite a spare email → Access: Contributor preset + one site → open the invite
link in a private window → set password (+ 2FA if required) → confirm they land
straight in their site, see only granted sections, and their save shows
"Sent for review" → back as owner: 🕓 Drafts badge → approve → countdown →
live. If that loop runs clean, the auth stack is healthy.
