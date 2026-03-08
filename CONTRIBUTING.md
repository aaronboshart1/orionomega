# Contributing to OrionOmega

Thank you for your interest in contributing! OrionOmega is an npm workspaces monorepo — this guide will get you set up quickly and explain how we work.

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md). We expect all contributors to treat each other with respect.

## How to Contribute

### Reporting Bugs

1. **Search existing issues** first — your bug may already be reported.
2. Open a [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md) issue with a clear title and reproduction steps.
3. Include your OS, Node.js version, and OrionOmega version (`orionomega --version`).

### Requesting Features

1. Check the [backlog](https://github.com/aaronboshart1/orionomega/issues?q=is%3Aissue+label%3Aenhancement) for similar requests.
2. Open a [Feature Request](.github/ISSUE_TEMPLATE/feature_request.md) issue describing the problem it solves.

### Submitting Pull Requests

1. Fork the repository and create a branch from `main`.
2. Name your branch: `fix/short-description` or `feat/short-description`.
3. Follow the [development setup](#development-setup) below.
4. Write or update tests for your change (see [Testing](#testing)).
5. Ensure all checks pass (`pnpm typecheck && pnpm lint && pnpm test`).
6. Open a PR against `main` using the [PR template](.github/PULL_REQUEST_TEMPLATE.md).

## Development Setup

### Prerequisites

- Node.js >= 22
- pnpm >= 9 (`npm install -g pnpm`)
- TypeScript knowledge (all packages are written in TypeScript)

### First-Time Setup

```bash
git clone https://github.com/aaronboshart1/orionomega.git
cd orionomega
pnpm install
pnpm build
```

### Workspace Structure

```
orionomega/
├── packages/
│   ├── core/         # Orchestration engine, Anthropic client, CLI
│   ├── gateway/      # WebSocket + REST server
│   ├── hindsight/    # Temporal knowledge graph client
│   ├── skills-sdk/   # Skill loader, validator, executor, scaffolding
│   ├── tui/          # Terminal UI (pi-tui)
│   └── web/          # Next.js dashboard
├── docs/             # Architecture and user guides
├── test/             # Integration test artifacts
└── scripts/          # install.sh and tooling scripts
```

Each package has its own `tsconfig.json` and `package.json`. Packages reference each other via `workspace:*` protocol.

### Common Commands

```bash
# Build everything (in dependency order)
pnpm build

# Type-check all packages
pnpm typecheck

# Lint (ESLint with TypeScript rules)
pnpm lint

# Run tests
pnpm test

# Clean all build artifacts
pnpm clean

# Work on a single package
cd packages/skills-sdk
pnpm build
pnpm test
```

## Code Style

- **TypeScript strict mode** — no implicit `any`, all types must be explicit.
- **ESM modules** — use `.js` extensions in imports (TypeScript resolves to `.ts`).
- **Comments**: explain _why_, not _what_. Code should be self-documenting.
- **No unnecessary dependencies** — add a dependency only if it genuinely can't be avoided.
- **Error messages** — be specific. "Failed to load skill 'foo': manifest.json not found" beats "load error".
- **Logging** — use the package's logger, not `console.log` in production paths.

## Commit Conventions

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

[optional body]
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `style`, `ci`

Examples:
```
feat(skills-sdk): add support for preLoad hooks
fix(gateway): handle WebSocket reconnect on port conflict
docs: update architecture diagram
```

Reference Linear issues in the commit body when applicable: `(AAR-42)`

## Testing

Tests live alongside source files as `*.test.ts`. We use [Vitest](https://vitest.dev/) — fast, ESM-native, and TypeScript-first.

```bash
# Run all tests
pnpm test

# Run tests for one package
cd packages/skills-sdk && pnpm test

# Watch mode
cd packages/core && pnpm vitest --watch
```

Write tests for:
- All new public functions and classes
- Bug fixes (add a regression test first)
- Edge cases explicitly called out in PR descriptions

## Architecture Notes

Before diving into `packages/core`, read [`docs/architecture.md`](docs/architecture.md). Key concepts:

- **The main agent never does work** — it only plans
- **DAG execution** — Kahn topological sort drives parallel worker dispatch
- **Skills system** — `packages/skills-sdk` handles discovery, validation, and execution
- **Hindsight** — optional but important for memory; the client is in `packages/hindsight`

## Security

If you discover a security vulnerability, please follow our [Security Policy](SECURITY.md) — **do not open a public issue**.

## License

By submitting a pull request, you agree that your contribution will be licensed under the [MIT License](LICENSE).
