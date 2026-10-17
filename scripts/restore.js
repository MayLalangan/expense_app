'use strict';

// Restores a backup made by scripts/backup.js. Stop the app first.
// The current data directory is moved aside (never deleted).
// Usage: npm run restore -- <path-to-backup-folder>

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { loadConfig } = require('../src/config');

function restore(config, backupDir) {
  const dbFile = path.join(backupDir, 'app.db');
  if (!fs.existsSync(dbFile)) throw new Error(`No app.db found in ${backupDir}`);

  // Refuse to restore a corrupt snapshot.
  const check = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const result = check.prepare('PRAGMA integrity_check').get();
    if (Object.values(result)[0] !== 'ok') throw new Error('Backup database failed integrity_check');
  } finally {
    check.close();
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let movedTo = null;
  if (fs.existsSync(config.dataDir)) {
    movedTo = `${config.dataDir}.before-restore-${stamp}`;
    fs.renameSync(config.dataDir, movedTo);
  }
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(dbFile, config.dbPath);
  const uploads = path.join(backupDir, 'uploads');
  if (fs.existsSync(uploads)) fs.cpSync(uploads, config.uploadDir, { recursive: true });
  return { movedTo };
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: npm run restore -- <path-to-backup-folder>');
    process.exit(1);
  }
  const { movedTo } = restore(loadConfig(), path.resolve(dir));
  console.log(`Restored from ${dir}.${movedTo ? ` Previous data kept at ${movedTo}` : ''}`);
}

module.exports = { restore };
