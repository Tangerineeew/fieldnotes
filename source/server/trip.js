'use strict';

const { definePlugin } = require('trek-plugin-sdk');

// TREK's frame bridge drops the body of any non-200 answer, so a refusal travels as Fieldnotes' own 200 envelope (see respond in
// service.cjs) and the page shows it translated.
const signIn = { error: 'Sign in first.', status: 401, template: 'Sign in first.', params: {} };

module.exports = definePlugin({
  routes: [{
    method: 'POST', path: '/trip', auth: true,
    async handler(req, ctx) {
      if (!req.user) return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(signIn) };
      // Fieldnotes records who wrote, edited or created something from this stamp, never from the page's own fields.
      return ctx.plugins.call('fieldnotes', 'trip', { ...req.body, actor_id: req.user.id });
    },
  }],
});
