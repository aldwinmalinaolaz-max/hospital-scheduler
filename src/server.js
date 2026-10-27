const path = require('node:path');
const express = require('express');
const config = require('./config');
const dbModule = require('./db');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const { startReminderScheduler } = require('./reminders');

function createApp(db) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.use('/api/admin', adminRoutes(db));
  app.use('/api', publicRoutes(db));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof publicRoutes.ValidationError) return res.status(400).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  return app;
}

if (require.main === module) {
  const db = dbModule.open();
  createApp(db).listen(config.port, () => {
    console.log(`${config.hospitalName} scheduler running on http://localhost:${config.port}`);
    console.log(`Admin panel: http://localhost:${config.port}/admin  (SMS provider: ${config.sms.provider})`);
  });
  startReminderScheduler(db);
}

module.exports = { createApp };
