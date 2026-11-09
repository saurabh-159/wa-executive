import sqlite3
import os

# Check current directory and parent directory for SQLite files
db_candidates = [
    "database.sqlite",
    "../database.sqlite",
    "../worker/database.sqlite",
    "../worker/baileys.sqlite",
    "assistant.db"
]

db_path = None
for candidate in db_candidates:
    if os.path.exists(candidate):
        db_path = candidate
        break

if not db_path:
    print("❌ Koi SQLite file nahi mili! Folder path check karein.")
    exit(1)

print(f"📂 [DIAGNOSTIC] Checking Database at: {os.path.abspath(db_path)}\n")
conn = sqlite3.connect(db_path)
c = conn.cursor()

# 1. Tables check
tables = [t[0] for t in c.execute("SELECT name FROM sqlite_master WHERE type='table';").fetchall()]
print(f"📊 Available Tables: {tables}")

# 2. Check contacts table
if "contacts" in tables:
    columns = [col[1] for col in c.execute("PRAGMA table_info(contacts);").fetchall()]
    print(f"\n📋 'contacts' Table Columns: {columns}")
    
    total_contacts = c.execute("SELECT count(*) FROM contacts;").fetchone()[0]
    named_contacts = c.execute("SELECT count(*) FROM contacts WHERE name IS NOT NULL AND trim(name) != '';").fetchone()[0]
    notified_contacts = c.execute("SELECT count(*) FROM contacts WHERE notify_name IS NOT NULL AND trim(notify_name) != '';").fetchone()[0]
    
    print(f"📈 Total Contacts: {total_contacts}")
    print(f"🏷️ Contacts with saved 'name' (Phonebook): {named_contacts}")
    print(f"💬 Contacts with 'notify_name' (PushName): {notified_contacts}")
    
    print("\n🔍 Sample Rows (Top 5):")
    sample_rows = c.execute("SELECT * FROM contacts LIMIT 5;").fetchall()
    for row in sample_rows:
        print("  ", row)

    print("\n🎯 Specific Targets Check (+91 96548 96725 / +91 81473 55905):")
    targets = c.execute(
        "SELECT * FROM contacts WHERE jid LIKE '%9654896725%' OR jid LIKE '%8147355905%';"
    ).fetchall()
    print("   Result:", targets if targets else "Row hi nahi mili (Not Found)")
else:
    print("❌ 'contacts' table is missing!")

# 3. Check messages table sender names
if "messages" in tables:
    msg_cols = [col[1] for col in c.execute("PRAGMA table_info(messages);").fetchall()]
    print(f"\n📨 'messages' Table Columns: {msg_cols}")
    
    sample_msgs = c.execute("SELECT sender_jid, sender_name, text FROM messages ORDER BY timestamp DESC LIMIT 5;").fetchall()
    print("\n🔍 Latest 5 Messages in Store:")
    for m in sample_msgs:
        print(f"   JID: {m[0]} | sender_name in message: '{m[1]}' | text snippet: '{(m[2] or '')[:30]}'")

conn.close()