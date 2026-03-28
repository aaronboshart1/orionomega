# Skills SDK Architecture

## Overview

The Skills SDK (`@orionomega/skills-sdk`) provides a complete lifecycle management system for OrionOmega skills. It handles skill discovery, manifest validation, settings resolution, handler execution, and configuration persistence.

## Modules

| Module | Purpose |
|--------|---------|
| `types.ts` | All TypeScript type definitions, enums, and interfaces |
| `interfaces.ts` | `ISkill` interface and `BaseSkill` abstract class |
| `settings.ts` | Settings schema extraction, resolution, validation, and secret masking |
| `loader.ts` | Skill discovery, manifest loading, dependency checking, and `ISkill` instantiation |
| `executor.ts` | Spawns handler scripts with stdin/stdout JSON communication |
| `validator.ts` | Structural and semantic manifest validation |
| `scaffold.ts` | Creates new skill directories from a built-in template |
| `skill-config.ts` | Reads and writes persisted skill configuration files |
| `index.ts` | Public API barrel export |

## Dual-Mode Loading

Skills can be implemented in two ways:

### Manifest Mode (Language-Agnostic)
Any directory with a `manifest.json` is a valid skill. Tools are executed by spawning the handler scripts listed in the manifest. This supports Bash, Python, Node.js, Go, and any language that can read stdin JSON and write stdout JSON.

### Class Mode (TypeScript-Native)
If a compiled `skill.js` exists alongside `manifest.json`, the loader imports it and uses the exported default class (which must extend `BaseSkill`) as the `ISkill` implementation. This provides typed lifecycle hooks, direct tool registration, and in-process execution.

## Settings System

The settings system provides:

1. **Schema extraction** — `getSettingsSchema()` reads the `settings` block from a manifest, or shims a legacy `setup.fields` array
2. **Resolution** — `resolveSettings()` merges manifest defaults with user-saved config
3. **Validation** — `validateSettings()` checks types, constraints, and required fields
4. **Secret masking** — `maskSecrets()` redacts password fields in API responses
5. **Secret splitting** — `splitSecrets()` separates config from secrets for secure injection

## Lifecycle

```
discoverAll() → load() → loadISkill() → initialize(ctx) → activate() → [tool calls] → deactivate() → dispose()
```
