---
name: Replit gateway/web shared config + bind
description: Why the gateway and web must share one config.yaml via CONFIG_PATH on Replit, and why the gateway must bind 0.0.0.0.
---

# Gateway/web shared config on Replit

On Replit the data dir is resolved relative to `process.cwd()`. The gateway and web run via `pnpm --filter`, which sets each script's cwd to its own package dir (`packages/gateway`, `packages/web`). So without an override they read **different** `<cwd>/.orionomega/config.yaml` files.

**Why it matters:** once gateway auth defaults to `api-key`, the gateway auto-generates a `keyHash` into *its* config file, but the web proxy reads a *different* file and finds no keyHash → it injects no token → every authenticated REST/WS call fails and the whole UI breaks.

**How to apply:** pin both processes to one file. Both dev workflows set `CONFIG_PATH="$PWD/.orionomega/config.yaml"` (the workflow shell launches from the workspace root, so `$PWD` is stable before pnpm cd's). The `[deployment]` run command in `.replit` does NOT yet do this — production has the same divergence risk and is owned by the deployment skill.

# Gateway must bind 0.0.0.0 on Replit

The Replit workflow port-health probe cannot detect a `127.0.0.1`-only bind, so it reports `DIDNT_OPEN_A_PORT` and kills the gateway after ~120s even though it is listening fine.

**How to apply:** set `gateway.bind: [0.0.0.0]` in config.yaml. This is safe specifically because auth is `api-key` — `assertSecureBind` only refuses a non-localhost bind when `auth.mode: 'none'` (overridable via `ORIONOMEGA_ALLOW_INSECURE_BIND=1`).
