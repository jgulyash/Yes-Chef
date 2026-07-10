import { randomUUID } from "node:crypto";

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function daysBetween(fromIso: string, toIso: string): number {
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return ms / (1000 * 60 * 60 * 24);
}

// One dynamic-SET patch builder for every editable entity (food_item, store, ...).
// Column names come ONLY from the caller's const `patchable` list — never from input
// keys — so the SQL surface is fixed. Booleans coerce to SQLite 0/1.
export function patchRow<P extends object>(
  db: { prepare: (sql: string) => { run: (...args: (string | number | null)[]) => unknown } },
  table: string,
  patchable: readonly (keyof P & string)[],
  patch: P,
  where: { household_id: string; id: string }
): boolean {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const key of patchable) {
    if (key in patch) {
      sets.push(`${key} = ?`);
      const v = patch[key] as unknown;
      values.push(typeof v === "boolean" ? (v ? 1 : 0) : ((v as string | number | null) ?? null));
    }
  }
  if (!sets.length) return false;
  db.prepare(`UPDATE ${table} SET ${sets.join(", ")} WHERE household_id = ? AND id = ?`).run(
    ...values,
    where.household_id,
    where.id
  );
  return true;
}
