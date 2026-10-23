'use strict';

const { definePlugin } = require('trek-plugin-sdk');

module.exports = definePlugin({
  routes: [{
    method: 'POST', path: '/trip', auth: true,
    async handler(req, ctx) {
      if (!req.user) return { status: 401, body: JSON.stringify({ error: 'Sign in first.' }) };
      // Fieldnotes records who wrote, edited or created something from this stamp, never from the page's own fields.
      return ctx.plugins.call('fieldnotes', 'trip', { ...req.body, actor_id: req.user.id });
    },
  }],
});
