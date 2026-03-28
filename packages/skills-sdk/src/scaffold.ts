/**
 * @module scaffold
 * Creates a new skill directory pre-populated from the built-in template.
 *
 * The generated skill includes a minimal `manifest.json`, a stub handler
 * script, and a `SKILL.md` documentation template — ready to be extended
 * by the skill author.
 */

import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';

export interface ScaffoldOptions {
  name: string;
  description: string;
  author: string;
  version?: string;
  license?: string;
}

export interface ScaffoldResult {
  success: boolean;
  dir: string;
  errors: string[];
}

export function scaffoldSkill(
  skillsDirOrName: string,
  optionsOrDir: ScaffoldOptions | string,
): ScaffoldResult {
  let skillsDir: string;
  let name: string;
  let description: string;
  let author: string;
  let version: string;
  let license: string;

  if (typeof optionsOrDir === 'string') {
    name = skillsDirOrName;
    skillsDir = optionsOrDir;
    description = `${name} skill`;
    author = 'OrionOmega';
    version = '0.1.0';
    license = 'MIT';
  } else {
    skillsDir = skillsDirOrName;
    ({ name, description, author, version = '0.1.0', license = 'MIT' } = optionsOrDir);
  }

  const skillDir = path.resolve(path.join(skillsDir, name));
  const errors: string[] = [];

  if (existsSync(skillDir)) {
    return {
      success: false,
      dir: skillDir,
      errors: [`Skill directory "${skillDir}" already exists. Delete it first to re-scaffold.`],
    };
  }

  try {
    mkdirSync(path.join(skillDir, 'handlers'), { recursive: true });

    const manifest = {
      name,
      version,
      description,
      author,
      license,
      orionomega: '>=0.1.0',
      requires: {
        commands: [] as string[],
        skills: [] as string[],
        env: [] as string[],
      },
      triggers: {
        keywords: [name],
        commands: [`/${name}`],
      },
      tools: [
        {
          name: `${name.replace(/-/g, '_')}_example`,
          description: `Example tool for the ${name} skill. Replace with your own implementation.`,
          handler: 'handlers/example.js',
          timeout: 30_000,
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Input query for this tool',
              },
            },
            required: ['query'],
          },
        },
      ],
    };

    writeFileSync(
      path.join(skillDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );

    const skillMd = `# ${name}

${description}

## Tools

### ${name.replace(/-/g, '_')}_example

Example tool — replace with a description of what this tool does.

**Parameters**

| Name    | Type   | Required | Description          |
|---------|--------|----------|----------------------|
| \`query\` | string | yes      | Input query for this tool |

**Returns**

\`\`\`json
{ "result": "..." }
\`\`\`

## Examples

- "${name} example query"
- "Use ${name} to …"
`;

    writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd, 'utf-8');

    const handlerJs = `#!/usr/bin/env node
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    const { query } = input;

    if (!query) {
      process.stderr.write('Missing required parameter: query\\n');
      process.exitCode = 1;
      return;
    }

    const result = { result: \`${name} received: \${query}\` };
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    process.stderr.write(\`Error: \${err instanceof Error ? err.message : String(err)}\\n\`);
    process.exitCode = 1;
  }
});
`;

    const handlerFile = path.join(skillDir, 'handlers', 'example.js');
    writeFileSync(handlerFile, handlerJs, 'utf-8');
    chmodSync(handlerFile, 0o755);

    return { success: true, dir: skillDir, errors };
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return { success: false, dir: skillDir, errors };
  }
}
