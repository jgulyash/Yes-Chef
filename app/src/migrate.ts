import { getDb, migrate, MIGRATIONS, DB_PATH } from "./db.js";

const applied = migrate(getDb());
console.log(
  `Migrated ${DB_PATH}: ${applied} of ${MIGRATIONS.length} migrations applied (${MIGRATIONS.length - applied} already in place).`
);
