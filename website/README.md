# Landing page

A single self-contained static page (`index.html` + `assets/`) — no build step, no
framework. Deliberately kept separate from the Next.js app in `src/` so it can be hosted
on its own domain/subdomain independently of the running product.

## Preview locally

```bash
open website/index.html
# or: npx serve website
```

## Deploy

Any static host works. A few options:

- **Vercel** — new project, set "Root Directory" to `website/`, framework preset "Other".
  No build command needed.
- **GitHub Pages** — Settings → Pages → Deploy from a branch → `main` / `/website`.
- **Netlify** — drag-and-drop the `website/` folder, or point a site at this repo with
  the base directory set to `website/`.

## Before you publish

- The "Sponsor on GitHub" button links to `https://github.com/sponsors/hunterZh37` — that
  only resolves once GitHub Sponsors is actually enabled on the account (Settings →
  Sponsorships). Swap it for a different donation link if you'd rather use Ko-fi/Patreon/etc.
- `assets/demo.gif` is a copy of [`docs/media/demo.gif`](../docs/media/demo.gif); regenerate
  both together if you re-record the demo.
