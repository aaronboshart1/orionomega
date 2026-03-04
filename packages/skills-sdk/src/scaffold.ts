/**
 * @module scaffold
 * Template generator for new OrionOmega skills.
 * Creates a complete skill directory structure with manifest, docs, and scripts.
 */

import { mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';

/**
 * Scaffold a new skill directory with all required files.
 *
 * Creates the following structure:
 * ```
 * {name}/
 * ├── manifest.json
 * ├── SKILL.md
 * ├── scripts/
 * │   └── run.sh
 * └── tests/
 *     └── test.sh
 * ```
 *
 * @param name - The skill slug name (used as directory name and manifest name).
 * @param targetDir - Parent directory where the skill directory will be created.
 */
export async function scaffoldSkill(name: string, targetDir: string): Promise<void> {
  const skillDir = path.join(targetDir, name);
  const scriptsDir = path.join(skillDir, 'scripts');
  const testsDir = path.join(skillDir, 'tests');

  // Create directories
  await mkdir(scriptsDir, { recursive: true });
  await mkdir(testsDir, { recursive: true });

  // --- manifest.json ---
  const manifest = {
    name,
    version: '0.1.0',
    description: `TODO: Describe what the ${name} skill does`,
    author: 'TODO: Your Name',
    license: 'MIT',
    orionomega: '>=0.1.0',
    requires: {
      commands: [],
      skills: [],
      env: [],
    },
    tools: [
      {
        name: `${name}-run`,
        description: `Execute the ${name} skill`,
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Input value' },
          },
        },
        handler: 'scripts/run.sh',
        timeout: 30000,
      },
    ],
    triggers: {
      keywords: [name],
      patterns: [],
      commands: [`/${name}`],
    },
  };

  await writeFile(
    path.join(skillDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8',
  );

  // --- SKILL.md ---
  const skillDoc = `# ${name}

> TODO: Brief description of the skill.

## Prerequisites

- List any required CLI tools or services here.

## Available Tools

### \`${name}-run\`

Execute the ${name} skill with the given input.

**Parameters:**
| Name  | Type   | Required | Description |
|-------|--------|----------|-------------|
| input | string | no       | Input value |

## Usage Patterns

\`\`\`
/${name} <input>
\`\`\`

## Notes

- Add any caveats, tips, or configuration notes here.
`;

  await writeFile(path.join(skillDir, 'SKILL.md'), skillDoc, 'utf-8');

  // --- scripts/run.sh ---
  const runScript = `#!/usr/bin/env bash
# Handler for ${name}-run tool
# Reads JSON from stdin, returns JSON on stdout

set -euo pipefail

INPUT=$(cat)

echo "{ \\"success\\": true, \\"input\\": $INPUT }"
`;

  const runPath = path.join(scriptsDir, 'run.sh');
  await writeFile(runPath, runScript, 'utf-8');
  await chmod(runPath, 0o755);

  // --- tests/test.sh ---
  const testScript = `#!/usr/bin/env bash
# Basic smoke test for ${name} skill
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"

echo '{"input":"hello"}' | "\${SCRIPT_DIR}/scripts/run.sh" > /dev/null 2>&1

if [ $? -eq 0 ]; then
  echo "PASS: run.sh executed successfully"
  exit 0
else
  echo "FAIL: run.sh returned non-zero"
  exit 1
fi
`;

  const testPath = path.join(testsDir, 'test.sh');
  await writeFile(testPath, testScript, 'utf-8');
  await chmod(testPath, 0o755);
}
