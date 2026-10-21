'use strict';

const { loadConfig } = require('./config');
const { createApp } = require('./app');

async function main() {
  const config = loadConfig();
  const app = await createApp(config);
  const storage = app.locals.fileStore.kind === 'supabase' ? 'Supabase Storage' : 'local disk';
  const database = config.databaseUrl ? 'Postgres (DATABASE_URL)' : 'local PGlite';

  const server = app.listen(config.port, () => {
    console.log(`Shared Expenses running at http://localhost:${config.port} (database: ${database}; files: ${storage})`);
  });

  function shutdown() {
    server.close(async () => {
      await app.locals.db.close();
      process.exit(0);
    });
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
