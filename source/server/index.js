'use strict';

const { definePlugin } = require('trek-plugin-sdk');
const { initialize, handle, tripAction, respond, deleteUserData, exportUserData } = require('./service.cjs');

const endpoints = [
  ['GET', '/notes', 'list'], ['GET', '/folders', 'folders'], ['GET', '/reference', 'reference'], ['GET', '/note', 'read'],
  ['POST', '/save', 'save'], ['POST', '/trip-intent', 'trip_intent'], ['POST', '/trip-note', 'trip_note'],
  ['POST', '/archive', 'archive'], ['POST', '/link', 'link'], ['GET', '/public', 'public'], ['GET', '/asset', 'asset'],
  ['POST', '/upload', 'upload'], ['GET', '/collaborators', 'collaborators'], ['POST', '/collaborator', 'collaborator'],
  ['GET', '/trips', 'trips'], ['POST', '/folder', 'folder'],
  ['POST', '/trip', 'trip'], ['POST', '/collab', 'collab'], ['POST', '/note-settings', 'note_settings'],
];

module.exports = definePlugin({
  onLoad: initialize,
  routes: endpoints.map(([method, path, action]) => ({
    method, path, auth: true,
    handler: (req, ctx) => respond(() => handle(action, req, ctx)),
  })),
  exports: {
    // Only trip-scoped operations are exposed. No caller-supplied user identity is trusted.
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
