/**
 * Schema for the system_state key-value table.
 *
 * Stores global system state such as the global event counter
 * used for event-based shield+weight decay calculations.
 *
 * This is a simple KV store where keys are unique identifiers
 * and values are stored as TEXT (serialized JSON or plain strings).
 */

export const CREATE_SYSTEM_STATE_TABLE = `
-- System state key-value store
CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
