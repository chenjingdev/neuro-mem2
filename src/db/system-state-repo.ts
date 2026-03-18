/**
 * Repository for system_state KV table.
 *
 * Provides typed get/set/increment operations for global system state.
 * All operations are synchronous (better-sqlite3).
 */

import type Database from 'better-sqlite3';

export class SystemStateRepository {
  private stmtGet: Database.Statement<[string]>;
  private stmtUpsert: Database.Statement<[string, string]>;
  private stmtIncrement: Database.Statement<[string, string]>;

  constructor(private db: Database.Database) {
    this.stmtGet = db.prepare(
      'SELECT value FROM system_state WHERE key = ?'
    );

    this.stmtUpsert = db.prepare(`
      INSERT INTO system_state (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);

    // Atomic increment: reads current value, adds delta, stores back
    // Uses COALESCE to default to '0' if key doesn't exist yet
    this.stmtIncrement = db.prepare(`
      INSERT INTO system_state (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = CAST(CAST(system_state.value AS REAL) + CAST(excluded.value AS REAL) AS TEXT),
        updated_at = excluded.updated_at
    `);
  }

  /**
   * Get a string value by key. Returns null if key doesn't exist.
   */
  getString(key: string): string | null {
    const row = this.stmtGet.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Get a numeric value by key. Returns 0.0 if key doesn't exist.
   */
  getNumber(key: string): number {
    const raw = this.getString(key);
    if (raw === null) return 0.0;
    const parsed = parseFloat(raw);
    return isNaN(parsed) ? 0.0 : parsed;
  }

  /**
   * Set a string value for a key (upsert).
   */
  set(key: string, value: string): void {
    this.stmtUpsert.run(key, value);
  }

  /**
   * Set a numeric value for a key (upsert).
   */
  setNumber(key: string, value: number): void {
    this.set(key, String(value));
  }

  /**
   * Atomically increment a numeric value by delta.
   * If the key doesn't exist, initializes to delta.
   * Returns the new value after increment.
   */
  increment(key: string, delta: number): number {
    this.stmtIncrement.run(key, String(delta));
    return this.getNumber(key);
  }

  /**
   * Delete a key. Returns true if a row was deleted.
   */
  delete(key: string): boolean {
    const result = this.db.prepare('DELETE FROM system_state WHERE key = ?').run(key);
    return result.changes > 0;
  }

  /**
   * Get all key-value pairs. Useful for debugging/diagnostics.
   */
  getAll(): Array<{ key: string; value: string; updatedAt: string }> {
    const rows = this.db.prepare(
      'SELECT key, value, updated_at FROM system_state ORDER BY key'
    ).all() as Array<{ key: string; value: string; updated_at: string }>;
    return rows.map(r => ({
      key: r.key,
      value: r.value,
      updatedAt: r.updated_at,
    }));
  }
}
