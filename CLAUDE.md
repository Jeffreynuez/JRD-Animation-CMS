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
(sign-upload.js ?list=1, Cloudinary Admin API); version history + restore
(load.js ?history=1, git commits per data file); focal point picker (stores a
`#fp=x,y` suffix on the media value — build.js strips it from URLs and emits
object-position; admin cdn()/cloudParts strip it too); alt-text nudges;
first-visit tour (localStorage jrd-tour-done); scheduled publishing
(draft.publishAt + drafts.js ?cron=1, fired by the vercel.json daily cron with
CRON_SECRET *and* opportunistic pokes from the admin every 5 min).
GC-Windsor build.js chains stored crop transforms BEFORE the delivery
transform (order matters: crop coords are in original pixels).

**Not configured yet:** `CRON_SECRET` (any random string - Vercel then
authenticates the daily cron; without it only the in-editor pokes fire
scheduled publishes).

**Brevo email is configured but was being BLOCKED (checked 2026-09-14).**
`BREVO_API_KEY` and `MAIL_FROM_EMAIL` ARE set on the Vercel project, and
jrdanimation.com is authenticated in the Brevo account `jeffrey@jrdanimation.com`.
Invites were still falling back to the clipboard because **Brevo blocks API calls
from unrecognised IPs**: it auto-authorises IPs for a key's first 30 days, then
turns blocking on, and Vercel functions egress from a dynamic IP range (a fixed
outbound IP is Pro-only, $100/mo per project), so every new Vercel IP gets
blocked and emails Jeffrey a "Verify a new IP" notice. Cure: Brevo > Settings >
Security > Authorized IPs > "Blocking unauthorized IP addresses" > API keys row >
Deactivate for API. Authorising single IPs does not hold.

**Do not trust the "Email not configured" alert to mean the env vars are
missing.** `sendMail()` in `_auth.js` returns false both when the vars are empty
(no network call at all) and when Brevo returns >= 300, and `users.js` shows the
same message for both. If a Brevo notification email exists for the same minute,
the vars are set and the send was rejected. Worth splitting into two messages.

**Next planned (see CMS-V2-PLAN.md):** Phase 4 = version history / one-click
rollback + audit log mined from the git commits every publish already creates.
Then media library, soft delete, autosave, white-label, onboarding tour,
mobile pass. Also open: per-user "sites at a glance" in the users list,
"last active" column, retiring the legacy `ADMIN_PASSWORD` path once accounts
are fully adopted, and adding the `item-remove` bridge handler to Proguild and
the JRD portfolio `main.js` (only GC-Windsor has it — live delete sync does
nothing on the other sites until then).

Site picker (2026-09-14): the picker box is a flex column with a fixed head
(title, search, sort, density), a scrolling `#sitelist` and a fixed footer, so
a long registry scrolls instead of running off screen. Search matches label,
id, group, repo and URL (all terms must hit). Sort is Group / A to Z /
Recently opened; ☆ pins float to the top under a "Pinned" heading. Density
toggles preview cards ⇄ a compact one-line list. Preview iframes are created
lazily by an IntersectionObserver rooted on `#sitelist`, and not at all in
compact mode or under 560px wide, so a long list no longer opens a dozen live
sites at once. Sort, density, pins and last-opened times live in localStorage
(`jrd-pick-*`) — per browser, no server round trip, no new api/ file. The one
shared piece is a `group` string per site, carried in `data/sites.json` and
whitelisted in `full()` in api/sites.js (fields not in `full()` are dropped
on every write, so anything new must be added there too).

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

- **Vercel Hobby caps deployments at 12 serverless functions**, and api/ is
  at exactly 12 (underscore files are not functions). NEVER add a new api/
  file - fold new server behavior into an existing endpoint as a query-mode
  (media library lives in sign-upload.js ?list=1, version history in load.js
  ?history=1/?at=, the scheduled-publish sweep in drafts.js ?cron=1, the
  source-code export in sites.js ?download=<siteId>).

- **`ADMIN_URL` must be the editor's own origin** (`https://edit.jrdanimation.com/admin`).
  Invite and reset links are built from it server-side, so a wrong value mails a
  dead link and the CMS looks fine from the inside. It was once set to the
  marketing site, which 404s, and a client's invite bounced off it. `admin.html`
  now compares every returned link's host against `location.host`, corrects the
  clipboard copy, and warns the admin. That guard is client-side ON PURPOSE:
  `api/auth/reset.js` is public, so building links from the request Host header
  would let anyone point a password-reset link at a host of their choosing.
  Changing the env var in Vercel needs a redeploy before functions see it.
- **Sign in with Google** (`GOOGLE_CLIENT_ID`): Google Identity Services hands
  the browser an ID token; `verifyGoogleToken` in `_auth.js` checks it with Node
  `crypto` alone (RS256 against Google's JWKS, cached 1h and refetched once on an
  unknown kid, then issuer, `aud` against our own client id, expiry,
  `email_verified`). No npm package, no client secret, no callback endpoint,
  which matters because api/ is full. `login.js ?google=config` tells the gate
  whether to show the button; `?google=1` signs in.
  Two rules hold the security: it only signs in an email that ALREADY exists in
  users.json (never creates an account, since everyone has a Google account),
  and it does not skip 2FA. First Google sign-in flips an `invited` user to
  `active`, so a client can be onboarded with no password and no emailed link,
  which is the durable fix for the invite-link fragility above. Checking `aud` is
  the load-bearing step: without it a token another site minted for its own users
  would be accepted here.
