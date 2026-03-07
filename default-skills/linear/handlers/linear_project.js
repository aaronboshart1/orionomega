#!/usr/bin/env node
/**
 * Linear Project handler — list, view, create, update, archive.
 * Projects contain issues and have milestones, leads, and status tracking.
 */
import { linear, readParams, respond, fail, truncate } from './lib.js';

const PROJECT_FIELDS = `
  id name description state slugId color icon
  progress scope
  startDate targetDate
  createdAt updatedAt completedAt canceledAt
  url
  lead { id name displayName }
  teams { nodes { id key name } }
  members { nodes { id name displayName } }
  issues { nodes { id identifier title state { name type } } }
`;

const PROJECT_LIST_FIELDS = `
  id name state progress startDate targetDate url
  lead { name displayName }
  teams { nodes { key } }
`;

async function main() {
  const p = await readParams();
  if (!p.action) fail('action is required');

  switch (p.action) {
    case 'list': {
      const first = p.limit ?? 20;
      const filter = {};
      if (p.state) filter.state = { eq: p.state };
      const res = await linear(`
        query($first: Int, $filter: ProjectFilter) {
          projects(first: $first, filter: $filter, orderBy: updatedAt) {
            nodes { ${PROJECT_LIST_FIELDS} }
          }
        }
      `, { first, filter: Object.keys(filter).length ? filter : undefined });
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: formatProjectList(res.data.projects?.nodes ?? []) });
    }

    case 'view': {
      if (!p.id) fail('id is required');
      const res = await linear(`
        query($id: String!) {
          project(id: $id) { ${PROJECT_FIELDS} }
        }
      `, { id: p.id });
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: formatProject(res.data.project) });
    }

    case 'create': {
      if (!p.name) fail('name is required');
      if (!p.teamIds?.length) fail('teamIds is required (array of team UUIDs)');
      const input = { name: p.name, teamIds: p.teamIds };
      if (p.description) input.description = p.description;
      if (p.state) input.state = p.state;
      if (p.startDate) input.startDate = p.startDate;
      if (p.targetDate) input.targetDate = p.targetDate;
      if (p.leadId) input.leadId = p.leadId;
      if (p.color) input.color = p.color;

      const res = await linear(`
        mutation($input: ProjectCreateInput!) {
          projectCreate(input: $input) {
            success
            project { id name url }
          }
        }
      `, { input });
      if (!res.ok) return respond({ error: res.error });
      const proj = res.data.projectCreate?.project;
      return respond({ result: `Project created: ${proj?.name}\n${proj?.url}` });
    }

    case 'update': {
      if (!p.id) fail('id is required');
      const input = {};
      if (p.name) input.name = p.name;
      if (p.description !== undefined) input.description = p.description;
      if (p.state) input.state = p.state;
      if (p.startDate) input.startDate = p.startDate;
      if (p.targetDate) input.targetDate = p.targetDate;
      if (p.leadId) input.leadId = p.leadId;

      const res = await linear(`
        mutation($id: String!, $input: ProjectUpdateInput!) {
          projectUpdate(id: $id, input: $input) {
            success
            project { name state }
          }
        }
      `, { id: p.id, input });
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: `Project ${p.id} updated.` });
    }

    case 'archive': {
      if (!p.id) fail('id is required');
      const res = await linear(`
        mutation($id: String!) {
          projectArchive(id: $id) { success }
        }
      `, { id: p.id });
      if (!res.ok) return respond({ error: res.error });
      return respond({ result: `Project ${p.id} archived.` });
    }

    default:
      fail(`Unknown action: ${p.action}. Valid: list, view, create, update, archive`);
  }
}

function formatProjectList(projects) {
  if (!projects.length) return 'No projects found.';
  return projects.map(p => {
    const teams = p.teams?.nodes?.map(t => t.key).join(', ') ?? '';
    const pct = p.progress != null ? ` ${Math.round(p.progress * 100)}%` : '';
    const lead = p.lead ? ` → ${p.lead.displayName ?? p.lead.name}` : '';
    const dates = [p.startDate, p.targetDate].filter(Boolean).join(' → ');
    return `${stateIcon(p.state)} ${p.name}${pct}${lead}` +
      (teams ? ` [${teams}]` : '') +
      (dates ? ` (${dates})` : '') +
      `\n  ${p.url}`;
  }).join('\n');
}

function formatProject(project) {
  if (!project) return 'Project not found.';
  const lines = [
    `# ${project.name}`,
    `State: ${stateIcon(project.state)} ${project.state} | Progress: ${Math.round((project.progress ?? 0) * 100)}%`,
  ];
  if (project.lead) lines.push(`Lead: ${project.lead.displayName ?? project.lead.name}`);
  if (project.teams?.nodes?.length) lines.push(`Teams: ${project.teams.nodes.map(t => `${t.name} (${t.key})`).join(', ')}`);
  if (project.startDate) lines.push(`Start: ${project.startDate}`);
  if (project.targetDate) lines.push(`Target: ${project.targetDate}`);
  if (project.completedAt) lines.push(`Completed: ${project.completedAt}`);
  if (project.members?.nodes?.length) lines.push(`Members: ${project.members.nodes.map(m => m.displayName ?? m.name).join(', ')}`);
  lines.push(`URL: ${project.url}`);

  // Issue summary
  const issues = project.issues?.nodes ?? [];
  if (issues.length) {
    const done = issues.filter(i => i.state?.type === 'completed').length;
    const inProgress = issues.filter(i => i.state?.type === 'started').length;
    const todo = issues.length - done - inProgress;
    lines.push('', `Issues: ${issues.length} total (✅ ${done} done, 🔄 ${inProgress} in progress, ⏳ ${todo} todo)`);
    for (const i of issues.slice(0, 15)) {
      lines.push(`  ${issueStateIcon(i.state?.type)} ${i.identifier} ${i.title}`);
    }
    if (issues.length > 15) lines.push(`  ... +${issues.length - 15} more`);
  }

  if (project.description) lines.push('', '---', '', truncate(project.description, 3000));
  return lines.join('\n');
}

function stateIcon(state) {
  switch (state) {
    case 'planned': return '📋';
    case 'started': return '🔄';
    case 'paused': return '⏸️';
    case 'completed': return '✅';
    case 'canceled': return '❌';
    default: return '📋';
  }
}

function issueStateIcon(type) {
  switch (type) {
    case 'completed': return '✅';
    case 'started': return '🔄';
    case 'cancelled': return '❌';
    default: return '⏳';
  }
}

main();
