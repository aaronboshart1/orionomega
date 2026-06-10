---
name: Vitest JSX under rolldown-vite (Vite 8)
description: How to get .tsx component tests to transform when the project uses Vite 8 / rolldown-vite + tsconfig jsx:preserve
---

# Vitest JSX transform under rolldown-vite (Vite 8)

When a package runs on **Vite 8 (rolldown-vite)** and its `tsconfig.json` sets
`jsx: "preserve"` (Next.js default), vitest fails to transform `.tsx` test files
with: `Failed to parse source for import analysis ... make sure to not set jsx to
preserve`. The JSX reaches `vite:import-analysis` untransformed.

**Rule:** use `@vitejs/plugin-react-oxc` in the vitest config's `plugins`, NOT
`@vitejs/plugin-react`.

**Why:**
- rolldown-vite transforms via **Oxc**, which reads `tsconfig.json` and honours
  `jsx: "preserve"` → JSX left intact.
- The standard `@vitejs/plugin-react@4.x` has peer `vite@^4||5||6||7` — it does
  **not** support Vite 8, won't hook into the rolldown pipeline, and does not fix it.
- Setting `esbuild: { jsx: 'automatic' }` in the vitest config does NOT work either,
  because rolldown uses Oxc, not esbuild, for the transform.
- `@vitejs/plugin-react-oxc` prints a deprecation warning ("use @vitejs/plugin-react
  instead") but **works correctly** with Vite 8 today; the consolidated
  plugin-react that supersedes it isn't installable against Vite 8 in this lockfile.

**How to apply:** in `packages/web/vitest.config.ts`, `import react from
'@vitejs/plugin-react-oxc'` and add `plugins: [react()]`. Keep `.tsx` tests as
normal JSX. `.ts` (non-JSX) tests transform fine without it.
