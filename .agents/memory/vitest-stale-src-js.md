---
name: Stale compiled .js in src shadows .ts under vitest
description: Why brand-new exports read as "not a constructor" / undefined in core (and any tsc rootDir=src package) tests
---

In the monorepo's TS packages (e.g. `packages/core`), vitest resolves
`import ... from '../foo.js'` to a real `foo.js` sitting next to `foo.ts` **if one
exists**, instead of falling through to `foo.ts`. Those `.js` files are gitignored
build artifacts that can be left behind in `src/` by an earlier/misconfigured
`tsc` run (the correct build has `outDir: dist`, so a clean build never writes
them).

**Symptom:** after adding new exports, every test file fails to load and new
classes read as `X is not a constructor` / new functions are `undefined`, while
the package builds fine with `tsc`. The tests are silently running against the
*stale* compiled `.js`, which predates your edits.

**Fix:** delete the stale artifacts so resolution falls through to the `.ts`
sources: `rm -f packages/<pkg>/src/*.js src/*.js.map src/*.d.ts`. Confirm they're
ignored first with `git check-ignore`. A proper `tsc` (outDir=dist) will not
recreate them.

**Why:** vite/vitest's `.js`→`.ts` extension resolution only kicks in when the
literal `.js` file is absent.

**How to apply:** if new exports are mysteriously missing in vitest but `tsc`
passes, check for `src/*.js` shadow files before touching the source.
