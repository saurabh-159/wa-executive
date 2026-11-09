"""Resolve chat titles from the address book, then push name, then messages."""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.services.jid_identity import digits_of, is_phone_jid, usable_person_name
from app.services.phonebook_import import phone_digit_variants

ContactPair = tuple[str | None, str | None]


def _rank(pair: ContactPair | None) -> int:
    if not pair:
        return 0
    name, notify = pair
    if usable_person_name(name):
        return 3
    if usable_person_name(notify):
        return 2
    return 1


def _prefer(current: ContactPair | None, candidate: ContactPair | None) -> ContactPair | None:
    if candidate is None:
        return current
    if current is None or _rank(candidate) > _rank(current):
        return candidate
    return current


def _digit_aliases(raw: str | None) -> list[str]:
    """Normalize phones to digit-only keys (+91 spaces, dashes, @domain stripped)."""
    out: list[str] = []
    for key in phone_digit_variants(raw):
        if key and key not in out:
            out.append(key)
        if key and len(key) >= 10:
            last10 = key[-10:]
            for alias in (last10, f"91{last10}", f"{last10}@s.whatsapp.net", f"91{last10}@s.whatsapp.net"):
                if alias not in out:
                    out.append(alias)
    return out


def _lookup_keys(jid: str | None, phone_number: str | None = None) -> list[str]:
    """
    Build lookup keys with digit-only normalization so
    '+91 98915 19151' matches '919891519151' / '9891519151@s.whatsapp.net'.
    """
    keys: list[str] = []
    for raw in (jid, phone_number):
        token = str(raw or "").strip()
        if token and token not in keys:
            keys.append(token)
    for raw in (jid, phone_number):
        for alias in _digit_aliases(raw):
            if alias not in keys:
                keys.append(alias)
            jid_alias = f"{alias}@s.whatsapp.net" if "@" not in alias else alias
            if jid_alias not in keys:
                keys.append(jid_alias)
    phone = digits_of(phone_number) or (digits_of(jid) if is_phone_jid(jid) else "")
    if phone:
        for alias in _digit_aliases(phone):
            if alias not in keys:
                keys.append(alias)
    return keys


