// Private visitor counter for the site owner.
// Each browser gets a random id (no names, emails or IP addresses are stored). One row per browser per day.
// The owner's own browsers are left out of the numbers.
const { db } = require('./db');

const TZ = process.env.STATS_TZ || 'America/New_York';
const dayOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

// The owner is OWNER_USERNAME if set, otherwise the first account ever made.
function ownerId() {
  const name = process.env.OWNER_USERNAME;
  const row = name
    ? db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(name)
    : db.prepare('SELECT MIN(id) AS id FROM users').get();
  return row?.id ?? null;
}
const isOwner = (userId) => userId != null && userId === ownerId();

const VID = /^[a-z0-9-]{16,40}$/i;
function record(body, userId) {
  const vid = String(body?.vid || '');
  if (!VID.test(vid)) return;
  const now = Date.now();
  const day = dayOf(now);
  let ref = String(body?.ref || '').toLowerCase().replace(/[^a-z0-9.-]/g, '').slice(0, 60) || null;
  if (isOwner(userId)) db.prepare('INSERT OR IGNORE INTO owner_vids (vid, at) VALUES (?, ?)').run(vid, now);
  const had = db.prepare('SELECT user_id FROM visits WHERE day = ? AND vid = ?').get(day, vid);
  if (!had) db.prepare('INSERT INTO visits (day, vid, first_ts, ref, user_id) VALUES (?, ?, ?, ?, ?)').run(day, vid, now, ref, userId ?? null);
  else if (userId != null && had.user_id == null) db.prepare('UPDATE visits SET user_id = ? WHERE day = ? AND vid = ?').run(userId, day, vid);
}

function stats() {
  const owner = ownerId();
  // a browser counts as the owner's if it was ever used while logged in as the owner
  const notMe = `vid NOT IN (SELECT vid FROM owner_vids) AND (user_id IS NULL OR user_id IS NOT ?)`;
  const now = Date.now();
  const since = (n) => dayOf(now - (n - 1) * 864e5);
  const uniq = (fromDay) => db.prepare(`SELECT COUNT(DISTINCT vid) AS n FROM visits WHERE day >= ? AND ${notMe}`).get(fromDay, owner).n;
  const days = [];
  const firstSeen = new Map(db.prepare(`SELECT vid, MIN(day) AS d FROM visits WHERE ${notMe} GROUP BY vid`).all(owner).map((r) => [r.vid, r.d]));
  const perDay = db.prepare(`SELECT day, vid FROM visits WHERE day >= ? AND ${notMe}`).all(since(14), owner);
  for (let i = 13; i >= 0; i--) {
    const d = dayOf(now - i * 864e5);
    const rows = perDay.filter((r) => r.day === d);
    days.push({ day: d, visitors: rows.length, new: rows.filter((r) => firstSeen.get(r.vid) === d).length });
  }
  const refs = db.prepare(`SELECT ref, COUNT(DISTINCT vid) AS n FROM visits WHERE ref IS NOT NULL AND ${notMe} GROUP BY ref ORDER BY n DESC LIMIT 6`).all(owner);
  const signups = db.prepare('SELECT username, created_at AS at FROM users WHERE id IS NOT ? ORDER BY id DESC').all(owner);
  const firstDay = db.prepare('SELECT MIN(day) AS d FROM visits').get().d;
  return {
    since: firstDay, today: uniq(since(1)), last7: uniq(since(7)), last30: uniq(since(30)), allTime: firstSeen.size,
    signups: signups.length, recentSignups: signups.slice(0, 8), days, refs,
  };
}

module.exports = { record, stats, isOwner };
