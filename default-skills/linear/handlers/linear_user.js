#!/usr/bin/env node
/**
 * Linear User handler — viewer (me), list users, assigned issues, created issues.
 */
import { linear, readParams, respond, fail } from './lib.js';

async function main() {
  const p = await readParams();
  if (!p.action) fail('action is required');

  switch (p.action) {
    case 'me': {
      const res = await linear(`
        query {
          viewer {
            id name displayName email url active admin
            teams { nodes { key name } }
            assignedIssues(first: 10, orderBy: updatedAt) {
              nodes { identifier title state { name type } priority priorityLabel url }
            }
          }
        }
      `);
      if (!res.ok) return respond({ error: res.error });
      const v = res.data.viewer;
      const lines = [
        `# ${v.displayName ?? v.name}`,
        `Email: ${v.email}`,
        `Teams: ${v.teams?.nodes?.map(t => `${t.key} (${t.name})`).join(', ') ?? 'none'}`,
        `URL: ${v.url}`,
      ];
      const issues = v.assignedIssues?.nodes ?? [];
      if (issues.length) {
        lines.push(`\nAssigned Issues (${issues.length} most recent):`);
        for (const i of issues) {
          lines.push(`  ${priorityIcon(i.priority)} ${i.identifier} [${i.state?.name}] ${i.title}`);
        }
      }
      return respond({ result: lines.join('\n') });
    }

    case 'list': {
      const res = await linear(`
        query {
          users {
            nodes { id name displayName email active admin }
          }
        }
      `);
      if (!res.ok) return respond({ error: res.error });
      const users = res.data.users?.nodes ?? [];
      if (!users.length) return respond({ result: 'No users found.' });
      return respond({ result: users.map(u =>
        `${u.displayName ?? u.name}${u.email ? ` (${u.email})` : ''}${u.admin ? ' [admin]' : ''}${!u.active ? ' [inactive]' : ''} — id: ${u.id}`
      ).join('\n') });
    }

    case 'assigned': {
      const userId = p.userId;
      const first = p.limit ?? 20;
      let query, vars;
      if (userId) {
        query = `query($id: String!, $first: Int) {
          user(id: $id) {
            assignedIssues(first: $first, orderBy: updatedAt) {
              nodes { identifier title state { name type } priority priorityLabel url assignee { displayName } }
            }
          }
        }`;
        vars = { id: userId, first };
      } else {
        query = `query($first: Int) {
          viewer {
            assignedIssues(first: $first, orderBy: updatedAt) {
              nodes { identifier title state { name type } priority priorityLabel url }
            }
          }
        }`;
        vars = { first };
      }
      const res = await linear(query, vars);
      if (!res.ok) return respond({ error: res.error });
      const issues = (userId ? res.data.user : res.data.viewer)?.assignedIssues?.nodes ?? [];
      if (!issues.length) return respond({ result: 'No assigned issues.' });
      return respond({ result: issues.map(i =>
        `${priorityIcon(i.priority)} ${i.identifier} [${i.state?.name}] ${i.title}\n  ${i.url}`
      ).join('\n') });
    }

    default:
      fail(`Unknown action: ${p.action}. Valid: me, list, assigned`);
  }
}

function priorityIcon(p) {
  switch (p) { case 1: return '🔴'; case 2: return '🟠'; case 3: return '🟡'; case 4: return '🔵'; default: return '⚪'; }
}

main();
