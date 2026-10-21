'use strict';

// Shared export/import used by backup, restore and the one-time SQLite import.
// A dump is a folder with data.json (all tables except sessions) and files/
// (one file per attachment, named by its storage name).

const fs = require('node:fs');
const path = require('node:path');
const { TABLES } = require('../src/db');

const FORMAT = 'shared-expenses-dump/1';

async function exportData(db, fileStore, destDir) {
  fs.mkdirSync(path.join(destDir, 'files'), { recursive: true, mode: 0o700 });
  const tables = {};
  for (const table of TABLES) tables[table] = await db.all(`SELECT * FROM ${table} ORDER BY id`);
  let files = 0;
  const missing = [];
  for (const a of tables.attachments) {
    const content = await fileStore.read(a.storage_name);
    if (!content) { missing.push(a.storage_name); continue; }
    fs.writeFileSync(path.join(destDir, 'files', a.storage_name), content, { mode: 0o600 });
    files += 1;
  }
  const manifest = { format: FORMAT, createdAt: new Date().toISOString(), counts: Object.fromEntries(TABLES.map((t) => [t, tables[t].length])), files, missing };
  fs.writeFileSync(path.join(destDir, 'data.json'), JSON.stringify({ ...manifest, tables }), { mode: 0o600 });
  return manifest;
}

function readDump(dir) {
  const file = path.join(dir, 'data.json');
  if (!fs.existsSync(file)) throw new Error(`No data.json found in ${dir}`);
  const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (dump.format !== FORMAT) throw new Error(`Unsupported dump format: ${dump.format}`);
  return dump;
}

/**
 * Loads a dump into an EMPTY database (refuses otherwise, so nothing is ever
 * overwritten), uploads its files, and resets id sequences.
 * `readFile(storageName)` returns the file's Buffer or null.
 */
async function importData(db, fileStore, tables, readFile) {
  const existing = (await db.get('SELECT COUNT(*) AS n FROM users')).n;
  if (existing) throw new Error('The target database already has data. Restore/import only into an empty database.');

  // Upload files first: a failed upload leaves the database untouched.
  let files = 0;
  for (const a of tables.attachments || []) {
    const content = readFile(a.storage_name);
    if (!content) throw new Error(`Missing file for attachment ${a.id} (${a.original_name}).`);
    if (!(await fileStore.read(a.storage_name))) await fileStore.put(a.storage_name, content, a.mime_type);
    files += 1;
  }

  await db.tx(async (db) => {
    for (const table of TABLES) {
      for (const row of tables[table] || []) {
        const cols = Object.keys(row);
        await db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
      }
      await db.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1),
                      (SELECT COUNT(*) > 0 FROM ${table}))`);
    }
  });
  return { counts: Object.fromEntries(TABLES.map((t) => [t, (tables[t] || []).length])), files };
}

module.exports = { exportData, importData, readDump, FORMAT };
