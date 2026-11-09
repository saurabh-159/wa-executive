import sqlite3
from datetime import datetime, timezone, timedelta

con = sqlite3.connect("assistant.db")
con.row_factory = sqlite3.Row

total = con.execute("SELECT COUNT(*) c FROM messages").fetchone()["c"]
with_av = con.execute(
    "SELECT COUNT(*) c FROM messages WHERE avatar_url IS NOT NULL AND trim(avatar_url) != ''"
).fetchone()["c"]
print(f"total_messages={total} with_avatar={with_av}")

print("\n=== per chat counts (top 20) ===")
rows = con.execute(
    """
    SELECT sender_jid,
           MAX(sender_name) AS name,
           COUNT(*) AS n,
           SUM(CASE WHEN avatar_url IS NOT NULL AND trim(avatar_url)!='' THEN 1 ELSE 0 END) AS av,
           MIN(timestamp) AS tmin,
           MAX(timestamp) AS tmax
    FROM messages
    GROUP BY sender_jid
    ORDER BY n DESC
    LIMIT 20
    """
).fetchall()

now = datetime.now(timezone.utc)
for r in rows:
    tmin, tmax = r["tmin"], r["tmax"]
    # timestamps may be ms or sec
    def fmt(ts):
        if ts is None:
            return None
        ts = int(ts)
        if ts > 1_000_000_000_000:
            ts = ts / 1000
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()

    print(
        f"n={r['n']:4d} av={r['av']} | {r['name']!s:40s} | {r['sender_jid']} | {fmt(tmin)} -> {fmt(tmax)}"
    )

j = "919891519151"
print(f"\n=== detail for {j} ===")
for r in con.execute(
    """
    SELECT id, is_from_me, timestamp, substr(coalesce(text,''),1,100) AS t,
           substr(coalesce(avatar_url,''),1,60) AS av, media_type
    FROM messages
    WHERE sender_jid LIKE ?
    ORDER BY timestamp
    """,
    (f"%{j}%",),
):
    ts = int(r["timestamp"] or 0)
    if ts > 1_000_000_000_000:
        ts = ts / 1000
    print(datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(), "from_me=", r["is_from_me"], "av=", bool(r["av"]), r["t"])

print("\n=== contacts with avatar-like fields ===")
ccols = [x[1] for x in con.execute("PRAGMA table_info(contacts)")]
print("contact_cols", ccols)
