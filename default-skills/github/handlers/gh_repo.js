#!/usr/bin/env node
/**
 * GitHub Repository handler — list, view, clone, create, fork, archive, delete, rename.
 */
import { gh, readParams, respond, fail, limitFlag } from './lib.js';

const REPO_VIEW_FIELDS = [
  'name', 'nameWithOwner', 'description', 'url', 'homepageUrl',
  'defaultBranchRef', 'isPrivate', 'isFork', 'isArchived',
  'stargazerCount', 'forkCount', 'diskUsage',
  'primaryLanguage', 'languages', 'licenseInfo',
  'createdAt', 'updatedAt', 'pushedAt',
];

const REPO_LIST_FIELDS = [
  'nameWithOwner', 'description', 'isPrivate', 'isFork', 'isArchived',
  'stargazerCount', 'primaryLanguage', 'updatedAt', 'url',
];

async function main() {
  const p = await readParams();
  if (!p.action) fail('action is required');

  switch (p.action) {
    case 'list': {
      const args = ['repo', 'list', ...limitFlag(p.limit)];
      if (p.language) args.push('--language', p.language);
      if (p.topic) args.push('--topic', p.topic);
      const res = gh(args, { json: true, jsonFields: REPO_LIST_FIELDS });
      return respond(res.ok ? { result: formatRepoList(res.data) } : { error: res.error });
    }

    case 'view': {
      if (!p.repo) fail('repo is required for view');
      const res = gh(['repo', 'view', p.repo], { json: true, jsonFields: REPO_VIEW_FIELDS });
      return respond(res.ok ? { result: formatRepo(res.data) } : { error: res.error });
    }

    case 'clone': {
      if (!p.repo) fail('repo is required for clone');
      const res = gh(['repo', 'clone', p.repo]);
      return respond(res.ok ? { result: `Repository ${p.repo} cloned.` } : { error: res.error });
    }

    case 'create': {
      if (!p.name) fail('name is required for create');
      const args = ['repo', 'create', p.name];
      if (p.description) args.push('--description', p.description);
      if (p.private) args.push('--private');
      else args.push('--public');
      args.push('--confirm');
      const res = gh(args);
      return respond(res.ok
        ? { result: `Repository ${p.name} created.${res.text ? '\n' + res.text : ''}` }
        : { error: res.error });
    }

    case 'fork': {
      if (!p.repo) fail('repo is required for fork');
      const args = ['repo', 'fork', p.repo, '--clone=false'];
      const res = gh(args);
      return respond(res.ok ? { result: `Repository ${p.repo} forked.${res.text ? '\n' + res.text : ''}` } : { error: res.error });
    }

    case 'archive': {
      if (!p.repo) fail('repo is required for archive');
      const res = gh(['repo', 'archive', p.repo, '--yes']);
      return respond(res.ok ? { result: `Repository ${p.repo} archived.` } : { error: res.error });
    }

    case 'delete': {
      if (!p.repo) fail('repo is required for delete');
      const res = gh(['repo', 'delete', p.repo, '--yes']);
      return respond(res.ok ? { result: `Repository ${p.repo} deleted.` } : { error: res.error });
    }

    case 'rename': {
      if (!p.repo) fail('repo is required for rename');
      if (!p.name) fail('name is required for rename');
      const res = gh(['repo', 'rename', p.name, '--repo', p.repo, '--yes']);
      return respond(res.ok ? { result: `Repository renamed to ${p.name}.` } : { error: res.error });
    }

    default:
      fail(`Unknown action: ${p.action}. Valid: list, view, clone, create, fork, archive, delete, rename`);
  }
}

function formatRepoList(data) {
  if (!Array.isArray(data) || data.length === 0) return 'No repositories found.';
  return data.map(r =>
    `${r.nameWithOwner}${r.isPrivate ? ' 🔒' : ''}${r.isArchived ? ' 📦' : ''}${r.isFork ? ' 🍴' : ''}` +
    ` ⭐${r.stargazerCount}` +
    (r.primaryLanguage ? ` [${r.primaryLanguage.name}]` : '') +
    (r.description ? `\n  ${r.description}` : '') +
    `\n  ${r.url}`
  ).join('\n');
}

function formatRepo(data) {
  if (!data) return 'Repository not found.';
  const lines = [
    `# ${data.nameWithOwner}`,
    data.description ?? '(no description)',
    '',
    `Visibility: ${data.isPrivate ? 'Private 🔒' : 'Public'}${data.isArchived ? ' | Archived 📦' : ''}${data.isFork ? ' | Fork 🍴' : ''}`,
    `Default branch: ${data.defaultBranchRef?.name ?? 'unknown'}`,
    `Stars: ${data.stargazerCount} | Forks: ${data.forkCount} | Size: ${(data.diskUsage / 1024).toFixed(1)}MB`,
  ];
  if (data.primaryLanguage) lines.push(`Language: ${data.primaryLanguage.name}`);
  if (data.languages?.length) lines.push(`Languages: ${data.languages.map(l => l.name).join(', ')}`);
  if (data.licenseInfo) lines.push(`License: ${data.licenseInfo.name}`);
  if (data.homepageUrl) lines.push(`Homepage: ${data.homepageUrl}`);
  lines.push(`URL: ${data.url}`);
  lines.push(`Created: ${data.createdAt} | Updated: ${data.updatedAt} | Pushed: ${data.pushedAt}`);
  return lines.join('\n');
}

main();
