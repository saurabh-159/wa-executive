import sqlite3

c = sqlite3.connect(r"c:\Users\shaur\OneDrive\Desktop\wa-executive-assistant\ai_core\assistant.db")
print("--- other jids ---")
for row in c.execute(
    """
    select sender_jid, sender_name, substr(ifnull(text,''),1,30), media_type
    from messages
    where sender_jid not like '%@lid'
      and sender_jid not like '%@s.whatsapp.net'
      and sender_jid not like '%@g.us'
    """
):
    print(row)

print("--- chats whose newest row is empty ---")
for row in c.execute(
    """
    select m.sender_jid, m.sender_name, substr(ifnull(m.text,''),1,24), m.media_type, m.message_id, m.timestamp
    from messages m
    join (
      select sender_jid, max(timestamp) as max_ts
      from messages
      group by sender_jid
    ) t on m.sender_jid = t.sender_jid and m.timestamp = t.max_ts
    where ifnull(m.text,'') = ''
    limit 25
    """
):
    print(row)

print("--- per chat message counts vs placeholders ---")
for row in c.execute(
    """
    select sender_jid,
           count(*) as n,
           sum(case when message_id like 'sync-ph:%' then 1 else 0 end) as ph,
           sum(case when ifnull(text,'') != '' then 1 else 0 end) as with_text
    from messages
    group by sender_jid
    having ph > 0
    """
):
    print(row)
