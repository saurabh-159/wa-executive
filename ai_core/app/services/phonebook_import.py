"""Parse phone-exported vCard/CSV and map saved names onto WhatsApp contacts."""

from __future__ import annotations

import csv
import io
import re
from datetime import datetime
from typing import Iterable

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.services.jid_identity import digits_of, is_real_phone_digits, usable_person_name

_VCARD_FN_RE = re.compile(r"^FN[;:](.*)$", re.IGNORECASE | re.MULTILINE)
_VCARD_N_RE = re.compile(r"^N[;:](.*)$", re.IGNORECASE | re.MULTILINE)
_VCARD_TEL_RE = re.compile(r"^TEL[^:]*:(.+)$", re.IGNORECASE | re.MULTILINE)

_NAME_HEADERS = {
    "name",
    "fn",
    "full name",
    "fullname",
    "contact",
    "contact name",
    "display name",
    "first name",
}
_PHONE_HEADERS = {
    "phone",
    "mobile",
    "tel",
    "telephone",
    "phone number",
    "mobile phone",
    "cell",
    "number",
}


def phone_digit_variants(raw: str | None) -> set[str]:
    """India-friendly digit keys for matching (10-digit local + 91-prefixed)."""
    digits = digits_of(raw)
    if not digits or not is_real_phone_digits(digits):
        return set()
    variants = {digits}
    if len(digits) == 10:
        variants.add(f"91{digits}")
    if len(digits) == 12 and digits.startswith("91"):
        variants.add(digits[2:])
    if len(digits) > 10 and digits.startswith("0"):
        stripped = digits.lstrip("0")
        if is_real_phone_digits(stripped):
            variants |= phone_digit_variants(stripped)
    return variants


def _unescape_vcard(value: str) -> str:
    return (
        str(value or "")
        .replace("\\n", " ")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
        .strip()
    )


def _name_from_n_field(raw: str) -> str | None:
    # N: Last;First;Middle;Prefix;Suffix
    parts = [_unescape_vcard(p) for p in str(raw or "").split(";")]
    while parts and not parts[-1]:
        parts.pop()
    if not parts:
        return None
    last = parts[0] if len(parts) > 0 else ""
    first = parts[1] if len(parts) > 1 else ""
    middle = parts[2] if len(parts) > 2 else ""
    ordered = " ".join(p for p in (first, middle, last) if p).strip()
    return ordered or None


def parse_vcard(text_body: str) -> list[tuple[str, str]]:
    """Return list of (name, phone_digits) from vCard text."""
    cards = re.split(r"(?i)BEGIN:VCARD", text_body or "")
    out: list[tuple[str, str]] = []
    for card in cards:
        if not card.strip():
            continue
        block = "BEGIN:VCARD\n" + card
        fn_match = _VCARD_FN_RE.search(block)
        name = _unescape_vcard(fn_match.group(1)) if fn_match else ""
        if not usable_person_name(name):
            n_match = _VCARD_N_RE.search(block)
            name = _name_from_n_field(n_match.group(1)) if n_match else ""
        clean_name = usable_person_name(name)
        if not clean_name:
            continue
        for tel_match in _VCARD_TEL_RE.finditer(block):
            tel = _unescape_vcard(tel_match.group(1))
            for digits in phone_digit_variants(tel):
                out.append((clean_name, digits))
    return out


def _pick_column(headers: list[str], candidates: set[str]) -> int | None:
    lowered = [h.strip().casefold() for h in headers]
    for i, h in enumerate(lowered):
        if h in candidates:
            return i
    return None


