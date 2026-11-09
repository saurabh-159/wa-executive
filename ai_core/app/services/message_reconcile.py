"""Repair chat ids, LID display names, and empty history placeholders."""

from __future__ import annotations

from sqlalchemy import text

from app.services.jid_identity import format_phone, is_phone_jid, is_raw_lid_name


def reconcile_message_rows(connection) -> dict:
    """
    One-shot repair for rows already stored:
    - backfill phone_number on real phone JIDs
    - drop sync placeholders once a chat has a real message
    - replace bare LID labels with a saved name or the phone number
    - give empty image/audio rows a preview label
    """
    stats = {
        "phone_numbers": 0,
        "placeholders_removed": 0,
        "names_fixed": 0,
        "media_labels": 0,
    }

    columns = {
        row[1] for row in connection.execute(text("PRAGMA table_info(messages)")).fetchall()
    }
    if "phone_number" not in columns:
        connection.execute(text("ALTER TABLE messages ADD COLUMN phone_number VARCHAR(32)"))

    phone_rows = connection.execute(
        text(
            """
            SELECT id, sender_jid FROM messages
            WHERE sender_jid LIKE '%@s.whatsapp.net'
              AND (phone_number IS NULL OR phone_number = '')
            """
        )
    ).fetchall()
    for row_id, sender_jid in phone_rows:
        if not is_phone_jid(sender_jid):
            continue
        phone = str(sender_jid).split("@")[0]
        connection.execute(
            text("UPDATE messages SET phone_number = :phone WHERE id = :id"),
            {"phone": phone, "id": row_id},
        )
        stats["phone_numbers"] += 1

    removed = connection.execute(
        text(
            """
            DELETE FROM messages
            WHERE message_id LIKE 'sync-ph:%'
              AND sender_jid IN (
                SELECT sender_jid FROM messages
                WHERE message_id NOT LIKE 'sync-ph:%'
              )
            """
        )
    )
    stats["placeholders_removed"] = int(removed.rowcount or 0)

    named = connection.execute(
        text(
            """
            SELECT sender_jid, sender_name FROM messages
            WHERE sender_name IS NOT NULL AND sender_name != ''
            """
        )
    ).fetchall()
    best_name: dict[str, str] = {}
    for sender_jid, sender_name in named:
        if is_raw_lid_name(sender_name):
            continue
        if str(sender_name).strip().lower() in {"unknown", "unknown contact", "user", "you"}:
            continue
        best_name.setdefault(sender_jid, str(sender_name).strip()[:100])

    lid_named = connection.execute(
        text(
            """
            SELECT id, sender_jid, sender_name FROM messages
            WHERE sender_name IS NOT NULL AND sender_name != ''
            """
        )
    ).fetchall()
    for row_id, sender_jid, sender_name in lid_named:
        if not is_raw_lid_name(sender_name):
            continue
        replacement = best_name.get(sender_jid) or format_phone(sender_jid) or "Unknown"
        connection.execute(
            text("UPDATE messages SET sender_name = :name WHERE id = :id"),
            {"name": replacement[:100], "id": row_id},
        )
        stats["names_fixed"] += 1

    images = connection.execute(
        text(
            """
            UPDATE messages
            SET text = '[Photo]'
            WHERE lower(ifnull(media_type, '')) = 'image'
              AND (text IS NULL OR trim(text) = '')
            """
        )
    )
    audio = connection.execute(
        text(
            """
            UPDATE messages
            SET text = '[Voice Note]'
            WHERE lower(ifnull(media_type, '')) = 'audio'
              AND (text IS NULL OR trim(text) = '')
            """
        )
    )
    stats["media_labels"] = int(images.rowcount or 0) + int(audio.rowcount or 0)
    return stats