def load_contact_directory(
    db: Session,
    tenant_id: str,
    jids: list[str] | None = None,
    phone_numbers: list[str] | None = None,
) -> dict[str, ContactPair]:
    """
    Index contacts (+ LID aliases) for name resolution.

    When jids/phone_numbers are provided, only those chats are loaded so the
    selection desk stays fast during history sync.
    """
    if not tenant_id:
        return {}

    directory: dict[str, ContactPair] = {}

    def add(key: str | None, name: str | None, notify: str | None) -> None:
        token = str(key or "").strip()
        if not token:
            return
        directory[token] = _prefer(directory.get(token), (name, notify))
        # Index digit / last-10 aliases so +91 spacing never breaks lookup
        for alias in _digit_aliases(token):
            directory[alias] = _prefer(directory.get(alias), (name, notify))

    keys: list[str] = []
    for jid in jids or []:
        keys.extend(_lookup_keys(jid))
    for phone in phone_numbers or []:
        keys.extend(_lookup_keys(None, phone))
    # Preserve order, drop empties/dupes
    seen: set[str] = set()
    key_list: list[str] = []
    for key in keys:
        if key and key not in seen:
            seen.add(key)
            key_list.append(key)

    if key_list:
        # SQLite variable limit is usually 999; keep batches small.
        chunk_size = 400
        for i in range(0, len(key_list), chunk_size):
            chunk = key_list[i : i + chunk_size]
            placeholders = ", ".join(f":k{n}" for n in range(len(chunk)))
            params = {"t": tenant_id, **{f"k{n}": value for n, value in enumerate(chunk)}}
            rows = db.execute(
                text(
                    f"""
                    SELECT jid, name, notify_name, phone_number
                    FROM contacts
                    WHERE tenant_jid = :t
                      AND (
                        jid IN ({placeholders})
                        OR phone_number IN ({placeholders})
                      )
                    """
                ),
                params,
            ).fetchall()
            for jid, name, notify, phone in rows:
                add(jid, name, notify)
                add(digits_of(jid), name, notify)
                if phone:
                    add(phone, name, notify)
                    add(digits_of(phone), name, notify)
                    add(f"{digits_of(phone)}@s.whatsapp.net", name, notify)
                if is_phone_jid(jid):
                    add(f"{digits_of(jid)}@s.whatsapp.net", name, notify)

            lid_rows = db.execute(
                text(
                    f"""
                    SELECT lid, phone_jid, phone_number
                    FROM lid_mappings
                    WHERE tenant_jid = :t
                      AND (
                        lid IN ({placeholders})
                        OR phone_jid IN ({placeholders})
                        OR phone_number IN ({placeholders})
                      )
                    """
                ),
                params,
            ).fetchall()
            for lid, phone_jid, phone_number in lid_rows:
                pair = (
                    directory.get(phone_jid)
                    or directory.get(phone_number)
                    or directory.get(digits_of(phone_number))
                    or directory.get(lid)
                )
                if not pair:
                    # Fetch contact for the mapped phone if we only had a LID key.
                    contact = db.execute(
                        text(
                            """
                            SELECT name, notify_name
                            FROM contacts
                            WHERE tenant_jid = :t
                              AND (jid = :p OR jid = :lid OR phone_number = :digits)
                            ORDER BY
                              CASE WHEN name IS NOT NULL AND trim(name) != '' THEN 0 ELSE 1 END,
                              updated_at DESC
                            LIMIT 1
                            """
                        ),
                        {
                            "t": tenant_id,
                            "p": phone_jid,
                            "lid": lid,
                            "digits": digits_of(phone_number) or digits_of(phone_jid),
                        },
                    ).fetchone()
                    if contact:
                        pair = (contact[0], contact[1])
                if not pair:
                    continue
                add(lid, pair[0], pair[1])
                add(phone_jid, pair[0], pair[1])
                if phone_number:
                    add(phone_number, pair[0], pair[1])
                    add(f"{digits_of(phone_number)}@s.whatsapp.net", pair[0], pair[1])
        return directory

    # Full-tenant path (audit / inbox). Keep it available but avoid during desk load.
    rows = db.execute(
        text(
            """
            SELECT jid, name, notify_name, phone_number
            FROM contacts
            WHERE tenant_jid = :t
            """
        ),
        {"t": tenant_id},
    ).fetchall()
    for jid, name, notify, phone in rows:
        add(jid, name, notify)
        add(digits_of(jid), name, notify)
        if phone:
            add(phone, name, notify)
            add(digits_of(phone), name, notify)
            add(f"{digits_of(phone)}@s.whatsapp.net", name, notify)
        if is_phone_jid(jid):
            add(f"{digits_of(jid)}@s.whatsapp.net", name, notify)

    mappings = db.execute(
        text(
            """
            SELECT lid, phone_jid, phone_number
            FROM lid_mappings
            WHERE tenant_jid = :t
            """
        ),
        {"t": tenant_id},
    ).fetchall()
    for lid, phone_jid, phone_number in mappings:
        pair = (
            directory.get(phone_jid)
            or directory.get(phone_number)
            or directory.get(digits_of(phone_number))
            or directory.get(lid)
        )
        if not pair:
            continue
        add(lid, pair[0], pair[1])
        add(phone_jid, pair[0], pair[1])
        if phone_number:
            add(phone_number, pair[0], pair[1])
            add(f"{digits_of(phone_number)}@s.whatsapp.net", pair[0], pair[1])

    return directory


def lookup_contact_labels(
    directory: dict[str, ContactPair],
    jid: str | None,
    phone_number: str | None = None,
) -> ContactPair:
    best: ContactPair | None = None
    for key in _lookup_keys(jid, phone_number):
        best = _prefer(best, directory.get(key))
    return best or (None, None)
