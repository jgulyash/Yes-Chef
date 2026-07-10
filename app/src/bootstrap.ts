import { getDb, migrate, DB_PATH } from "./db.js";
import { seed, stapleCount, DEFAULT_HOUSEHOLD } from "./seed.js";
import { seedStores, storeCount } from "./stores.js";

// First-run bootstrap for the container: always ensure the schema is current (migrate
// is idempotent), and seed staples/stores ONLY when their tables are empty. Container
// restarts stay safe — your data (counts, events, learned aliases) is never wiped or
// duplicated on reboot.
const db = getDb();
migrate(db);

const existing = stapleCount(db, DEFAULT_HOUSEHOLD);
if (existing === 0) {
  seed(db);
  console.log(`Fresh database at ${DB_PATH}: seeded ${stapleCount(db)} staples.`);
} else {
  console.log(`Existing database at ${DB_PATH}: ${existing} staples already present, skipping seed.`);
}

const stores = storeCount(db, DEFAULT_HOUSEHOLD);
if (stores === 0) {
  const n = seedStores(db, DEFAULT_HOUSEHOLD);
  if (n) console.log(`Seeded ${n} stores from stores.json.`);
} else {
  console.log(`${stores} stores already present, skipping store seed.`);
}
