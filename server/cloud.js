// Cloud saving with Turso (free hosted SQLite).
//
// The game keeps using the fast local SQLite file. When TURSO_DATABASE_URL and TURSO_AUTH_TOKEN
// are set, this module:
//   1. on startup, copies everything from Turso into the local file (so a wiped server disk is fine),
//   2. records every changed row locally (with SQLite triggers) and copies those rows to Turso
//      about once a second,
//   3. finishes copying before the server shuts down.
// Each copy sends the row's full current values ("upsert"), so retrying after a network hiccup is
// always safe: sending the same row twice gives the same result.
const { db, SCHEMA, TABLES, ADDED_COLUMNS } = require('./db');

const RAW_URL = (process.env.TURSO_DATABASE_URL || '').trim();
const TOKEN = (process.env.TURSO_AUTH_TOKEN || '').trim();
const enabled = Boolean(RAW_URL && TOKEN);
const BASE = RAW_URL.replace(/^(libsql|turso|wss?):\/\//, 'https://').replace(/\/+$/, '');

let log = console.log;
const status = { enabled, lastSyncAt: 0, pending: 0, lastError: null, restoredRows: 0 };

// ---------- Turso HTTP API ----------
function toArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  if (v instanceof Uint8Array) return { type: 'blob', base64: Buffer.from(v).toString('base64') };
  return { type: 'text', value: String(v) };
}
function fromValue(v) {
  if (!v || v.type === 'null') return null;
  if (v.type === 'integer') return Number(v.value);
  if (v.type === 'float') return Number(v.value);
  if (v.type === 'blob') return Buffer.from(v.base64 || '', 'base64');
  return v.value;
}

class TursoError extends Error {
  constructor(message, { retryable }) { super(message); this.retryable = retryable; }
}

