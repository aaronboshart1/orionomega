#!/usr/bin/env node
/**
 * GitHub Actions Workflow handler — list, runs, view, trigger, cancel, rerun, logs, artifacts.
 */
import { gh, readParams, respond, fail, repoFlag, limitFlag, truncate } from './lib.js';

async function main() {
  const p = await readParams();
  if (!p.action) fail('action is required');

  switch (p.action) {
    case 'list': {
      const res = gh(
        ['workflow', 'list', ...repoFlag(p.repo), ...limitFlag(p.limit, 20)],
        { json: true, jsonFields: ['name', 'id', 'state', 'path'] },
      );
      if (!res.ok) return respond({ error: res.error });
      const wfs = res.data ?? [];
      if (!wfs.length) return respond({ result: 'No workflows found.' });
      return respond({ result: wfs.map(w => `${w.name} (${w.state}) — ${w.path}`).join('\n') });
    }

    case 'runs': {
      const args = ['run', 'list', ...repoFlag(p.repo), ...limitFlag(p.limit, 10)];
      if (p.workflow) args.push('--workflow', p.workflow);
      const res = gh(args, {
        json: true,
        jsonFields: ['databaseId', 'displayTitle', 'status', 'conclusion', 'headBranch', 'createdAt', 'url'],
      });
      if (!res.ok) return respond({ error: res.error });
      const runs = res.data ?? [];
      if (!runs.length) return respond({ result: 'No workflow runs found.' });
      return respond({ result: runs.map(r =>
        `#${r.databaseId} ${statusIcon(r.conclusion ?? r.status)} ${r.displayTitle}` +
        ` (${r.headBranch}) — ${r.status}` +
        `\n  ${r.url}`
      ).join('\n') });
    }

    case 'view': {
      if (!p.run_id) fail('run_id is required for view');
      const res = gh(
        ['run', 'view', p.run_id, ...repoFlag(p.repo)],
        { json: true, jsonFields: [
          'databaseId', 'displayTitle', 'status', 'conclusion',
          'headBranch', 'headSha', 'createdAt', 'updatedAt', 'url',
          'workflowName', 'event', 'jobs',
        ]},
      );
      if (!res.ok) return respond({ error: res.error });
      const r = res.data;
      const lines = [
        `# Run #${r.databaseId}: ${r.displayTitle}`,
        `Workflow: ${r.workflowName} | Trigger: ${r.event}`,
        `Status: ${statusIcon(r.conclusion ?? r.status)} ${r.status} (${r.conclusion ?? 'in progress'})`,
        `Branch: ${r.headBranch} | SHA: ${r.headSha?.slice(0, 8)}`,
        `Created: ${r.createdAt} | Updated: ${r.updatedAt}`,
        `URL: ${r.url}`,
      ];
      if (r.jobs?.length) {
        lines.push('', 'Jobs:');
        for (const j of r.jobs) {
          lines.push(`  ${statusIcon(j.conclusion ?? j.status)} ${j.name}: ${j.conclusion ?? j.status} (${j.durationMs ? Math.round(j.durationMs / 1000) + 's' : '?'})`);
        }
      }
      return respond({ result: lines.join('\n') });
    }

    case 'trigger': {
      if (!p.workflow) fail('workflow is required for trigger');
      const args = ['workflow', 'run', p.workflow, ...repoFlag(p.repo)];
      if (p.ref) args.push('--ref', p.ref);
      if (p.inputs && typeof p.inputs === 'object') {
        for (const [k, v] of Object.entries(p.inputs)) {
          args.push('--field', `${k}=${v}`);
        }
      }
      const res = gh(args);
      return respond(res.ok
        ? { result: `Workflow '${p.workflow}' triggered.${p.ref ? ` (ref: ${p.ref})` : ''}` }
        : { error: res.error });
    }

    case 'cancel': {
      if (!p.run_id) fail('run_id is required for cancel');
      const res = gh(['run', 'cancel', p.run_id, ...repoFlag(p.repo)]);
      return respond(res.ok ? { result: `Run #${p.run_id} cancelled.` } : { error: res.error });
    }

    case 'rerun': {
      if (!p.run_id) fail('run_id is required for rerun');
      const res = gh(['run', 'rerun', p.run_id, ...repoFlag(p.repo)]);
      return respond(res.ok ? { result: `Run #${p.run_id} re-triggered.` } : { error: res.error });
    }

    case 'logs': {
      if (!p.run_id) fail('run_id is required for logs');
      const res = gh(['run', 'view', p.run_id, ...repoFlag(p.repo), '--log']);
      return respond(res.ok ? { result: truncate(res.text ?? '', 20000) } : { error: res.error });
    }

    case 'artifacts': {
      if (!p.run_id) fail('run_id is required for artifacts');
      const res = gh(
        ['run', 'view', p.run_id, ...repoFlag(p.repo)],
        { json: true, jsonFields: ['databaseId', 'displayTitle'] },
      );
      // List artifacts via API
      if (p.repo) {
        const apiRes = gh(['api', `repos/${p.repo}/actions/runs/${p.run_id}/artifacts`]);
        return respond(apiRes.ok
          ? { result: apiRes.text ?? 'No artifacts found.' }
          : { error: apiRes.error });
      }
      return respond(res.ok ? { result: 'Specify repo to list artifacts.' } : { error: res.error });
    }

    case 'download': {
      if (!p.run_id) fail('run_id is required for download');
      const res = gh(['run', 'download', p.run_id, ...repoFlag(p.repo)]);
      return respond(res.ok ? { result: `Artifacts from run #${p.run_id} downloaded.` } : { error: res.error });
    }

    default:
      fail(`Unknown action: ${p.action}. Valid: list, runs, view, trigger, cancel, rerun, logs, artifacts, download`);
  }
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
