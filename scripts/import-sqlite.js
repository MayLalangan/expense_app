'use strict';

// One-time move of data from the old SQLite version of the app (data/app.db +
// data/uploads) into the current database and file storage: the local
// development database by default, or Supabase when DATABASE_URL / SUPABASE_*
// are set. The target must be empty. The SQLite file is only read, never changed.
// Usage: npm run import-sqlite [-- <path-to-app.db> [<path-to-uploads-dir>]]

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { loadConfig } = require('../src/config');
const { openDatabase, TABLES } = require('../src/db');
const { createFileStore } = require('../src/attachments');
const { importData } = require('./transfer');

function readSqlite(file) {
  if (!fs.existsSync(file)) throw new Error(`SQLite file not found: ${file}`);
  const lite = new DatabaseSync(file, { readOnly: true });
  try {
    const applied = lite.prepare('SELECT MAX(id) AS v FROM schema_migrations').get().v;
    if (applied !== 3) throw new Error(`Expected the final SQLite schema (migration 3), found ${applied}.`);
    const tables = {};
    for (const table of TABLES) tables[table] = lite.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((r) => ({ ...r }));
    return tables;
  } finally {
    lite.close();
  }
}

async function importSqlite(config, sqliteFile, uploadsDir, { logger = console, db, fileStore } = {}) {
  const tables = readSqlite(sqliteFile);
  const ownDb = !db;
  if (ownDb) db = await openDatabase(config, logger);
  try {
    if (!fileStore) {
      fileStore = createFileStore(config);
      await fileStore.init();
    }
    const readFile = (name) => {
      const p = path.join(uploadsDir, name.slice(0, 2), path.basename(name));
      return fs.existsSync(p) ? fs.readFileSync(p) : null;
    };
    return await importData(db, fileStore, tables, readFile);
  } finally {
    if (ownDb) await db.close();
  }
}

if (require.main === module) {
  const config = loadConfig();
  const file = path.resolve(process.argv[2] || config.legacySqlitePath);
  const uploads = path.resolve(process.argv[3] || path.join(path.dirname(file), 'uploads'));
  importSqlite(config, file, uploads).then((r) => {
    console.log(`Imported from ${file}. Rows: ${JSON.stringify(r.counts)}; files: ${r.files}`);
  }).catch((err) => { console.error(`Import failed: ${err.message}`); process.exit(1); });
}

module.exports = { importSqlite, readSqlite };