// Runs statements in order on one connection. stmts: [{ sql, args }]
async function pipeline(stmts) {
  let res;
  try {
    res = await fetch(`${BASE}/v2/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: [
          ...stmts.map((s) => ({ type: 'execute', stmt: { sql: s.sql, args: (s.args || []).map(toArg) } })),
          { type: 'close' },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new TursoError(`can't reach Turso (${e.cause?.code || e.message})`, { retryable: true });
  }
  if (res.status === 401 || res.status === 403) throw new TursoError(`Turso rejected the auth token (${res.status}). Check TURSO_AUTH_TOKEN.`, { retryable: false });
  if (res.status === 404) throw new TursoError('Turso database not found (404). Check TURSO_DATABASE_URL.', { retryable: false });
  if (!res.ok) throw new TursoError(`Turso returned ${res.status}`, { retryable: true });
  const json = await res.json();
  const results = json.results || [];
  const out = [];
  for (let i = 0; i < stmts.length; i++) {
    const r = results[i];
    if (!r || r.type !== 'ok') {
      throw new TursoError(`Turso SQL error: ${r?.error?.message || 'no result'} — in: ${stmts[i].sql.slice(0, 80)}`, { retryable: false });
    }
    const result = r.response?.result || {};
    const cols = (result.cols || []).map((c) => c.name);
    out.push((result.rows || []).map((row) => Object.fromEntries(row.map((v, j) => [cols[j], fromValue(v)]))));
  }
  return out;
}

// ---------- change tracking (local) ----------
function installTriggers() {
  db.exec(`CREATE TABLE IF NOT EXISTS _changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tbl TEXT NOT NULL,
    pk TEXT NOT NULL
  );`);
  for (const [tbl, pk] of Object.entries(TABLES)) {
    const newKey = `json_array(${pk.map((c) => `NEW.${c}`).join(', ')})`;
    const oldKey = `json_array(${pk.map((c) => `OLD.${c}`).join(', ')})`;
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS _sync_${tbl}_ins AFTER INSERT ON ${tbl}
        BEGIN INSERT INTO _changes (tbl, pk) VALUES ('${tbl}', ${newKey}); END;
      CREATE TRIGGER IF NOT EXISTS _sync_${tbl}_upd AFTER UPDATE ON ${tbl}
        BEGIN
          INSERT INTO _changes (tbl, pk) VALUES ('${tbl}', ${oldKey});
          INSERT INTO _changes (tbl, pk) SELECT '${tbl}', ${newKey} WHERE ${newKey} <> ${oldKey};
        END;
      CREATE TRIGGER IF NOT EXISTS _sync_${tbl}_del AFTER DELETE ON ${tbl}
        BEGIN INSERT INTO _changes (tbl, pk) VALUES ('${tbl}', ${oldKey}); END;
    `);
  }
}
function dropTriggers() {
  for (const tbl of Object.keys(TABLES)) {
    for (const op of ['ins', 'upd', 'del']) db.exec(`DROP TRIGGER IF EXISTS _sync_${tbl}_${op}`);
  }
}

const COLS = {};
function columnsOf(tbl) {
  if (!COLS[tbl]) COLS[tbl] = db.prepare(`PRAGMA table_info(${tbl})`).all().map((c) => c.name);
  return COLS[tbl];
}
function upsertSql(tbl) {
  const cols = columnsOf(tbl);
  const pk = TABLES[tbl];
  const updates = cols.filter((c) => !pk.includes(c));
  return `INSERT INTO ${tbl} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
          ON CONFLICT (${pk.join(', ')}) DO ${updates.length ? `UPDATE SET ${updates.map((c) => `${c} = excluded.${c}`).join(', ')}` : 'NOTHING'}`;
}
const where = (tbl) => TABLES[tbl].map((c) => `${c} = ?`).join(' AND ');

// ---------- push local changes to Turso ----------
let syncing = false;
let backoffUntil = 0;
let failStreak = 0;

async function pushChanges(max = 400) {
  const changes = db.prepare('SELECT id, tbl, pk FROM _changes ORDER BY id LIMIT ?').all(max);
  if (!changes.length) return 0;
  // one statement per changed row, carrying its current values (or a delete if it's gone)
  const seen = new Set();
  const stmts = [];
  for (const c of changes) {
    const key = c.tbl + c.pk;
    if (seen.has(key) || !TABLES[c.tbl]) continue;
    seen.add(key);
    const pkVals = JSON.parse(c.pk);
    const row = db.prepare(`SELECT * FROM ${c.tbl} WHERE ${where(c.tbl)}`).get(...pkVals);
    if (row) stmts.push({ sql: upsertSql(c.tbl), args: columnsOf(c.tbl).map((col) => row[col]) });
    else stmts.push({ sql: `DELETE FROM ${c.tbl} WHERE ${where(c.tbl)}`, args: pkVals });
  }
  await pipeline([{ sql: 'BEGIN' }, ...stmts, { sql: 'COMMIT' }]);
  db.prepare('DELETE FROM _changes WHERE id <= ?').run(changes[changes.length - 1].id);
  return changes.length;
}

async function syncNow({ all = false } = {}) {
  if (!enabled || syncing) return;
  if (Date.now() < backoffUntil && !all) return;
  syncing = true;
  try {
    let n;
    do { n = await pushChanges(); } while (n && all);
    if (failStreak) log(`Cloud save: reconnected to Turso, ${pending()} changes waiting.`);
    failStreak = 0;
    status.lastError = null;
    status.lastSyncAt = Date.now();
  } catch (e) {
    failStreak++;
    status.lastError = e.message;
    const wait = e.retryable ? Math.min(60_000, 1000 * 2 ** Math.min(failStreak, 6)) : 60_000;
    backoffUntil = Date.now() + wait;
    if (failStreak === 1 || failStreak % 10 === 0) log(`Cloud save failed (${e.message}). Retrying in ${Math.round(wait / 1000)}s; nothing is lost meanwhile.`);
  } finally {
    syncing = false;
    status.pending = pending();
  }
}
const pending = () => db.prepare('SELECT COUNT(*) AS n FROM _changes').get().n;

// ---------- startup ----------
// Create the tables in Turso, then load everything from Turso into the local file.
async function restore() {
  // Turso copy has no foreign keys, so rows can arrive in any order.
  const remoteSchema = SCHEMA.replace(/\s+REFERENCES\s+\w+\(\w+\)(\s+ON DELETE CASCADE)?/gi, '');
  const ddl = remoteSchema.split(';').map((s) => s.trim()).filter(Boolean).map((sql) => ({ sql }));
  await pipeline(ddl);
  // Bring older Turso copies up to date with columns added later (skips ones already there).
  const remoteCols = await pipeline(ADDED_COLUMNS.map(([t]) => ({ sql: `PRAGMA table_info(${t})` })));
  for (let i = 0; i < ADDED_COLUMNS.length; i++) {
    const [t, col, type] = ADDED_COLUMNS[i];
    if (!remoteCols[i].some((r) => r.name === col)) await pipeline([{ sql: `ALTER TABLE ${t} ADD COLUMN ${col} ${type}` }]);
  }

  // If this machine still has unsent changes from last time (e.g. a PC restart), send them first.
  if (pending()) { log(`Cloud save: sending ${pending()} changes left from last run…`); let n; do { n = await pushChanges(); } while (n); }

  const tables = Object.keys(TABLES);
  const results = await pipeline(tables.map((t) => ({ sql: `SELECT * FROM ${t}` })));
  dropTriggers();
  db.exec('PRAGMA foreign_keys = OFF; BEGIN');
  try {
    let total = 0;
    tables.forEach((t, i) => {
      db.exec(`DELETE FROM ${t}`);
      const cols = columnsOf(t);
      const ins = db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const row of results[i]) { ins.run(...cols.map((c) => row[c] ?? null)); total++; }
    });
    db.exec('DELETE FROM _changes; COMMIT');
    status.restoredRows = total;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
    installTriggers();
  }
}

async function start(logger = console.log) {
  log = logger;
  if (!enabled) {
    log('Cloud save: off (set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to keep data in Turso). Saving to the local disk only.');
    return;
  }
  installTriggers();
  for (let attempt = 1; ; attempt++) {
    try {
      await restore();
      log(`Cloud save: ON — loaded ${status.restoredRows} rows from Turso (${new URL(BASE).host}).`);
      break;
    } catch (e) {
      if (!e.retryable || attempt >= 5) {
        // Starting without the saved data would make players think their accounts vanished, so stop.
        log(`Cloud save: could not load data from Turso — ${e.message}`);
        throw e;
      }
      log(`Cloud save: Turso not reachable yet (${e.message}), retrying… (${attempt}/5)`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  setInterval(() => syncNow(), 1000);

  // Copy any last changes before the host shuts the server down.
  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: saving last changes to Turso…`);
    const deadline = Date.now() + 20_000;
    while (pending() && Date.now() < deadline) {
      backoffUntil = 0;
      await syncNow({ all: true });
      if (pending()) await new Promise((r) => setTimeout(r, 500));
    }
    log(pending() ? `Exiting with ${pending()} changes not saved to Turso.` : 'All changes saved to Turso. Bye!');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { start, status, syncNow, enabled };
