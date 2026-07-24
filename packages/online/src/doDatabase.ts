import type { DatabaseSync } from "node:sqlite";

/** node:sqlite DatabaseSync facade over Durable Object SQLite.
 *
 * The server's stores and routes only touch prepare().get/.all/.run, exec, and
 * close, always with positional (?) parameters, so this shim covers exactly
 * that surface. Explicit BEGIN/COMMIT/ROLLBACK are forbidden by DO SQLite and
 * become no-ops: synchronous statement runs inside a single DO event are
 * already atomic, and withImmediateTransaction() prefers the transactionSync
 * method this shim exposes.
 */
export function doDatabase(storage: DurableObjectStorage): DatabaseSync {
  const sql = storage.sql;

  const isNoopStatement = (text: string): boolean => /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(text);

  // node:sqlite callers hand blobs over as Uint8Array; DO SQLite wants ArrayBuffer.
  const bind = (params: unknown[]): never[] =>
    params.map((param) =>
      param instanceof Uint8Array
        ? param.buffer.slice(param.byteOffset, param.byteOffset + param.byteLength)
        : param,
    ) as never[];

  const shim = {
    exec(text: string): void {
      if (isNoopStatement(text)) return;
      sql.exec(text);
    },
    prepare(text: string) {
      return {
        get(...params: unknown[]): unknown {
          return sql.exec(text, ...bind(params)).toArray()[0];
        },
        all(...params: unknown[]): unknown[] {
          return sql.exec(text, ...bind(params)).toArray();
        },
        run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
          const cursor = sql.exec(text, ...bind(params));
          cursor.toArray();
          const rowid = sql.exec("SELECT last_insert_rowid() AS id").one() as { id: number };
          return { changes: cursor.rowsWritten, lastInsertRowid: rowid.id };
        },
      };
    },
    transactionSync<T>(work: () => T): T {
      return storage.transactionSync(work);
    },
    close(): void {},
  };

  return shim as unknown as DatabaseSync;
}
