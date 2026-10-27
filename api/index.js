// Vercel serverless entry point. vercel.json rewrites every /api/* request here;
// the pages in public/ are served directly by Vercel's CDN.
const config = require('../src/config');
const { open } = require('../src/db');
const { createApp } = require('../src/server');

let appPromise = null;

function getApp() {
  if (!config.databaseUrl) {
    return Promise.reject(new Error('DATABASE_URL is not set. Add your Supabase connection string in Vercel → Settings → Environment Variables.'));
  }
  // Without it, the public default secret would let anyone forge a staff login.
  if (!process.env.SESSION_SECRET) {
    return Promise.reject(new Error('SESSION_SECRET is not set. Add a long random value in Vercel → Settings → Environment Variables.'));
  }
  // Reused across requests while this instance stays warm
  appPromise ||= open().then(createApp);
  return appPromise;
}

module.exports = async (req, res) => {
  let app;
  try {
    app = await getApp();
  } catch (err) {
    appPromise = null; // retry on the next request
    console.error('Startup failed:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `Server is not configured correctly: ${err.message}` }));
    return;
  }
  return app(req, res);
};
