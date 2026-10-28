'use strict';

const { definePlugin } = require('trek-plugin-sdk');
const { initialize, handle, tripAction, respond, deleteUserData, exportUserData } = require('./service.cjs');

const endpoints = [
  ['GET', '/notes', 'list'], ['GET', '/folders', 'folders'], ['GET', '/reference', 'reference'], ['GET', '/note', 'read'],
  ['POST', '/save', 'save'], ['POST', '/trip-intent', 'trip_intent'], ['POST', '/trip-note', 'trip_note'],
  ['POST', '/archive', 'archive'], ['POST', '/link', 'link'], ['GET', '/public', 'public'], ['GET', '/asset', 'asset'],
  ['POST', '/upload', 'upload'], ['GET', '/collaborators', 'collaborators'], ['POST', '/collaborator', 'collaborator'],
  ['GET', '/trips', 'trips'], ['POST', '/folder', 'folder'],
  ['GET', '/link-targets', 'link_targets'], ['GET', '/backlinks', 'backlinks'], ['GET', '/link-access', 'link_access'],
  ['POST', '/link-grant', 'link_grant'], ['POST', '/link-mentions', 'link_mentions'],
  ['GET', '/history', 'history'], ['GET', '/version', 'version'], ['POST', '/restore', 'restore'],
  ['POST', '/trip', 'trip'], ['POST', '/collab', 'collab'], ['POST', '/note-settings', 'note_settings'], ['POST', '/part', 'part'],
  ['GET', '/deleted', 'deleted'], ['POST', '/deleted', 'deleted_action'], ['POST', '/assets', 'assets'],
];

module.exports = definePlugin({
  onLoad: initialize,
  routes: endpoints.map(([method, path, action]) => ({
    method, path, auth: true,
    handler: (req, ctx) => respond(() => handle(action, req, ctx)),
  })),
  exports: {
    // Only trip-scoped operations are exposed. The companion stamps `actor_id` from its signed-in request; it is accepted only
    // for a member of the trip the acting user can open, and links stay tied to the authenticated Fieldnotes route.
    trip: (args, ctx) => respond(() => tripAction(args, ctx)),
  },
  hooks: {
    mcpToolProvider: {
      tools: ['list_trip_notes'],
      callTool: ({ args }, ctx) => tripAction({ trip_id: args.trip_id, action: 'list' }, ctx),
    },
  },
  deleteUserData: ({ userId }, ctx) => deleteUserData(ctx, userId),
  exportUserData: ({ userId }, ctx) => exportUserData(ctx, userId),
});
