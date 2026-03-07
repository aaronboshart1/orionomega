#!/usr/bin/env node
/**
 * Linear Team handler — list, view members, view states, view labels, view cycles.
 * Teams are the organizational unit in Linear. Issues belong to teams.
 */
import { linear, readParams, respond, fail } from './lib.js';

async function main() {
  const p = await readParams();
  if (!p.action) fail('action is required');

  switch (p.action) {
    case 'list': {
      const res = await linear(`
        query {
          teams {
            nodes {
              id key name description
              members { nodes { id name displayName } }
              states { nodes { id name type position } }
              issueCount
            }
          }
        }
      `);
      if (!res.ok) return respond({ error: res.error });
      const teams = res.data.teams?.nodes ?? [];
      if (!teams.length) return respond({ result: 'No teams found.' });
      return respond({ result: teams.map(t => {
        const members = t.members?.nodes?.length ?? 0;
        return `${t.key} — ${t.name} (${members} members, ${t.issueCount ?? '?'} issues)` +
          (t.description ? `\n  ${t.description}` : '');
      }).join('\n') });
    }

    case 'view': {
      if (!p.id) fail('id (team key or UUID) is required');
      const res = await linear(`
        query($id: String!) {
          team(id: $id) {
            id key name description timezone
            issueCount
            members { nodes { id name displayName email } }
            states { nodes { id name type position color } }
            labels { nodes { id name color } }
            activeCycle { id name number startsAt endsAt }
          }
        }
      `, { id: p.id });
      if (!res.ok) return respond({ error: res.error });
      const t = res.data.team;
      if (!t) return respond({ error: 'Team not found.' });

      const lines = [
        `# ${t.key} — ${t.name}`,
        t.description ?? '',
        `Issues: ${t.issueCount ?? '?'} | Timezone: ${t.timezone ?? 'unset'}`,
      ];

      if (t.activeCycle) {
        lines.push(`\nActive Cycle: ${t.activeCycle.name ?? `Cycle ${t.activeCycle.number}`} (${t.activeCycle.startsAt} → ${t.activeCycle.endsAt})`);
      }

      if (t.members?.nodes?.length) {
        lines.push('\nMembers:');
        for (const m of t.members.nodes) {
          lines.push(`  • ${m.displayName ?? m.name}${m.email ? ` (${m.email})` : ''}`);
        }
      }

      if (t.states?.nodes?.length) {
        lines.push('\nWorkflow States:');
        const sorted = [...t.states.nodes].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        for (const s of sorted) {
          lines.push(`  ${stateTypeIcon(s.type)} ${s.name} (${s.type})`);
        }
      }

      if (t.labels?.nodes?.length) {
        lines.push('\nLabels:');
        lines.push('  ' + t.labels.nodes.map(l => l.name).join(', '));
      }

      return respond({ result: lines.join('\n') });
    }

    case 'members': {
      if (!p.id) fail('id (team key or UUID) is required');
      const res = await linear(`
        query($id: String!) {
          team(id: $id) {
            members { nodes { id name displayName email active admin } }
          }
        }
      `, { id: p.id });
      if (!res.ok) return respond({ error: res.error });
      const members = res.data.team?.members?.nodes ?? [];
      if (!members.length) return respond({ result: 'No members found.' });
      return respond({ result: members.map(m =>
        `${m.displayName ?? m.name}${m.email ? ` (${m.email})` : ''}${m.admin ? ' [admin]' : ''}${m.active === false ? ' [inactive]' : ''}`
      ).join('\n') });
    }

    case 'states': {
      if (!p.id) fail('id (team key or UUID) is required');
      const res = await linear(`
        query($id: String!) {
          team(id: $id) {
            states { nodes { id name type position color } }
          }
        }
      `, { id: p.id });
      if (!res.ok) return respond({ error: res.error });
      const states = res.data.team?.states?.nodes ?? [];
      const sorted = [...states].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      return respond({ result: sorted.map(s =>
        `${stateTypeIcon(s.type)} ${s.name} (${s.type}) — id: ${s.id}`
      ).join('\n') });
    }

    case 'labels': {
      if (!p.id) fail('id (team key or UUID) is required');
      const res = await linear(`
        query($id: String!) {
          team(id: $id) {
            labels { nodes { id name color description } }
          }
        }
      `, { id: p.id });
      if (!res.ok) return respond({ error: res.error });
      const labels = res.data.team?.labels?.nodes ?? [];
      if (!labels.length) return respond({ result: 'No labels found.' });
      return respond({ result: labels.map(l =>
        `${l.name}${l.description ? ` — ${l.description}` : ''} (id: ${l.id})`
      ).join('\n') });
    }

    case 'cycles': {
      if (!p.id) fail('id (team key or UUID) is required');
      const first = p.limit ?? 5;
      const res = await linear(`
        query($id: String!, $first: Int) {
          team(id: $id) {
            cycles(first: $first, orderBy: updatedAt) {
              nodes { id name number startsAt endsAt progress scope completedAt }
            }
          }
        }
      `, { id: p.id, first });
      if (!res.ok) return respond({ error: res.error });
      const cycles = res.data.team?.cycles?.nodes ?? [];
      if (!cycles.length) return respond({ result: 'No cycles found.' });
      return respond({ result: cycles.map(c => {
        const pct = c.progress != null ? ` ${Math.round(c.progress * 100)}%` : '';
        return `Cycle ${c.number}${c.name ? ` — ${c.name}` : ''}${pct} (${c.startsAt} → ${c.endsAt})${c.completedAt ? ' ✅' : ''}`;
      }).join('\n') });
    }

    default:
      fail(`Unknown action: ${p.action}. Valid: list, view, members, states, labels, cycles`);
  }
}

function stateTypeIcon(type) {
  switch (type) {
    case 'triage': return '📥';
    case 'backlog': return '📋';
    case 'unstarted': return '⏳';
    case 'started': return '🔄';
    case 'completed': return '✅';
    case 'cancelled': return '❌';
    default: return '❓';
  }
}

main();
