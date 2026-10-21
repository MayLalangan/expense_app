'use strict';

// Copies the whole database and all receipts to a folder on this computer.
// Uses the same settings as the app: with DATABASE_URL / SUPABASE_* set (for
// example in a local .env file) it backs up the live Supabase data; otherwise
// the local development data.
// Usage: npm run backup [-- <backup-root>]   (default: ./backups)

const path = require('node:path');
const { loadConfig, ROOT } = require('../src/config');
const { openDatabase } = require('../src/db');
const { createFileStore } = require('../src/attachments');
const { exportData } = require('./transfer');

/** `db`/`fileStore` may be passed in (tests, or a running app); otherwise they are opened from config. */
async function backup(config, backupRoot, { logger = console, db, fileStore } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupRoot, `backup-${stamp}`);
  const ownDb = !db;
  if (ownDb) db = await openDatabase(config, logger);
  try {
    const manifest = await exportData(db, fileStore || createFileStore(config), dest);
    return { dest, manifest };
  } finally {
    if (ownDb) await db.close();
  }
}

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(ROOT, 'backups'));
  backup(loadConfig(), root).then(({ dest, manifest }) => {
    console.log(`Backup written to ${dest}`);
    console.log(`Rows: ${JSON.stringify(manifest.counts)}; files: ${manifest.files}`);
    if (manifest.missing.length) console.warn(`Warning: ${manifest.missing.length} attachment file(s) were missing from storage.`);
  }).catch((err) => { console.error(`Backup failed: ${err.message}`); process.exit(1); });
}

module.exports = { backup };
