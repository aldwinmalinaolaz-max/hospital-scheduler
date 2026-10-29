const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const config = require('./config');
const dbModule = require('./db');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const { runReminders, startReminderScheduler } = require('./reminders');

function cronAuthorized(req) {
  if (!config.cronSecret) return false;
  const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.query.key || '');
  const a = Buffer.from(given);
  const b = Buffer.from(config.cronSecret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createApp(db) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // Map uploads carry an image, so they get a larger body limit (set on that route); everything else stays small
  const smallJson = express.json({ limit: '100kb' });
  app.use((req, res, next) => (req.path.startsWith('/api/admin/maps') ? next() : smallJson(req, res, next)));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (req.path.startsWith('/api/') && !/^\/api\/maps\/\d+\/image$/.test(req.path)) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Called by an external scheduler (e.g. cron-job.org) every few minutes when hosted on Vercel
  app.get('/api/cron/reminders', async (req, res) => {
    if (!config.cronSecret) return res.status(503).json({ error: 'CRON_SECRET is not configured.' });
    if (!cronAuthorized(req)) return res.status(401).json({ error: 'Unauthorized.' });
    res.json({ ok: true, sent: await runReminders(db) });
  });

  app.use('/api/admin', adminRoutes(db));
  app.use('/api', publicRoutes(db));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  // On Vercel, static files are served by the CDN and never reach this function.
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof publicRoutes.ValidationError) return res.status(400).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The upload is too large.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  return app;
}

if (require.main === module) {
  (async () => {
    const db = await dbModule.open();
    createApp(db).listen(config.port, () => {
      console.log(`${config.hospitalName} scheduler running on http://localhost:${config.port}`);
      console.log(`Admin panel: http://localhost:${config.port}/admin  (SMS provider: ${config.sms.provider})`);
      console.log(`Database: ${config.databaseUrl ? 'Postgres (DATABASE_URL)' : `embedded, stored in ${config.localDataDir}`}`);
    });
    startReminderScheduler(db);
  })().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}

module.exports = { createApp };
