'use strict';

// Creates a consistent snapshot of the database (VACUUM INTO works while the
// app is running) plus a copy of all uploaded files.
// Usage: npm run backup [-- <backup-root>]   (default: ./backups)

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { loadConfig, ROOT } = require('../src/config');

function backup(config, backupRoot) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupRoot, `backup-${stamp}`);
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });

  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(path.join(dest, 'app.db'));
  } finally {
    db.close();
  }
  if (fs.existsSync(config.uploadDir)) {
    fs.cpSync(config.uploadDir, path.join(dest, 'uploads'), { recursive: true });
  }
  const files = fs.existsSync(path.join(dest, 'uploads'))
    ? fs.readdirSync(path.join(dest, 'uploads'), { recursive: true }).filter((f) => /[a-f0-9]{48}$/.test(f)).length
    : 0;
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), files }, null, 2));
  return dest;
}

if (require.main === module) {
  const config = loadConfig();
  const root = path.resolve(process.argv[2] || path.join(ROOT, 'backups'));
  const dest = backup(config, root);
  console.log(`Backup written to ${dest}`);
}

module.exports = { backup };
