import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2];

if (!dbPath) {
  console.error('Usage: node --experimental-sqlite tools/inspect-sqlite.js <sqlite-file>');
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db
  .prepare("select name, sql from sqlite_master where type = 'table' order by name")
  .all();

for (const row of rows) {
  console.log(row.name);
  console.log(row.sql);
  console.log('---');
}

db.close();