def parse_csv(text_body: str) -> list[tuple[str, str]]:
    """Return list of (name, phone_digits) from CSV text."""
    sample = (text_body or "")[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel

    reader = csv.reader(io.StringIO(text_body or ""), dialect)
    rows = list(reader)
    if not rows:
        return []

    header = [str(c or "").strip() for c in rows[0]]
    name_idx = _pick_column(header, _NAME_HEADERS)
    phone_idx = _pick_column(header, _PHONE_HEADERS)
    start = 1
    if name_idx is None or phone_idx is None:
        # Fallback: first two columns are Name, Phone (no/unknown header)
        name_idx = 0
        phone_idx = 1 if len(header) > 1 else 0
        # If first row looks like data (has digits in phone col), include it
        phone_probe = digits_of(header[phone_idx] if phone_idx < len(header) else "")
        start = 0 if is_real_phone_digits(phone_probe) else 1

    out: list[tuple[str, str]] = []
    for row in rows[start:]:
        if not row:
            continue
        name = usable_person_name(row[name_idx] if name_idx < len(row) else "")
        phone_raw = row[phone_idx] if phone_idx < len(row) else ""
        if not name:
            continue
        for digits in phone_digit_variants(phone_raw):
            out.append((name, digits))
    return out


def parse_phonebook_file(filename: str, raw_bytes: bytes) -> list[tuple[str, str]]:
    text_body = raw_bytes.decode("utf-8-sig", errors="replace")
    lower = (filename or "").lower()
    if lower.endswith(".vcf") or "BEGIN:VCARD" in text_body.upper():
        return parse_vcard(text_body)
    if lower.endswith(".csv") or "," in text_body or ";" in text_body:
        return parse_csv(text_body)
    # Last resort: try vCard then CSV
    entries = parse_vcard(text_body)
    return entries or parse_csv(text_body)


def _collapse_entries(entries: Iterable[tuple[str, str]]) -> dict[str, str]:
    """digit -> preferred name (first usable wins; later same-digit keeps first)."""
    by_digit: dict[str, str] = {}
    for name, digits in entries:
        clean = usable_person_name(name)
        if not clean or not digits:
            continue
        for key in phone_digit_variants(digits):
            by_digit.setdefault(key, clean)
    return by_digit


def _match_name_for_keys(by_digit: dict[str, str], *raw_values: str | None) -> str | None:
    keys: set[str] = set()
    for raw in raw_values:
        keys |= phone_digit_variants(raw)
        d = digits_of(raw)
        if len(d) >= 10:
            keys.add(d)
            keys.add(d[-10:])
            keys.add(f"91{d[-10:]}")
    for key in keys:
        name = by_digit.get(key)
        if name:
            return name
    return None


def ensure_contacts_from_message_chats(
    db: Session,
    *,
    tenant_id: str,
    by_digit: dict[str, str],
    override_existing: bool = False,
) -> dict[str, int]:
    """
    Create (or optionally fill) contacts rows for WhatsApp chats that already
    have messages but no usable contacts.name — so Google/phonebook sync can
    still label Direct Chats that were never in the address-book upsert path.
    """
    if not tenant_id or not by_digit:
        return {"created": 0, "updated": 0, "matched_chats": 0}

    msg_rows = db.execute(
        text(
            """
            SELECT DISTINCT sender_jid, phone_number
            FROM messages
            WHERE tenant_jid = :t
              AND sender_jid IS NOT NULL
              AND sender_jid != ''
              AND sender_jid NOT LIKE '%@g.us'
              AND sender_jid NOT LIKE '%@broadcast'
              AND sender_jid NOT LIKE '%@newsletter'
            """
        ),
        {"t": tenant_id},
    ).fetchall()

    existing = {
        str(r[0]): (r[1], r[2], r[3])
        for r in db.execute(
            text(
                """
                SELECT jid, id, name, phone_number
                FROM contacts
                WHERE tenant_jid = :t
                """
            ),
            {"t": tenant_id},
        ).fetchall()
    }

    created = 0
    updated = 0
    matched_chats = 0
    now = datetime.utcnow().isoformat(sep=" ", timespec="seconds")

    for sender_jid, phone in msg_rows:
        jid = str(sender_jid or "").strip()
        if not jid or jid.endswith("@lid"):
            # Prefer canonical phone JID when available via phone_number.
            phone_digits = digits_of(phone)
            if len(phone_digits) >= 10:
                jid = f"{phone_digits}@s.whatsapp.net"
            else:
                continue

        mapped_name = _match_name_for_keys(by_digit, phone, jid, sender_jid)
        if not mapped_name:
            continue
        matched_chats += 1

        phone_digits = digits_of(phone) or digits_of(jid)
        phone_number = phone_digits or None
        canon_jid = (
            f"{phone_digits}@s.whatsapp.net" if phone_digits and len(phone_digits) >= 10 else jid
        )

        for target in {jid, canon_jid, str(sender_jid or "").strip()}:
            if not target or target.endswith("@lid"):
                continue
            row = existing.get(target)
            if not row:
                db.execute(
                    text(
                        """
                        INSERT INTO contacts (tenant_jid, jid, name, notify_name, phone_number, updated_at)
                        VALUES (:t, :j, :n, NULL, :phone, :ts)
                        ON CONFLICT(tenant_jid, jid) DO UPDATE SET
                            name = COALESCE(excluded.name, contacts.name),
                            phone_number = COALESCE(excluded.phone_number, contacts.phone_number),
                            updated_at = excluded.updated_at
                        """
                    ),
                    {
                        "t": tenant_id,
                        "j": target,
                        "n": mapped_name,
                        "phone": phone_number,
                        "ts": now,
                    },
                )
                existing[target] = (-1, mapped_name, phone_number)
                created += 1
                print(
                    f"📒 [CONTACT CREATE] jid={target!r} phone={phone_number!r} "
                    f"name={mapped_name!r}"
                )
                continue

            _cid, existing_name, _phone = row
            have = usable_person_name(existing_name)
            if have and not override_existing:
                continue
            if have and have.casefold() == mapped_name.casefold():
                continue
            db.execute(
                text(
                    """
                    UPDATE contacts
                    SET name = :name, phone_number = COALESCE(:phone, phone_number), updated_at = :ts
                    WHERE tenant_jid = :t AND jid = :j
                    """
                ),
                {
                    "name": mapped_name,
                    "phone": phone_number,
                    "ts": now,
                    "t": tenant_id,
                    "j": target,
                },
            )
            existing[target] = (_cid, mapped_name, phone_number)
            updated += 1
            print(
                f"📒 [CONTACT FILL] jid={target!r} phone={phone_number!r} "
                f"{existing_name!r} → {mapped_name!r}"
            )

    if created or updated:
        db.commit()

    return {
        "created": created,
        "updated": updated,
        "matched_chats": matched_chats,
    }


def apply_phonebook_import(
    db: Session,
    *,
    tenant_id: str,
    filename: str,
    raw_bytes: bytes,
) -> dict:
    entries = parse_phonebook_file(filename, raw_bytes)
    by_digit = _collapse_entries(entries)
    imported = len(by_digit)
    if imported == 0:
        return {
            "status": "ok",
            "imported": 0,
            "matched": 0,
            "updated_contacts": 0,
            "updated_messages": 0,
            "created_contacts": 0,
            "unmatched_sample": [],
            "message": "No usable contacts found in file",
        }

    # First: create/fill contacts for chats that have messages but no row/name.
    ensured = ensure_contacts_from_message_chats(
        db,
        tenant_id=tenant_id,
        by_digit=by_digit,
        override_existing=False,
    )

    rows = db.execute(
        text(
            """
            SELECT id, jid, name, phone_number
            FROM contacts
            WHERE tenant_jid = :t
            """
        ),
        {"t": tenant_id},
    ).fetchall()

    updated_ids: list[int] = []
    matched_contact_ids: set[int] = set()
    matched_digit_keys: set[str] = set()
    now = datetime.utcnow().isoformat(sep=" ", timespec="seconds")

    for contact_id, jid, existing_name, phone in rows:
        keys = phone_digit_variants(phone) | phone_digit_variants(jid)
        imported_name = None
        hit_keys: set[str] = set()
        for key in keys:
            if key in by_digit:
                imported_name = by_digit[key]
                hit_keys = phone_digit_variants(key)
                break
        if not imported_name:
            continue

        matched_contact_ids.add(contact_id)
        matched_digit_keys |= hit_keys

        existing = usable_person_name(existing_name)
        # Do not clobber a better existing saved name.
        if existing:
            continue

        db.execute(
            text(
                """
                UPDATE contacts
                SET name = :name, updated_at = :ts
                WHERE id = :id AND tenant_jid = :t
                """
            ),
            {"name": imported_name, "ts": now, "id": contact_id, "t": tenant_id},
        )
        updated_ids.append(contact_id)

    db.commit()

    from app.controllers.webhook_controller import settle_contact_names_from_db

    settle = settle_contact_names_from_db(db, tenant_jid=tenant_id)
    total_updated = len(updated_ids) + int(ensured.get("created") or 0) + int(
        ensured.get("updated") or 0
    )

    unmatched = []
    seen_names: set[str] = set()
    for digits, name in by_digit.items():
        if digits in matched_digit_keys:
            continue
        if name in seen_names:
            continue
        if len(digits) == 10 and f"91{digits}" in matched_digit_keys:
            continue
        seen_names.add(name)
        unmatched.append({"name": name, "phone": digits})
        if len(unmatched) >= 15:
            break

    return {
        "status": "ok",
        "imported": imported,
        "matched": max(len(matched_contact_ids), int(ensured.get("matched_chats") or 0)),
        "updated_contacts": total_updated,
        "created_contacts": int(ensured.get("created") or 0),
        "updated_messages": int(settle.get("updated_messages") or 0),
        "unmatched_sample": unmatched,
        "phonebook_names": settle.get("phonebook_names"),
        "message": (
            f"Mapped {total_updated} contacts from phonebook "
            f"({imported} numbers in file; created {int(ensured.get('created') or 0)})."
        ),
    }
