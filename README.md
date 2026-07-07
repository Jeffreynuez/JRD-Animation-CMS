# JRD Animation CMS

A standalone, multi-site content management system. One admin UI manages many
static websites — each site is a GitHub repo, read and written live via the
GitHub Contents API. Deployed on Vercel at
**https://jrd-animation-cms.vercel.app/admin**.

This repo contains **only the CMS** — no website content of its own. The sites it
manages (the JRD portfolio, Proguild, and future clients) live in their own repos
and are registered in `data/sites.json`.

## Structure

```
admin.html          The CMS single-page app (login, site picker, content
                    manager drawer, visual editor bridge).
api/
  _lib.js           Shared helpers: registry loader, auth, GitHub fetch.
  load.js           GET  a site's data/<file>.json
  save.js           PUT  a site's data/<file>.json (commits to that repo)
  sign-upload.js    Signs Cloudinary uploads
  sites.js          GET/POST the site registry (add / edit / delete sites)
data/
  sites.json        The site registry (which repos this CMS manages)
index.html          Redirects / -> /admin
vercel.json         cleanUrls so /admin serves admin.html; /api/* are functions
```

No build step. Static files are served from the repo root and `api/*.js` run as
Vercel serverless functions (Node 18+). The only runtime dependencies are Node
built-ins (`crypto`) and global `fetch`.

## Environment variables (set in the Vercel project)

| Variable                 | Purpose                                                        |
|--------------------------|----------------------------------------------------------------|
| `GITHUB_TOKEN`           | Fine-grained PAT with Contents R/W on every managed repo **and this repo** (the registry lives here). |
| `GITHUB_REPO`            | Home repo where `data/sites.json` lives. Set to `Jeffreynuez/JRD-Animation-CMS`. |
| `GITHUB_BRANCH`          | Home repo branch. `main`.                                      |
| `ADMIN_PASSWORD`         | The admin login key (sent as the `x-admin-key` header).       |
| `CLOUDINARY_API_KEY`     | Cloudinary key for signed image uploads.                       |
| `CLOUDINARY_API_SECRET`  | Cloudinary secret. **Never commit this.**                     |

> Note: `api/sign-upload.js` currently returns a hardcoded `cloudName`. Per-site
> Cloudinary routing is a planned follow-up.

## Adding a website

Open `/admin`, sign in, and use **+ Add a website**: give it an id, label, repo
(`owner/name`), branch, and live URL. The CMS reads that repo's
`data/_schema.json` to discover its editable files. Then widen `GITHUB_TOKEN` to
include the new repo (Contents R/W).

Each managed repo needs: `data/_schema.json`, its `data/*.json` content files,
and a `scripts/build.js` that renders data -> HTML (plus a `?edit=1`-gated editor
in its `main.js` for the visual editor).
