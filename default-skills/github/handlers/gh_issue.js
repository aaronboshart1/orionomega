#!/usr/bin/env node
/**
 * GitHub Issue handler — list, view, create, edit, close, reopen, comment,
 * assign, label, search, transfer, pin, lock.
 */
import { gh, readParams, respond, fail, repoFlag, limitFlag } from './lib.js';

const ISSUE_FIELDS = [
  'number', 'title', 'state', 'author', 'assignees',
  'labels', 'milestone', 'createdAt', 'updatedAt', 'url', 'body',
];

const ISSUE_LIST_FIELDS = [
  'number', 'title', 'state', 'author', 'labels', 'milestone',
  'createdAt', 'updatedAt', 'url',
];

async function main() {
  const p = await readParams();
  if (!p.action) fail('action is required');

  switch (p.action) {
    case 'list': {
      const args = ['issue', 'list', ...repoFlag(p.repo), ...limitFlag(p.limit)];
      if (p.state) args.push('--state', p.state);
      if (p.labels?.length) args.push('--label', p.labels.join(','));
      if (p.assignees?.length) args.push('--assignee', p.assignees[0]);
      if (p.milestone) args.push('--milestone', p.milestone);
      if (p.sort) args.push('--sort', p.sort);
      const res = gh(args, { json: true, jsonFields: ISSUE_LIST_FIELDS });
      return respond(res.ok ? { result: formatIssueList(res.data) } : { error: res.error });
    }

    case 'view': {
      if (!p.number) fail('number is required for view');
      const args = ['issue', 'view', String(p.number), ...repoFlag(p.repo)];
      const res = gh(args, { json: true, jsonFields: ISSUE_FIELDS });
      return respond(res.ok ? { result: formatIssue(res.data) } : { error: res.error });
    }

    case 'create': {
      if (!p.title) fail('title is required for create');
      const args = ['issue', 'create', ...repoFlag(p.repo), '--title', p.title];
      if (p.body) args.push('--body', p.body);
      if (p.labels?.length) for (const l of p.labels) args.push('--label', l);
      if (p.assignees?.length) for (const a of p.assignees) args.push('--assignee', a);
      if (p.milestone) args.push('--milestone', p.milestone);
      const res = gh(args, { json: true, jsonFields: ['number', 'url', 'title'] });
      return respond(res.ok
        ? { result: `Issue created: #${res.data?.number} — ${res.data?.title}\n${res.data?.url}` }
        : { error: res.error });
    }

    case 'edit': {
      if (!p.number) fail('number is required for edit');
      const args = ['issue', 'edit', String(p.number), ...repoFlag(p.repo)];
      if (p.title) args.push('--title', p.title);
      if (p.body) args.push('--body', p.body);
      if (p.labels?.length) for (const l of p.labels) args.push('--add-label', l);
      if (p.assignees?.length) for (const a of p.assignees) args.push('--add-assignee', a);
      if (p.milestone) args.push('--milestone', p.milestone);
      const res = gh(args);
      return respond(res.ok ? { result: `Issue #${p.number} updated.` } : { error: res.error });
    }

    case 'close': {
      if (!p.number) fail('number is required for close');
      const args = ['issue', 'close', String(p.number), ...repoFlag(p.repo)];
      if (p.body) args.push('--comment', p.body);
      const res = gh(args);
      return respond(res.ok ? { result: `Issue #${p.number} closed.` } : { error: res.error });
    }

    case 'reopen': {
      if (!p.number) fail('number is required for reopen');
      const res = gh(['issue', 'reopen', String(p.number), ...repoFlag(p.repo)]);
      return respond(res.ok ? { result: `Issue #${p.number} reopened.` } : { error: res.error });
    }

    case 'comment': {
      if (!p.number) fail('number is required for comment');
      if (!p.body) fail('body is required for comment');
      const res = gh(['issue', 'comment', String(p.number), ...repoFlag(p.repo), '--body', p.body]);
      return respond(res.ok ? { result: `Comment added to issue #${p.number}.` } : { error: res.error });
    }

    case 'assign': {
      if (!p.number) fail('number is required for assign');
      if (!p.assignees?.length) fail('assignees is required for assign');
      const args = ['issue', 'edit', String(p.number), ...repoFlag(p.repo)];
      for (const a of p.assignees) args.push('--add-assignee', a);
      const res = gh(args);
      return respond(res.ok ? { result: `Issue #${p.number} assigned to ${p.assignees.join(', ')}.` } : { error: res.error });
    }

    case 'label': {
      if (!p.number) fail('number is required for label');
      if (!p.labels?.length) fail('labels is required for label');
      const args = ['issue', 'edit', String(p.number), ...repoFlag(p.repo)];
      for (const l of p.labels) args.push('--add-label', l);
      const res = gh(args);
      return respond(res.ok ? { result: `Labels added to issue #${p.number}: ${p.labels.join(', ')}` } : { error: res.error });
    }

    case 'search': {
      if (!p.query) fail('query is required for search');
      const args = ['search', 'issues', p.query, ...limitFlag(p.limit, 10)];
      if (p.repo) args.push('--repo', p.repo);
      const res = gh(args, { json: true, jsonFields: ['number', 'title', 'state', 'repository', 'url'] });
      return respond(res.ok ? { result: formatSearchResults(res.data) } : { error: res.error });
    }

    case 'transfer': {
      if (!p.number) fail('number is required for transfer');
      if (!p.repo) fail('repo is required for transfer (destination)');
      const res = gh(['issue', 'transfer', String(p.number), p.repo]);
      return respond(res.ok ? { result: `Issue #${p.number} transferred to ${p.repo}.` } : { error: res.error });
    }

    case 'pin': {
      if (!p.number) fail('number is required for pin');
      const res = gh(['issue', 'pin', String(p.number), ...repoFlag(p.repo)]);
      return respond(res.ok ? { result: `Issue #${p.number} pinned.` } : { error: res.error });
    }

    case 'lock': {
      if (!p.number) fail('number is required for lock');
      const res = gh(['issue', 'lock', String(p.number), ...repoFlag(p.repo)]);
      return respond(res.ok ? { result: `Issue #${p.number} locked.` } : { error: res.error });
    }

    default:
      fail(`Unknown action: ${p.action}. Valid: list, view, create, edit, close, reopen, comment, assign, label, search, transfer, pin, lock`);
  }
}

