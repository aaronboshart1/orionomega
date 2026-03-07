#!/usr/bin/env node
/**
 * GitHub Release handler — list, view, create, edit, delete, upload, download.
 */
import { gh, readParams, respond, fail, repoFlag, limitFlag } from './lib.js';

async function main() {
  const p = await readParams();
  if (!p.action) fail('action is required');

  switch (p.action) {
    case 'list': {
      const res = gh(
        ['release', 'list', ...repoFlag(p.repo), ...limitFlag(p.limit, 10)],
        { json: true, jsonFields: ['tagName', 'name', 'isPrerelease', 'isDraft', 'publishedAt', 'url'] },
      );
      if (!res.ok) return respond({ error: res.error });
      const releases = res.data ?? [];
      if (!releases.length) return respond({ result: 'No releases found.' });
      return respond({ result: releases.map(r =>
        `${r.tagName} — ${r.name ?? '(untitled)'}` +
        `${r.isDraft ? ' [draft]' : ''}${r.isPrerelease ? ' [pre]' : ''}` +
        ` (${r.publishedAt})` +
        `\n  ${r.url}`
      ).join('\n') });
    }

    case 'view': {
      if (!p.tag) fail('tag is required for view');
      const res = gh(
        ['release', 'view', p.tag, ...repoFlag(p.repo)],
        { json: true, jsonFields: ['tagName', 'name', 'body', 'isDraft', 'isPrerelease', 'publishedAt', 'author', 'assets', 'url'] },
      );
      if (!res.ok) return respond({ error: res.error });
      const r = res.data;
      const lines = [
        `# Release ${r.tagName}: ${r.name ?? ''}`,
        `Author: ${r.author?.login} | Published: ${r.publishedAt}`,
        `${r.isDraft ? '[Draft] ' : ''}${r.isPrerelease ? '[Pre-release] ' : ''}`,
        `URL: ${r.url}`,
      ];
      if (r.assets?.length) {
        lines.push('', 'Assets:');
        for (const a of r.assets) {
          lines.push(`  📦 ${a.name} (${formatSize(a.size)}) — ${a.downloadCount ?? 0} downloads`);
        }
      }
      if (r.body) lines.push('', '---', '', r.body);
      return respond({ result: lines.join('\n') });
    }

    case 'create': {
      if (!p.tag) fail('tag is required for create');
      const args = ['release', 'create', p.tag, ...repoFlag(p.repo)];
      if (p.title) args.push('--title', p.title);
      if (p.notes) args.push('--notes', p.notes);
      if (p.draft) args.push('--draft');
      if (p.prerelease) args.push('--prerelease');
      if (p.generate_notes) args.push('--generate-notes');
      if (p.target) args.push('--target', p.target);
      if (p.files?.length) for (const f of p.files) args.push(f);
      const res = gh(args);
      return respond(res.ok
        ? { result: `Release ${p.tag} created.${res.text ? '\n' + res.text : ''}` }
        : { error: res.error });
    }

    case 'edit': {
      if (!p.tag) fail('tag is required for edit');
      const args = ['release', 'edit', p.tag, ...repoFlag(p.repo)];
      if (p.title) args.push('--title', p.title);
      if (p.notes) args.push('--notes', p.notes);
      if (p.draft !== undefined) args.push(p.draft ? '--draft' : '--draft=false');
      if (p.prerelease !== undefined) args.push(p.prerelease ? '--prerelease' : '--prerelease=false');
      const res = gh(args);
      return respond(res.ok ? { result: `Release ${p.tag} updated.` } : { error: res.error });
    }

    case 'delete': {
      if (!p.tag) fail('tag is required for delete');
      const res = gh(['release', 'delete', p.tag, ...repoFlag(p.repo), '--yes']);
      return respond(res.ok ? { result: `Release ${p.tag} deleted.` } : { error: res.error });
    }

    case 'upload': {
      if (!p.tag) fail('tag is required for upload');
      if (!p.files?.length) fail('files are required for upload');
      const args = ['release', 'upload', p.tag, ...repoFlag(p.repo), ...p.files, '--clobber'];
      const res = gh(args);
      return respond(res.ok ? { result: `Assets uploaded to release ${p.tag}.` } : { error: res.error });
    }

    case 'download': {
      if (!p.tag) fail('tag is required for download');
      const res = gh(['release', 'download', p.tag, ...repoFlag(p.repo)]);
      return respond(res.ok ? { result: `Assets from release ${p.tag} downloaded.` } : { error: res.error });
    }

    default:
      fail(`Unknown action: ${p.action}. Valid: list, view, create, edit, delete, upload, download`);
  }
}

function formatSize(bytes) {
  if (!bytes) return '0B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(1)}${units[i]}`;
}

main();
