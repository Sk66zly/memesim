// Database setup — uses Node's built-in SQLite (no installs needed).
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'memesim.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// Table layout. Also used to create the same tables in the Turso cloud copy (see cloud.js).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  usd           REAL NOT NULL DEFAULT 0,      -- mock USD cash
  sol           REAL NOT NULL DEFAULT 0,      -- mock SOL balance
  net_deposits  REAL NOT NULL DEFAULT 0,      -- USD value of everything ever credited (start + faucet)
  faucet_at     INTEGER NOT NULL DEFAULT 0    -- last faucet claim (ms)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  address       TEXT PRIMARY KEY,
  symbol        TEXT,
  name          TEXT,
  image         TEXT,
  pair_address  TEXT,
  last_price    REAL,
  updated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS positions (
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token            TEXT NOT NULL,
  qty              REAL NOT NULL DEFAULT 0,
  cost_usd         REAL NOT NULL DEFAULT 0,   -- remaining cost basis in USD
  opened_at        INTEGER NOT NULL,          -- when this position went from 0 to >0
  last_buy_at      INTEGER NOT NULL,
  sold_since_open  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, token)
);

CREATE TABLE IF NOT EXISTS trades (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token         TEXT NOT NULL,
  symbol        TEXT,
  side          TEXT NOT NULL,              -- 'buy' | 'sell'
  qty           REAL NOT NULL,
  price         REAL NOT NULL,
  usd_value     REAL NOT NULL,
  currency      TEXT NOT NULL,              -- 'USD' | 'SOL'
  sol_price     REAL,
  pnl_usd       REAL,
  pnl_pct       REAL,
  ts            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_user_ts ON trades(user_id, ts);
CREATE INDEX IF NOT EXISTS trades_ts ON trades(ts);

-- Account value snapshots (every SNAPSHOT_MINUTES). profit = value - net_deposits.
CREATE TABLE IF NOT EXISTS snapshots (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ts            INTEGER NOT NULL,
  value         REAL NOT NULL,
  net_deposits  REAL NOT NULL,
  profit        REAL NOT NULL,
  PRIMARY KEY (user_id, ts)
);

CREATE TABLE IF NOT EXISTS badges (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge      TEXT NOT NULL,
  earned_at  INTEGER NOT NULL,
  detail     TEXT,
  PRIMARY KEY (user_id, badge)
);
`;
db.exec(SCHEMA);

// Primary key of every table; cloud.js uses these to copy rows to Turso.
const TABLES = {
  users: ['id'],
  sessions: ['token_hash'],
  tokens: ['address'],
  positions: ['user_id', 'token'],
  trades: ['id'],
  snapshots: ['user_id', 'ts'],
  badges: ['user_id', 'badge'],
};

// Small helper so multi-step writes either fully happen or not at all.
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, tx, DATA_DIR, SCHEMA, TABLES };
