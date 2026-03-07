#!/usr/bin/env node
/**
 * Linear Issue handler — list, view, create, update, close, reopen,
 * comment, assign, label, search, archive.
 */
import { linear, readParams, respond, fail, truncate } from './lib.js';

const ISSUE_FIELDS = `
  id identifier title priority priorityLabel
  estimate sortOrder
  createdAt updatedAt completedAt canceledAt
  url
  state { id name type color }
  assignee { id name displayName }
  team { id name key }
  project { id name }
  cycle { id name number }
  parent { id identifier title }
  labels { nodes { id name color } }
  description
`;

const ISSUE_LIST_FIELDS = `
  id identifier title priority priorityLabel
  createdAt updatedAt url
  state { name type }
  assignee { name displayName }
  team { key }
  labels { nodes { name } }
`;

async function main() {
  const p = await readParams();
  if (!p.action) fail('action is required');

  switch (p.action) {
    case 'list': {
      const filter = buildFilter(p);
      const first = p.limit ?? 25;
      const res = await linear(`
        query($first: Int, $filter: IssueFilter) {
          issues(first: $first, filter: $filter, orderBy: updatedAt) {
            nodes { ${ISSUE_LIST_FIELDS} }
          }
        }
      `, { first, filter: Object.keys(filter).length ? filter : undefined });
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: formatIssueList(res.data.issues?.nodes ?? []) });
    }

    case 'view': {
      if (!p.id) fail('id is required (e.g. "TEAM-123" or UUID)');
      const res = await linear(`
        query($id: String!) {
          issue(id: $id) { ${ISSUE_FIELDS} }
        }
      `, { id: p.id });
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: formatIssue(res.data.issue) });
    }

    case 'create': {
      if (!p.title) fail('title is required');
      if (!p.teamId && !p.team) fail('teamId or team (key) is required');

      let teamId = p.teamId;
      if (!teamId && p.team) {
        teamId = await resolveTeamId(p.team);
        if (!teamId) return respond({ error: `Team "${p.team}" not found` });
      }

      const input = { title: p.title, teamId };
      if (p.description) input.description = p.description;
      if (p.priority !== undefined) input.priority = p.priority;
      if (p.estimate) input.estimate = p.estimate;
      if (p.stateId) input.stateId = p.stateId;
      if (p.assigneeId) input.assigneeId = p.assigneeId;
      if (p.projectId) input.projectId = p.projectId;
      if (p.cycleId) input.cycleId = p.cycleId;
      if (p.parentId) input.parentId = p.parentId;
      if (p.labelIds?.length) input.labelIds = p.labelIds;
      if (p.dueDate) input.dueDate = p.dueDate;

      const res = await linear(`
        mutation($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue { id identifier title url state { name } }
          }
        }
      `, { input });
      if (!res.ok) return respond({ error: res.error });
      const issue = res.data.issueCreate?.issue;
      return respond({ result: `Issue created: ${issue?.identifier} — ${issue?.title}\n${issue?.url}` });
    }

    case 'update': {
      if (!p.id) fail('id is required');
      const input = {};
      if (p.title) input.title = p.title;
      if (p.description !== undefined) input.description = p.description;
      if (p.priority !== undefined) input.priority = p.priority;
      if (p.estimate !== undefined) input.estimate = p.estimate;
      if (p.stateId) input.stateId = p.stateId;
      if (p.assigneeId) input.assigneeId = p.assigneeId;
      if (p.projectId) input.projectId = p.projectId;
      if (p.cycleId) input.cycleId = p.cycleId;
      if (p.parentId) input.parentId = p.parentId;
      if (p.labelIds?.length) input.labelIds = p.labelIds;
      if (p.dueDate) input.dueDate = p.dueDate;

      const res = await linear(`
        mutation($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue { identifier title state { name } }
          }
        }
      `, { id: p.id, input });
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: `Issue ${p.id} updated.` });
    }

    case 'close': {
      if (!p.id) fail('id is required');
      // Find the "Done" state for the issue's team
      const stateId = await resolveDoneState(p.id);
      if (!stateId) return respond({ error: 'Could not find a completed state for this issue' });
      const res = await linear(`
        mutation($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success }
        }
      `, { id: p.id, input: { stateId } });
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: `Issue ${p.id} closed.` });
    }

    case 'reopen': {
      if (!p.id) fail('id is required');
      const stateId = await resolveBacklogState(p.id);
      if (!stateId) return respond({ error: 'Could not find a backlog state' });
      const res = await linear(`
        mutation($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success }
        }
      `, { id: p.id, input: { stateId } });
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: `Issue ${p.id} reopened.` });
    }

    case 'comment': {
      if (!p.id) fail('id is required');
      if (!p.body) fail('body is required');
      const res = await linear(`
        mutation($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
            comment { id url }
          }
        }
      `, { input: { issueId: p.id, body: p.body } });
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: `Comment added to ${p.id}.` });
    }

    case 'assign': {
      if (!p.id) fail('id is required');
      if (!p.assigneeId) fail('assigneeId is required');
      const res = await linear(`
        mutation($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success }
        }
      `, { id: p.id, input: { assigneeId: p.assigneeId } });
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: `Issue ${p.id} assigned.` });
    }

    case 'label': {
      if (!p.id) fail('id is required');
      if (!p.labelIds?.length) fail('labelIds is required');
      const res = await linear(`
        mutation($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success }
        }
      `, { id: p.id, input: { labelIds: p.labelIds } });
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: `Labels updated on ${p.id}.` });
    }

    case 'search': {
      if (!p.query) fail('query is required');
      const res = await linear(`
        query($query: String!, $first: Int) {
          searchIssues(term: $query, first: $first) {
            nodes { ${ISSUE_LIST_FIELDS} }
          }
        }
      `, { query: p.query, first: p.limit ?? 15 });
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: formatIssueList(res.data.searchIssues?.nodes ?? []) });
    }

    case 'archive': {
      if (!p.id) fail('id is required');
      const res = await linear(`
        mutation($id: String!) {
          issueArchive(id: $id) { success }
        }
      `, { id: p.id });
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: `Issue ${p.id} archived.` });
    }

    default:
      fail(`Unknown action: ${p.action}. Valid: list, view, create, update, close, reopen, comment, assign, label, search, archive`);
  }
}