function formatIssueList(data) {
  if (!Array.isArray(data) || data.length === 0) return 'No issues found.';
  return data.map(i =>
    `#${i.number} [${i.state}] ${i.title}` +
    (i.labels?.length ? ` (${i.labels.map(l => l.name).join(', ')})` : '') +
    (i.assignees?.length ? ` → ${i.assignees.map(a => a.login).join(', ')}` : '') +
    `\n  ${i.url}`
  ).join('\n');
}

function formatIssue(data) {
  if (!data) return 'Issue not found.';
  const lines = [
    `# Issue #${data.number}: ${data.title}`,
    `State: ${data.state} | Author: ${data.author?.login}`,
    `Created: ${data.createdAt} | Updated: ${data.updatedAt}`,
  ];
  if (data.assignees?.length) lines.push(`Assignees: ${data.assignees.map(a => a.login).join(', ')}`);
  if (data.labels?.length) lines.push(`Labels: ${data.labels.map(l => l.name).join(', ')}`);
  if (data.milestone) lines.push(`Milestone: ${data.milestone.title}`);
  lines.push(`URL: ${data.url}`);
  if (data.body) lines.push('', '---', '', data.body);
  return lines.join('\n');
}

function formatSearchResults(data) {
  if (!Array.isArray(data) || data.length === 0) return 'No results found.';
  return data.map(i =>
    `#${i.number} [${i.state}] ${i.title} (${i.repository?.nameWithOwner ?? ''})\n  ${i.url}`
  ).join('\n');
}

main();
