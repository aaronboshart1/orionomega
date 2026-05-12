#!/usr/bin/env node
/**
 * Compass handler — manage components, relationships, labels, types, custom fields.
 * Maps actions to Atlassian Rovo MCP Server Compass tool names.
 * Note: Compass tools require OAuth 2.1 authentication.
 */
import { mcpCall, readParams, respond, fail, truncate, cleanArgs, isProductEnabled, getMaxResults, getCloudId } from './lib.js';

const ACTION_MAP = {
  get_component:           'getCompassComponent',
  list_components:         'getCompassComponents',
  create_component:        'createCompassComponent',
  get_activity:            'getCompassComponentActivityEvents',
  get_labels:              'getCompassComponentLabels',
  get_types:               'getCompassComponentTypes',
  get_custom_fields:       'getCompassCustomFieldDefinitions',
  get_my_team_components:  'getCompassComponentsOwnedByMyTeams',
  create_relationship:     'createCompassComponentRelationship',
  create_custom_field:     'createCompassCustomFieldDefinition',
};

async function main() {
  if (!isProductEnabled('compass')) {
    fail('Compass is not enabled. Go to Settings → Skills → Atlassian → Enable Compass. Note: Compass requires OAuth 2.1 authentication.');
  }

  const p = await readParams();
  if (!p.action) fail('action is required');

  const toolName = ACTION_MAP[p.action];
  if (!toolName) {
    fail(`Unknown Compass action "${p.action}". Valid: ${Object.keys(ACTION_MAP).join(', ')}`);
  }

  const args = buildArgs(p);
  const res = await mcpCall(toolName, args);

  if (!res.ok) return respond({ error: res.error });
  return respond({ result: truncate(res.result) });
}

function buildArgs(p) {
  const cloudId = getCloudId(p.cloud_id);

  switch (p.action) {
    case 'get_component':
      if (!p.component_id) fail('component_id is required for get_component');
      return cleanArgs({ componentId: p.component_id, cloudId });

    case 'list_components':
      return cleanArgs({ query: p.query, type: p.type, cloudId });

    case 'create_component':
      if (!p.name) fail('name is required for create_component');
      return cleanArgs({
        name: p.name,
        type: p.type,
        cloudId,
        ...p.fields,
      });

    case 'get_activity':
      if (!p.component_id) fail('component_id is required for get_activity');
      return cleanArgs({ componentId: p.component_id, cloudId });

    case 'get_labels':
      if (!p.component_id) fail('component_id is required for get_labels');
      return cleanArgs({ componentId: p.component_id, cloudId });

    case 'get_types':
      return cleanArgs({ cloudId });

    case 'get_custom_fields':
      return cleanArgs({ cloudId });

    case 'get_my_team_components':
      return cleanArgs({ cloudId });

    case 'create_relationship':
      if (!p.source_id) fail('source_id is required for create_relationship');
      if (!p.target_id) fail('target_id is required for create_relationship');
      return cleanArgs({
        sourceComponentId: p.source_id,
        targetComponentId: p.target_id,
        type: p.relationship_type,
        cloudId,
      });

    case 'create_custom_field':
      return cleanArgs({ cloudId, ...p.fields });

    default:
      return cleanArgs({ cloudId });
  }
}

main();
