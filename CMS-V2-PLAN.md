# JRD CMS v2 — From Admin Tool to Client-Ready Site Editor

*Planned 2026-08-02. Goal: clients edit their own sites confidently with zero
hand-holding; Jeffrey (owner) controls exactly what each client can touch.*

---

## Where we are

One shared password unlocks everything: every site, every section, publish
rights, user-invisible. Fine for one person; a non-starter for clients. The
editing UX itself is now strong (drag-and-drop uploads, live preview sync,
publish countdown, size caps, auto-optimization) — v2 is about **identity,
control, and trust**.

---

## Phase 1 — Accounts & sign-in

**Users.** Each person gets their own account: name, email, password
(bcrypt-hashed), role, and grants. Stored in a small store the serverless API
owns (options below). Sessions become signed JWTs in an httpOnly cookie —
replacing the x-admin-key header everywhere.

**Invite flow (the intuitive path).** The admin never types a client's
password. Admin adds a user by email → the CMS emails an invite link (via
Brevo, already in the stack) → client sets their own password on first visit →
lands directly in *their* site. Password reset = same mechanism.

**Two-factor authentication.** TOTP authenticator apps (Google Authenticator,
1Password, etc.) — an established library (otplib) plus QR enrollment. Backup
codes generated at setup. Optionally enforced per-user by the admin ("this
client handles a store — require 2FA").

**Login screen.** Real branded login (email + password + optional 2FA code)
replacing today's single password box. Rate-limited, lockout after repeated
failures, email notification on new-device login.

### The one big decision: build vs. buy

| | Roll our own (JWT + bcrypt + otplib + Brevo) | Supabase Auth / Clerk |
|---|---|---|
| Cost | $0 | Free tier, then paid |
| Fits the zero-infra stack | Perfectly | Adds a vendor + SDK |
| 2FA, resets, lockouts | We build each piece | Included, battle-tested |
| Security responsibility | Ours | Mostly theirs |
| Portfolio/demo value | High ("built the auth too") | Lower |

Recommendation: **roll our own** — the stack stays $0 and self-owned, Brevo
covers email, and the scope (a handful of clients, not thousands) is well
within what a careful hand-rolled JWT+TOTP setup handles. If the client count
ever grows past dozens, migrate to Supabase.

**Where users live.** Best fit: **Vercel KV or a users.json in a private
GitHub repo** (same pattern as everything else). users.json-in-git keeps the
architecture pure (one storage system) and gives free audit history of
permission changes; KV avoids hashes sitting in git. Decision needed.

---

## Phase 2 — Roles & permissions ("editorial power")

Three layers, each visible in a new **Users** tab (admin-only):

1. **Sites** — which sites a user can even see. A client sees only their own;
   the site picker disappears for single-site users.
2. **Sections** — per site, checkboxes matching the schema's section list
   (Gallery ✓, Products ✓, Theme ✗, Global ✗...). The schema is already the
   natural permission unit — sections a user lacks simply don't render in
   their sidebar, and the on-page editor ignores clicks into them.
3. **Capabilities** — toggles per user:
   - **Can publish** — off = their saves become a *pending draft* the admin
     reviews and publishes (one-click approve, with a diff-style summary).
   - **Can delete items** (vs. only add/edit)
   - **Can upload media** / per-user upload size ceiling
   - **Can edit theme/design tokens**
   - **Can manage users** (admin only, effectively)

Suggested roles as presets: **Owner** (everything, all sites), **Site Admin**
(everything on assigned sites), **Editor** (content + publish), **Contributor**
(content, no publish — drafts go to review). Presets fill the checkboxes;
admin can still fine-tune each user.

---

## Phase 3 — Trust & polish (what makes it sell)

- **Version history & rollback** — the git backbone already stores every
  publish. Surface it: a History panel per section ("Gallery — 14 versions"),
  each with who/when, one-click restore. This is the feature that makes
  clients fearless — nothing is ever truly broken.
- **Audit log** — "Maria replaced hero image, yesterday 3:12pm." Commits
  already carry this; just render it.
- **Autosave drafts** — work-in-progress survives a closed tab (localStorage
  first, server drafts once accounts exist).
- **Soft delete / undo** — deleted items go to a per-section trash for 30
  days instead of vanishing.
- **Media library** — a browser of everything already uploaded to the site's
  Cloudinary folder (search, pick, reuse) so clients stop re-uploading the
  same logo.
- **Drop-to-replace on the page itself** — drag an image file onto a tile in
  the live preview to replace it (bridge extension; drawer already does this).
- **Email notifications** — admin gets a Brevo email when a client publishes
  (or submits a draft for review).
- **White-label per client** — client's logo + accent color on their login
  and editor chrome; optionally a custom domain (edit.clientsite.com). Big
  Fiverr differentiator.
- **Guided first-run** — a 30-second overlay tour on first login: "click
  anything on the page to edit it → Manage content → Save & publish."
- **Mobile pass** — clients will open this on phones; the drawer needs it.

---

## Suggested build order

1. **Auth core** (accounts, JWT sessions, login screen, invite emails, reset) —
   everything else hangs off it.
2. **Permissions** (sites → sections → capabilities, Users tab, role presets).
3. **2FA + login hardening** (TOTP, backup codes, rate limits, lockouts).
4. **History/rollback + audit log** (highest trust-per-effort; git already has the data).
5. **Draft/approval flow** (unlocks the Contributor role).
6. **Media library, soft delete, autosave.**
7. **White-label + onboarding tour + mobile pass.**

Phases 1–3 make it *safe to sell*. Phase 4 makes clients *love* it.

---

## Open questions (decisions needed)

1. **Build vs. buy auth** — roll our own (recommended, $0, Brevo emails) or
   Supabase/Clerk (faster, vendor-dependent)?
2. **User store** — users.json in a private repo (pure git architecture,
   hashes in git) or Vercel KV (cleaner separation, one more moving part)?
3. **Default client role** — should clients publish directly (simpler, riskier)
   or default to draft-for-approval (you review everything until you trust them)?
4. **2FA policy** — optional per user, or enforced for everyone including you?
5. **Per-client pricing implication** — will white-label/custom-domain be a
   paid tier on your Fiverr gigs? (Affects how configurable branding must be.)
6. **Section permissions default** — new client user starts with *nothing*
   checked (explicit grants) or *content sections* checked (Theme/Global off)?