function buildFilter(p) {
  const filter = {};
  if (p.teamId) filter.team = { id: { eq: p.teamId } };
  if (p.team) filter.team = { key: { eqIgnoreCase: p.team } };
  if (p.state) filter.state = { name: { eqIgnoreCase: p.state } };
  if (p.stateType) filter.state = { type: { eq: p.stateType } };
  if (p.assigneeId) filter.assignee = { id: { eq: p.assigneeId } };
  if (p.assignee === '@me') filter.assignee = { isMe: { eq: true } };
  if (p.priority !== undefined) filter.priority = { eq: p.priority };
  if (p.projectId) filter.project = { id: { eq: p.projectId } };
  if (p.cycleId) filter.cycle = { id: { eq: p.cycleId } };
  if (p.label) filter.labels = { name: { eqIgnoreCase: p.label } };
  return filter;
}

async function resolveTeamId(key) {
  const res = await linear(`
    query { teams { nodes { id key } } }
  `);
  if (!res.ok) return null;
  const team = res.data.teams?.nodes?.find(t => t.key.toLowerCase() === key.toLowerCase());
  return team?.id ?? null;
}

async function resolveDoneState(issueId) {
  const res = await linear(`
    query($id: String!) {
      issue(id: $id) {
        team { states { nodes { id name type } } }
      }
    }
  `, { id: issueId });
  if (!res.ok) return null;
  const states = res.data.issue?.team?.states?.nodes ?? [];
  return states.find(s => s.type === 'completed')?.id ?? null;
}

async function resolveBacklogState(issueId) {
  const res = await linear(`
    query($id: String!) {
      issue(id: $id) {
        team { states { nodes { id name type } } }
      }
    }
  `, { id: issueId });
  if (!res.ok) return null;
  const states = res.data.issue?.team?.states?.nodes ?? [];
  return states.find(s => s.type === 'backlog')?.id ?? states.find(s => s.type === 'unstarted')?.id ?? null;
}

function formatIssueList(issues) {
  if (!issues.length) return 'No issues found.';
  return issues.map(i => {
    const labels = i.labels?.nodes?.map(l => l.name).join(', ');
    return `${i.identifier} [${i.state?.name ?? '?'}] ${priorityIcon(i.priority)} ${i.title}` +
      (i.assignee ? ` → ${i.assignee.displayName ?? i.assignee.name}` : '') +
      (labels ? ` (${labels})` : '') +
      `\n  ${i.url}`;
  }).join('\n');
}

function formatIssue(issue) {
  if (!issue) return 'Issue not found.';
  const lines = [
    `# ${issue.identifier}: ${issue.title}`,
    `Team: ${issue.team?.key ?? '?'} | State: ${issue.state?.name} (${issue.state?.type})`,
    `Priority: ${priorityIcon(issue.priority)} ${issue.priorityLabel}`,
    `Created: ${issue.createdAt} | Updated: ${issue.updatedAt}`,
  ];
  if (issue.assignee) lines.push(`Assignee: ${issue.assignee.displayName ?? issue.assignee.name}`);
  if (issue.project) lines.push(`Project: ${issue.project.name}`);
  if (issue.cycle) lines.push(`Cycle: ${issue.cycle.name ?? `Cycle ${issue.cycle.number}`}`);
  if (issue.parent) lines.push(`Parent: ${issue.parent.identifier} — ${issue.parent.title}`);
  if (issue.labels?.nodes?.length) lines.push(`Labels: ${issue.labels.nodes.map(l => l.name).join(', ')}`);
  if (issue.estimate) lines.push(`Estimate: ${issue.estimate}`);
  lines.push(`URL: ${issue.url}`);
  if (issue.description) lines.push('', '---', '', truncate(issue.description, 5000));
  return lines.join('\n');
}

function priorityIcon(p) {
  switch (p) {
    case 1: return '🔴';
    case 2: return '🟠';
    case 3: return '🟡';
    case 4: return '🔵';
    default: return '⚪';
  }
}

main();
