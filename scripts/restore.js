'use strict';

// Restores a backup made by scripts/backup.js into an EMPTY database (local or
// Supabase, depending on the same settings the app uses). It never overwrites
// existing data. For local data, stop the app first.
// Usage: npm run restore -- <path-to-backup-folder>

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { createFileStore } = require('../src/attachments');
const { importData, readDump } = require('./transfer');

async function restore(config, backupDir, { logger = console, db, fileStore } = {}) {
  const dump = readDump(backupDir);
  const ownDb = !db;
  if (ownDb) db = await openDatabase(config, logger);
  try {
    if (!fileStore) {
      fileStore = createFileStore(config);
      await fileStore.init();
    }
    const readFile = (name) => {
      const p = path.join(backupDir, 'files', path.basename(name));
      return fs.existsSync(p) ? fs.readFileSync(p) : null;
    };
    return await importData(db, fileStore, dump.tables, readFile);
  } finally {
    if (ownDb) await db.close();
  }
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: npm run restore -- <path-to-backup-folder>');
    process.exit(1);
  }
  restore(loadConfig(), path.resolve(dir)).then((r) => {
    console.log(`Restored from ${dir}. Rows: ${JSON.stringify(r.counts)}; files: ${r.files}`);
  }).catch((err) => { console.error(`Restore failed: ${err.message}`); process.exit(1); });
}

module.exports = { restore };
