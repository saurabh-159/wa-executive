import sqlite3

c = sqlite3.connect(r"c:\Users\shaur\OneDrive\Desktop\wa-executive-assistant\ai_core\assistant.db")
print("cols", [x[1] for x in c.execute("PRAGMA table_info(messages)").fetchall()])
print("count", c.execute("select count(*) from messages").fetchone())
print(
    "suffixes",
    c.execute(
        """
        select case
          when sender_jid like '%@lid' then 'lid'
          when sender_jid like '%@s.whatsapp.net' then 'pn'
          when sender_jid like '%@g.us' then 'group'
          else 'other'
        end, count(*)
        from messages group by 1
        """
    ).fetchall(),
)
print("empty text", c.execute("select count(*) from messages where text is null or text = ''").fetchone())
print(
    "placeholders",
    c.execute("select count(*) from messages where message_id like 'sync-ph:%'").fetchone(),
)
print("--- empty samples ---")
for row in c.execute(
    """
    select sender_jid, sender_name, text, media_type, message_id
    from messages
    where text is null or text = ''
    order by timestamp desc
    limit 12
    """
):
    print(row)
print("--- long names ---")
for row in c.execute(
    """
    select sender_jid, sender_name, count(*)
    from messages
    where sender_name glob '[0-9]*' and length(sender_name) >= 12
    group by sender_jid, sender_name
    limit 20
    """
):
    print(row)
print("--- audio ---")
print(
    c.execute(
        """
        select count(*),
               sum(case when media_path is not null and media_path != '' then 1 else 0 end)
        from messages where lower(ifnull(media_type,'')) = 'audio'
        """
    ).fetchone()
)
print("--- duplicate chats by local id ---")
for row in c.execute(
    """
    select substr(sender_jid, 1, instr(sender_jid, '@') - 1) as local, count(distinct sender_jid)
    from messages
    group by local
    having count(distinct sender_jid) > 1
    limit 15
    """
):
    print(row)
