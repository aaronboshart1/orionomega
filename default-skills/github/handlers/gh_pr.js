#!/usr/bin/env node
/**
 * GitHub Pull Request handler — list, view, create, edit, merge, close,
 * reopen, comment, review, diff, checks, ready, draft.
 */
import { gh, readParams, respond, fail, repoFlag, limitFlag, truncate } from './lib.js';

const PR_LIST_FIELDS = [
  'number', 'title', 'state', 'author', 'headRefName', 'baseRefName',
  'labels', 'isDraft', 'mergeable', 'createdAt', 'url',
];

const PR_VIEW_FIELDS = [
  ...PR_LIST_FIELDS, 'body', 'additions', 'deletions', 'changedFiles',
  'reviewDecision', 'assignees', 'reviewRequests', 'mergedAt', 'mergedBy',
  'statusCheckRollup', 'updatedAt',
];

async function main() {
  const p = await readParams();
  if (!p.action) fail('action is required');

  switch (p.action) {
    case 'list': {
      const args = ['pr', 'list', ...repoFlag(p.repo), ...limitFlag(p.limit)];
      if (p.state) args.push('--state', p.state);
      if (p.labels?.length) args.push('--label', p.labels.join(','));
      if (p.assignees?.length) args.push('--assignee', p.assignees[0]);
      if (p.head) args.push('--head', p.head);
      if (p.base) args.push('--base', p.base);
      const res = gh(args, { json: true, jsonFields: PR_LIST_FIELDS });
      return respond(res.ok ? { result: formatPRList(res.data) } : { error: res.error });
    }

    case 'view': {
      if (!p.number) fail('number is required for view');
      const res = gh(
        ['pr', 'view', String(p.number), ...repoFlag(p.repo)],
        { json: true, jsonFields: PR_VIEW_FIELDS },
      );
      return respond(res.ok ? { result: formatPR(res.data) } : { error: res.error });
    }

    case 'create': {
      if (!p.title) fail('title is required for create');
      if (!p.head) fail('head branch is required for create');
      const args = ['pr', 'create', ...repoFlag(p.repo), '--title', p.title, '--head', p.head];
      if (p.base) args.push('--base', p.base);
      if (p.body) args.push('--body', p.body);
      if (p.draft) args.push('--draft');
      if (p.labels?.length) for (const l of p.labels) args.push('--label', l);
      if (p.assignees?.length) for (const a of p.assignees) args.push('--assignee', a);
      if (p.reviewers?.length) for (const r of p.reviewers) args.push('--reviewer', r);
      const res = gh(args, { json: true, jsonFields: ['number', 'url', 'title'] });
      return respond(res.ok
        ? { result: `PR created: #${res.data?.number} — ${res.data?.title}\n${res.data?.url}` }
        : { error: res.error });
    }

    case 'edit': {
      if (!p.number) fail('number is required for edit');
      const args = ['pr', 'edit', String(p.number), ...repoFlag(p.repo)];
      if (p.title) args.push('--title', p.title);
      if (p.body) args.push('--body', p.body);
      if (p.labels?.length) for (const l of p.labels) args.push('--add-label', l);
      if (p.assignees?.length) for (const a of p.assignees) args.push('--add-assignee', a);
      if (p.reviewers?.length) for (const r of p.reviewers) args.push('--add-reviewer', r);
      if (p.base) args.push('--base', p.base);
      const res = gh(args);
      return respond(res.ok ? { result: `PR #${p.number} updated.` } : { error: res.error });
    }

    case 'merge': {
      if (!p.number) fail('number is required for merge');
      const args = ['pr', 'merge', String(p.number), ...repoFlag(p.repo), '--auto'];
      const method = p.merge_method ?? 'merge';
      args.push(`--${method}`);
      if (p.body) args.push('--subject', p.body);
      args.push('--delete-branch');
      const res = gh(args);
      return respond(res.ok ? { result: `PR #${p.number} merged (${method}).` } : { error: res.error });
    }

    case 'close': {
      if (!p.number) fail('number is required for close');
      const args = ['pr', 'close', String(p.number), ...repoFlag(p.repo)];
      if (p.body) args.push('--comment', p.body);
      const res = gh(args);
      return respond(res.ok ? { result: `PR #${p.number} closed.` } : { error: res.error });
    }

    case 'reopen': {
      if (!p.number) fail('number is required for reopen');
      const res = gh(['pr', 'reopen', String(p.number), ...repoFlag(p.repo)]);
      return respond(res.ok ? { result: `PR #${p.number} reopened.` } : { error: res.error });
    }

    case 'comment': {
      if (!p.number) fail('number is required for comment');
      if (!p.body) fail('body is required for comment');
      const res = gh(['pr', 'comment', String(p.number), ...repoFlag(p.repo), '--body', p.body]);
      return respond(res.ok ? { result: `Comment added to PR #${p.number}.` } : { error: res.error });
    }

    case 'review': {
      if (!p.number) fail('number is required for review');
      const event = p.review_event ?? 'COMMENT';
      const args = ['pr', 'review', String(p.number), ...repoFlag(p.repo)];
      if (event === 'APPROVE') args.push('--approve');
      else if (event === 'REQUEST_CHANGES') args.push('--request-changes');
      else args.push('--comment');
      if (p.body) args.push('--body', p.body);
      const res = gh(args);
      return respond(res.ok ? { result: `PR #${p.number} reviewed: ${event}.` } : { error: res.error });
    }

    case 'diff': {
      if (!p.number) fail('number is required for diff');
      const res = gh(['pr', 'diff', String(p.number), ...repoFlag(p.repo)]);
      return respond(res.ok ? { result: truncate(res.text ?? '', 20000) } : { error: res.error });
    }

    case 'checks': {
      if (!p.number) fail('number is required for checks');
      const res = gh(
        ['pr', 'checks', String(p.number), ...repoFlag(p.repo)],
        { json: true, jsonFields: ['name', 'state', 'conclusion', 'startedAt', 'completedAt', 'detailsUrl'] },
      );
      if (!res.ok) return respond({ error: res.error });
      const checks = res.data ?? [];
      if (!checks.length) return respond({ result: 'No checks found.' });
      const formatted = checks.map(c =>
        `${statusIcon(c.conclusion ?? c.state)} ${c.name}: ${c.conclusion ?? c.state}` +
        (c.detailsUrl ? `\n  ${c.detailsUrl}` : '')
      ).join('\n');
      return respond({ result: `Checks for PR #${p.number}:\n\n${formatted}` });
    }

    case 'ready': {
      if (!p.number) fail('number is required for ready');
      const res = gh(['pr', 'ready', String(p.number), ...repoFlag(p.repo)]);
      return respond(res.ok ? { result: `PR #${p.number} marked as ready for review.` } : { error: res.error });
    }

    case 'draft': {
      if (!p.number) fail('number is required for draft');
      const res = gh(['pr', 'edit', String(p.number), ...repoFlag(p.repo), '--draft']);
      return respond(res.ok ? { result: `PR #${p.number} converted to draft.` } : { error: res.error });
    }

    default:
      fail(`Unknown action: ${p.action}. Valid: list, view, create, edit, merge, close, reopen, comment, review, diff, checks, ready, draft`);
  }
}

