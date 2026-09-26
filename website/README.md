> **Upstream reference — not maintained for Managers.** This directory is Paddock's documentation site as of the fork (v0.74.1). It describes Paddock, uses Paddock's `PADDOCK_*` env names and is frozen: do not update it, build it or deploy it for Managers. See the repo-root `CLAUDE.md` for what the fork changed.

# Paddock documentation site

The [Astro](https://astro.build) + [Starlight](https://starlight.astro.build)
documentation site for Paddock, intended for **paddock.edspencer.net**.

Standalone package — not part of the root npm workspaces, so it never affects the
`packages/server` / `packages/web` build or CI.

## Develop

```bash
cd website
npm install
npm run dev                       # local dev server
npm run build && npm run preview  # build + preview (Mermaid renders in the build)
```

## Structure

- `src/content/docs/` — the documentation pages (`.md` / `.mdx`, Starlight frontmatter).
- `astro.config.mjs` — site config + the hand-maintained sidebar.
- `src/assets/`, `src/styles/` — logo and theme tweaks.

## Deploy

Built and served by **Cloudflare Pages** (root dir `website`, build
`npm install && npm run build`, output `website/dist`). See `website/CLAUDE.md`.
