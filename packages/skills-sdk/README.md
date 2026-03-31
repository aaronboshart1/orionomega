# @orionomega/skills-sdk

Skills system for OrionOmega — create, load, validate, configure, and execute custom agent skills.

This package has **zero external dependencies** and can be used standalone.

---

## What is a Skill?

A skill is a self-contained directory that adds tools and domain knowledge to workers:

```
my-skill/
├── manifest.json       # Metadata, tool definitions, triggers, settings schema
├── SKILL.md            # Agent-facing documentation (when/how to use this skill)
├── scripts/
│   └── handler.ts      # Tool handler: JSON stdin → JSON stdout
└── prompts/
    └── worker.md       # Optional worker system prompt override
```

See [`docs/skills-guide.md`](../../docs/skills-guide.md) for the complete authoring guide.

---

## Scaffold a New Skill

```bash
orionomega skill create my-skill
# or from Node.js:
import { scaffold } from '@orionomega/skills-sdk/scaffold';
await scaffold('my-skill', '/path/to/skills-dir');
```

---

## TypeScript-Native Skills (Class Mode)

Instead of shell scripts, you can implement a skill as a TypeScript class:

```ts
import { defineSkill, BaseSkill, type SkillContext } from '@orionomega/skills-sdk';

export default defineSkill(class WeatherSkill extends BaseSkill {
  async execute(toolName: string, params: Record<string, unknown>, ctx: SkillContext) {
    if (toolName === 'get_weather') {
      const { latitude, longitude } = params as { latitude: number; longitude: number };
      // ... fetch weather data ...
      return { temperature: 22, unit: 'C' };
    }
    throw new Error(`Unknown tool: ${toolName}`);
  }
});
```

Compile `skill.ts` → `skill.js` alongside `manifest.json`. The loader detects and prefers the class over handler scripts.

---

## Loading Skills

```ts
import { SkillLoader } from '@orionomega/skills-sdk';

const loader = new SkillLoader('/path/to/skills-dir');
const skills = await loader.load();

for (const skill of skills) {
  console.log(skill.manifest.name, skill.tools.map(t => t.name));
}
```

### Standalone functions

```ts
import { discoverSkills, loadSkillManifest, instantiateSkill } from '@orionomega/skills-sdk';

const dirs = await discoverSkills('/path/to/skills-dir');
const manifest = await loadSkillManifest(dirs[0]);
const skill = await instantiateSkill(dirs[0], manifest);
```

### Match skills by query

```ts
import { SkillLoader } from '@orionomega/skills-sdk';

const loader = new SkillLoader('/path/to/skills-dir');
await loader.load();
const matched = loader.matchSkills('search the web for prices');
// returns skills whose triggers.keywords match
```

---

## Executing Tools

```ts
import { SkillExecutor } from '@orionomega/skills-sdk';

const executor = new SkillExecutor();
const result = await executor.execute(skill, 'get_weather', { latitude: 41.8, longitude: -87.6 });
console.log(result.output); // JSON string from handler stdout
```

---

## Validation

```ts
import { validateManifest } from '@orionomega/skills-sdk';

const result = validateManifest(rawManifest);
if (!result.valid) {
  console.error(result.errors);
}
```

---

## Settings

Skills declare their configurable settings in `manifest.json`. The SDK provides helpers to resolve, validate, and persist settings:

```ts
import { getSettingsSchema, resolveSettings, validateSettings, maskSecrets, readSkillConfig, writeSkillConfig } from '@orionomega/skills-sdk';

const schema = getSettingsSchema(manifest);
const config = await readSkillConfig('my-skill');
const errors = validateSettings(config, schema);
const safe = maskSecrets(config, schema); // hide API key values in logs
```

---

## Key Exports

| Export | Description |
|--------|-------------|
| `SkillLoader` | Discovers, loads, and matches skills |
| `SkillExecutor` | Spawns handler scripts or calls class methods |
| `validateManifest` | Validates a manifest JSON against the schema |
| `ISkill` | Interface all class-mode skills must implement |
| `BaseSkill` | Abstract base class with default `health()` implementation |
| `defineSkill` | Helper that marks a class as a skill default export |
| `getSettingsSchema` | Extracts settings schema from a manifest |
| `resolveSettings` | Resolves settings from config + env vars |
| `validateSettings` | Validates setting values against schema constraints |
| `maskSecrets` | Redacts secret values for safe logging |
| `readSkillConfig` / `writeSkillConfig` | Persist skill config to `~/.orionomega/skills/<name>/config.json` |
| `isSkillReady` | Returns `true` if all required settings are configured |
| `scaffold` | Generate a new skill directory |
| `SkillManifest`, `SkillTool`, `SkillContext` | TypeScript types |

---

## Directory Layout

```
src/
├── loader.ts        # SkillLoader, discoverSkills, loadSkillManifest, instantiateSkill
├── executor.ts      # SkillExecutor — stdin/stdout handler invocation
├── validator.ts     # validateManifest
├── settings.ts      # getSettingsSchema, resolveSettings, validateSettings, maskSecrets
├── skill-config.ts  # readSkillConfig, writeSkillConfig, isSkillReady, listSkillConfigs
├── interfaces.ts    # ISkill, BaseSkill, defineSkill
├── scaffold.ts      # scaffold — new skill directory generator
└── types.ts         # SkillManifest, SkillTool, SkillConfig, etc.
```

---

## Development

```bash
pnpm --filter @orionomega/skills-sdk build
```