function formatPRList(data) {
  if (!Array.isArray(data) || data.length === 0) return 'No pull requests found.';
  return data.map(pr =>
    `#${pr.number} [${pr.state}${pr.isDraft ? '/draft' : ''}] ${pr.title}` +
    ` (${pr.headRefName} → ${pr.baseRefName})` +
    (pr.labels?.length ? ` (${pr.labels.map(l => l.name).join(', ')})` : '') +
    `\n  ${pr.url}`
  ).join('\n');
}

function formatPR(data) {
  if (!data) return 'PR not found.';
  const lines = [
    `# PR #${data.number}: ${data.title}`,
    `State: ${data.state}${data.isDraft ? ' (draft)' : ''} | Author: ${data.author?.login}`,
    `Branch: ${data.headRefName} → ${data.baseRefName}`,
    `Mergeable: ${data.mergeable} | Review: ${data.reviewDecision ?? 'pending'}`,
    `Changes: +${data.additions} -${data.deletions} (${data.changedFiles} files)`,
    `Created: ${data.createdAt} | Updated: ${data.updatedAt}`,
  ];
  if (data.mergedAt) lines.push(`Merged: ${data.mergedAt} by ${data.mergedBy?.login}`);
  if (data.assignees?.length) lines.push(`Assignees: ${data.assignees.map(a => a.login).join(', ')}`);
  if (data.labels?.length) lines.push(`Labels: ${data.labels.map(l => l.name).join(', ')}`);
  lines.push(`URL: ${data.url}`);

  // CI checks summary
  if (data.statusCheckRollup?.length) {
    lines.push('', 'Checks:');
    for (const c of data.statusCheckRollup) {
      lines.push(`  ${statusIcon(c.conclusion ?? c.status)} ${c.name ?? c.context}: ${c.conclusion ?? c.status}`);
    }
  }

  if (data.body) lines.push('', '---', '', data.body);
  return lines.join('\n');
}

function statusIcon(status) {
  switch (status?.toUpperCase()) {
    case 'SUCCESS': case 'COMPLETED': return '✅';
    case 'FAILURE': case 'FAILED': return '❌';
    case 'PENDING': case 'IN_PROGRESS': case 'QUEUED': return '⏳';
    case 'CANCELLED': case 'SKIPPED': return '⏭️';
    default: return '❓';
  }
}

main();
