'use strict';

const { definePlugin } = require('trek-plugin-sdk');

module.exports = definePlugin({
  routes: [{
    method: 'POST', path: '/trip', auth: true,
    async handler(req, ctx) {
      if (!req.user) return { status: 401, body: JSON.stringify({ error: 'Sign in first.' }) };
      const body = req.body?.action === 'begin_note' ? { ...req.body, actor_id: req.user.id } : req.body;
      return ctx.plugins.call('fieldnotes', 'trip', body);
    },
  }],
});
