import { openDbUnchecked } from './index.js';
import { migrate, MigrationBlocked } from './migrations.js';
import { config } from '../config.js';

const db = openDbUnchecked(config.dbPath);

try {
  const result = migrate(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);

  console.log(`Schema applied to ${config.dbPath}`);
  console.log(`Tables: ${tables.join(', ')}`);
  if (result.action === 'rebuilt') {
    console.log(
      `\nUpgraded from the pre-expansion schema to version ${result.version} ` +
        '(55-item National Certificate template support). The database had no ' +
        'real submissions or results, so old demo/draft tables were dropped and recreated.',
    );
  } else if (result.action === 'stamped') {
    console.log(`\nSchema already matched version ${result.version}; recorded it in schema_meta.`);
  } else {
    console.log(`\nAlready at version ${result.version}; nothing to do.`);
  }
} catch (err) {
  if (err instanceof MigrationBlocked) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
} finally {
  db.close();
}
