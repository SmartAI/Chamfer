import type { DatabaseSync } from "node:sqlite";

const activeTransactions = new WeakSet<object>();

export function withImmediateTransaction<T>(db: DatabaseSync, work: () => T): T {
  if (activeTransactions.has(db as object) || (db as { isTransaction?: boolean }).isTransaction === true) return work();
  // Durable Object SQLite forbids explicit BEGIN/COMMIT; its handle exposes
  // transactionSync instead, which the shim surfaces here.
  const transactionSync = (db as { transactionSync?: <R>(fn: () => R) => R }).transactionSync;
  const guarded = (): T => {
    activeTransactions.add(db as object);
    try {
      return work();
    } finally {
      activeTransactions.delete(db as object);
    }
  };
  if (transactionSync) return transactionSync(guarded);
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = guarded();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
