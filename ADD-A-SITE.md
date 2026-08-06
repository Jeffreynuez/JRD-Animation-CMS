# Add a new website to the CMS

The CMS manages **many websites from one place**. This is the runbook for adding another one.

> **Where this lives.** The CMS itself is `Jeffreynuez/JRD-Animation-CMS`, deployed at
> **https://jrd-animation-cms.vercel.app/admin**. This runbook sits in the portfolio repo for
> historical reasons — it arguably belongs in the CMS repo now. Move it when convenient.

## The mental model (read this first)

- A "site" in the CMS is a **GitHub repo**, not a folder on your computer. The admin reads and
  writes each site's content **live over the GitHub Contents API**.
- Where the source lives on your Desktop is irrelevant. Build each project in its own folder or
  Cowork session.
- There is **one CMS**, standalone, at `https://jrd-animation-cms.vercel.app/admin`. Every site is
  edited through that same admin. New sites do **not** get their own `/admin`.
- The old `jrd-online-portfolio.vercel.app/admin` is **retired**. Don't recreate it, don't link to
  it, don't put env vars on that Vercel project expecting the CMS to read them.
- The registry of managed sites is **`data/sites.json` inside the CMS repo**
  (`Jeffreynuez/JRD-Animation-CMS`). The "+ Add a website" form in the site picker writes to it.
  Registry writes are live, so a newly added site is usable immediately with no redeploy.

## One-time prerequisite: token scope

The CMS's GitHub token is a fine-grained PAT (owner `Jeffreynuez`). To let the CMS read and write
another repo:

1. GitHub → Settings → Developer settings → Fine-grained tokens → edit the CMS token.
2. Under **Repository access**, add the new repo. Keep permission **Contents: Read and write**,
   nothing else.
3. Paste the token into the **Vercel project `jrd-animation-cms`** → Settings → Environment
   Variables → `GITHUB_TOKEN` (all environments), and **redeploy**.

That redeploy is not optional — Vercel bakes env vars in at deploy time, so a token updated without
a redeploy has no effect. If the token doesn't cover the repo, the Add form fails with
`Cannot access repo … (404)`.

## What a new repo must contain

For the **content manager** (forms) to work:

- `data/_schema.json` — the editable sections, blocks and fields. Copy `data/_schema.json` from
  this repo as a template and adapt it. Each section has a `file` (e.g. `home.json`); the editable
  file list is auto-detected from these.
- The `data/*.json` files the schema references.
- A build that renders `data/*.json` → HTML. Copy this repo's `scripts/build.js` pattern, plus
  `package.json` (`"build": "node scripts/build.js"`) and `vercel.json` (`cleanUrls: true`,
  `trailingSlash: false`, `outputDirectory: "."`).

For the **visual editor** (click-to-edit on the live page) to also work, `build.js` must stamp
`data-edit="<file>#<dot.path>"` on text leaves and `data-edit-item="<file>#<arraypath>#<idx>"` on
collection item roots, and `assets/js/main.js` must contain the `?edit=1`-gated editor IIFE. See
this repo as the reference. The content-manager drawer works from `_schema.json` alone even without
the stamping — so a site can ship editable and gain click-to-edit later.

## Steps to add a site

1. **Create the project.** Fastest start: copy this repo's `data/_schema.json` and
   `scripts/build.js` as templates, then replace the content.
2. **Push it to its own GitHub repo** and **deploy it on Vercel** so it has a live URL.
3. **Commit `data/_schema.json`** — the CMS reads it live from the default branch.
4. **Widen the CMS token** to that repo if needed (see above), and redeploy the CMS.
5. In the CMS site picker, click **+ Add a website**:
   - **Label** — display name.
   - **Site ID** — auto-slugged from the label; it's the stable key. Use the client slug.
   - **Repo** — `owner/name`.
   - **Branch** — usually `main`.
   - **Live URL** — the Vercel URL (drives the preview and the visual-editor iframe).
   - **Editable files** — leave blank to auto-detect from `data/_schema.json`, or list one per line.
6. Submit. The card appears immediately, and you can **Open / Edit / Delete** it from the picker.

### Registry entry shape

For reference, this is what the form writes into `data/sites.json`:

```json
{
  "id": "salee",
  "label": "Salee Starbuck",
  "repo": "Jeffreynuez/Saleestarbuck",
  "branch": "main",
  "liveUrl": "https://saleestarbuck.vercel.app",
  "schema": "_schema.json",
  "files": ["pages.json", "home.json", "posts.json", "testimonials.json",
            "review.json", "refer.json", "contact.json", "theme.json"]
}
```

## Giving the client access

The CMS has real user accounts — don't hand out a shared password.

- Invite the client by link from the **users & access** panel; they set their own password.
- Grant **only their site**, and only the sections they should touch. Permissions are enforced
  server-side, not hidden in the UI.
- Start clients on the **Editor** or **Contributor** preset. Contributors submit changes to the
  Drafts queue instead of publishing, which is the right default for a client who's never used a
  CMS — nothing goes live until you approve it.
- Turn on 2FA for anyone with publish rights.

## Media

Cloudinary routing is per-site, so each client's uploads land in their own folder. Set that up when
you register the site rather than after — moving assets later means rewriting every `CDN:` path in
`data/*.json`.

## Notes

- The CMS only works on the **deployed** URL. Opening `admin.html` from `file://` makes login fail.
- Editing or deleting a registered site is done from the picker. Delete only removes the registry
  entry — never the repo or the live site.
- After the CMS pushes via the Contents API, GitHub Desktop shows the repo as "behind" with
  uncommitted-looking diffs. **Discard + Pull — don't commit.** Committing over a CMS push is how
  you lose a client's content edits.
- Section IDs in the rendered HTML are load-bearing for both the nav and the visual editor, and
  must be unique per page.
