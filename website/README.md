# Raya website

The documentation site and landing page for Raya, built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build).

## Run it

```bash
cd website
npm install
npm run dev        # http://localhost:4321
npm run build      # static site in website/dist
npm run preview    # serve the built site
```

## What's inside

| Path | What it is |
| --- | --- |
| `src/pages/index.astro` | Landing page |
| `src/components/landing/` | Landing sections: hero, live player demo, failover simulator, batching animation, features, code tabs |
| `src/scripts/player-demo.ts` | Simulated player that follows Raya's real queue rules |
| `src/scripts/failover-demo.ts` | Resume, failover and restart simulation |
| `src/content/docs/` | Documentation pages (Markdown/MDX); the sidebar is set in `astro.config.mjs` |
| `src/components/tools/` | Interactive docs tools: Config Builder, Filter Lab, Event Explorer |
| `src/data/events.ts` | Event catalog used by the Event Explorer and the events reference |
| `src/styles/theme.css` | Starlight brand colors and fonts |
| `src/styles/landing.css` | Landing page design tokens (dark and light) |
| `src/site.mjs` | Name, version and GitHub link, used everywhere |

## Before publishing

1. Set `github` in `src/site.mjs` to your repository URL.
2. When Raya's API changes, update the matching docs page. Also update the Filter Lab constants in `src/components/tools/FilterLab.astro` if filter presets change; they mirror `src/player/Filters.ts`.

## Deploy

The build output in `website/dist` is plain static files.

- **Vercel / Netlify / Cloudflare Pages**: root directory `website`, build command `npm run build`, output directory `dist`.
- **GitHub Pages (project site)**: build with the base path set so links work under `/<repo>/`:

  ```bash
  SITE_URL=https://<user>.github.io BASE_PATH=/raya npm run build
  ```

## Adding a docs page

1. Create `src/content/docs/guides/my-page.mdx` with a `title` and `description` in the frontmatter.
2. Add `'guides/my-page'` to the sidebar in `astro.config.mjs`.
3. Link between pages with relative links (`../other-page/`) so they work with any base path.