- **Where the Google OAuth client lives**: Google Cloud project `jrd-site-editor`,
  inside the **jrdanimation.com** organization (a Workspace), admin
  `jeffrey@jrdanimation.com`. Not a personal Gmail, deliberately: the client id is
  business infrastructure and a client-facing consent screen. To change the
  authorized JavaScript origin (a new editor domain, a staging host) go to that
  project, APIs & Services / Google Auth Platform, Clients, the "CMS editor" Web
  application entry. The origin is the bare `https://edit.jrdanimation.com`, no
  trailing slash and no path; a trailing slash silently breaks sign-in. There are
  no redirect URIs and no client secret, because this is the ID-token flow rather
  than a redirect flow. The consent screen is **External and published**, and must
  stay that way: Internal restricts sign-in to jrdanimation.com accounts, which
  would lock out every client, since they sign in from their own domains (Tom is
  on Inca's Workspace). Published also matters on its own, since Testing mode caps
  you at hand-added users and expires their sessions after 7 days.
- **The editor bridge protocol**, spoken by every managed site's
  `assets/js/main.js` and duplicated per site, so a bridge change is five repos
  (Inca, JRD Online Portfolio, GC Windsor, Salee Starbuck, Proguild):
  page to editor `ready` (on load), `select`, `text` (typing on the page),
  `deselect`, `mapstate`; editor to page `apply` (+ `force`), `theme`,
  `styleapply`, `item-*`, `media-apply`. Unknown messages are ignored, so a
  site with a simpler bridge is safe to send everything to.
- **`apply` has a guard, and `force` is how you override it.** The guard skips
  the element the caret is genuinely in, so an incoming update never fights a
  typist. It originally tested only `el === selEl && el.isContentEditable`,
  which silently dropped EVERY side-panel edit, because clicking an element to
  open its panel is exactly what makes it selected and contentEditable. It now
  also requires `document.hasFocus()` and `document.activeElement === el`, which
  are false while the user types in the parent's panel. `repaintPreview()` sends
  `force: true` because a resync is authoritative, not an incidental echo.
- **The preview iframe always loads the PUBLISHED page**, so a draft or an
  unsaved edit is invisible in it until something calls vApply. That made a
  saved draft look lost: switch page, come back, and the panel showed the new
  words while the page showed the old. `repaintPreview()` walks the schema and
  pushes every dirty-or-draft file's values into the frame; it runs on the
  frame's `ready` message (which the CMS used to ignore), after a section
  renders, and when `ensureFile` loads a draft. It repaints theme and
  `styles.json` the same way, since they had the identical gap.
- **The toolbar is capacity-limited.** It was 21 controls in one non-wrapping
  row and clipped rather than adapted, and `.devtoggle` has `overflow:hidden`
  so a squeezed control hides its own label silently instead of overflowing
  visibly. Rare actions (2FA, Drafts, Users, Schedule, Quick tour, Sign out and
  the identity label) now live in `#moreMenu`; the real elements were MOVED
  there rather than rebuilt, so their conditional visibility still works
  untouched. `header>*{flex-shrink:0}` stops silent clipping, labels drop in
  tiers (`.lbl2` first, `.lbl` later), and `#msg` is weighted to win the
  leftover space so status text stays readable. Adding a control means
  re-checking the fit at 1280 and 1440.
- **Autosave is a per-person browser preference** (`jrd-autosave` in
  localStorage, default on), toggled in the More menu. It gates the 30 s loop
  but NOT the scheduled-publish poke. When it is off and files are dirty the
  Save button goes amber, because "off" should never be discovered by losing
  work.
- **History** on the toolbar covers the page you are on. The schema has no
  page-to-file mapping, so `pageFiles()` fetches the previewed page and reads
  its `data-edit` file names; every managed site sends
  `Access-Control-Allow-Origin: *`, which is what makes that possible. Falls
  back to the registry's file list.
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
- `canPublish`, `canTheme` and `canDownload` are **opt-in** caps (default
  false), listed in `OPT_IN_CAPS`;
  `canUpload` and `canDelete` are **default-on** (false only when explicitly
  set). `can()` in `_auth.js` is the single source of truth, and `OPT_IN_CAPS`
  in `admin.html` mirrors it. Change one and you must change the other. A new
  cap MUST be added to `OPT_IN_CAPS`: `can()` treats anything unlisted as on,
  so a cap you forget switches itself on for every existing account the moment
  it deploys.
- **Site download** (`canDownload`): puts a Download button beside Delete on
  the picker so a client can pull their own site's source. `sites.js
  ?download=<id>` checks `siteAllowed` then `canDownload`, then asks GitHub for
  `/repos/:repo/zipball/:branch` with `redirect: 'manual'` and returns the
  signed `codeload.github.com` URL from the `Location` header. It deliberately
  does NOT stream the zip: that would hit the 4.5 MB serverless response cap
  and the 10 s execution limit. `gh()` in `_lib.js` returns `headers` so the
  redirect can be read. Role presets all leave `canDownload: false`, so
  granting an export is always an explicit tick, never inherited from a role.
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
- **A headers-only change to a client site does not reach browsers that already
  cached it.** Changing `vercel.json` headers (frame-ancestors, CSP, anything)
  ships byte-identical HTML, so the ETag does not change; browsers revalidate,
  get a 304, and a 304 does not resend headers, so the OLD headers stay cached
  indefinitely. Chrome partitions that cache by top-level site, so the same site
  can be blocked under edit.jrdanimation.com while working under
  jrd-animation-cms.vercel.app - which is exactly how the 2026-09-14 "refused to
  connect" looked. Neither a hard reload nor `fetch(url,{cache:'reload'})` clears
  it; a frame navigation reads a cache entry those do not touch. The only cure is
  a different URL, which is why `loadFrame()` appends `_cb=` and the picker
  thumbnails append a per-session `CB_SESSION`. Every site's bridge tests
  `/[?&]edit=1/`, so the extra param is safe. Do not remove it.
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
