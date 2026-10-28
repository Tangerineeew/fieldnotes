'use strict';

// Every id Fieldnotes mints (notes, folders, uploads, comments, request parts) comes from randomUUID; patterns that hold one
// build on this source.
const UUID = '[0-9a-f-]{36}';

// A JSON list stored in a row (tags, properties, editors); anything unreadable counts as empty.
const parseList = (json) => {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};

// People are named in editor lists, cursors and version history; each name costs a host call, so it is read once and kept.
const names = new Map();
async function personName(ctx, userId) {
  if (!names.has(userId)) {
    const user = await ctx.users.getById(userId).catch(() => null);
    names.set(userId, user?.display_name || user?.username || `#${userId}`);
  }
  return names.get(userId);
}

module.exports = { UUID, parseList, personName };
