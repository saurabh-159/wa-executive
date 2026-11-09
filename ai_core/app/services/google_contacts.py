"""Fetch Google People API contacts and map names onto WhatsApp contacts by phone digits."""

from __future__ import annotations

from datetime import datetime
from typing import Any

import requests
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.services.jid_identity import digits_of, usable_person_name
from app.services.phonebook_import import (
    ensure_contacts_from_message_chats,
    phone_digit_variants,
)

PEOPLE_CONNECTIONS_URL = (
    "https://people.googleapis.com/v1/people/me/connections"
)
PERSON_FIELDS = "names,phoneNumbers"
PAGE_SIZE = 1000


def _clean_phone(raw: str | None) -> str:
    return digits_of(raw)


def fetch_google_phonebook(access_token: str) -> list[tuple[str, str]]:
    """
    Return list of (displayName, phone_digits) from Google People API.
    Paginates until exhausted (or soft-capped).
    """
    if not access_token or not str(access_token).strip():
        raise ValueError("Google access token is required")

    headers = {"Authorization": f"Bearer {access_token.strip()}"}
    entries: list[tuple[str, str]] = []
    page_token: str | None = None
    pages = 0

    while pages < 20:
        pages += 1
        params: dict[str, Any] = {
            "personFields": PERSON_FIELDS,
            "pageSize": PAGE_SIZE,
        }
        if page_token:
            params["pageToken"] = page_token

        resp = requests.get(
            PEOPLE_CONNECTIONS_URL,
            headers=headers,
            params=params,
            timeout=30,
        )
        if resp.status_code == 401:
            raise PermissionError(
                "Google access token expired or missing contacts.readonly scope. "
                "Sign in again and grant Contacts access."
            )
        if resp.status_code == 403:
            raise PermissionError(
                "Google People API denied access. Enable People API and "
                "request https://www.googleapis.com/auth/contacts.readonly."
            )
        resp.raise_for_status()
        payload = resp.json() or {}
        connections = payload.get("connections") or []
        print(
            f"📒 [GOOGLE CONTACTS] page={pages} connections={len(connections)} "
            f"token_next={bool(payload.get('nextPageToken'))}"
        )

        for person in connections:
            names = person.get("names") or []
            display = ""
            if names:
                display = (
                    names[0].get("displayName")
                    or names[0].get("unstructuredName")
                    or ""
                ).strip()
            clean_name = usable_person_name(display)
            if not clean_name:
                continue
            for phone in person.get("phoneNumbers") or []:
                raw = phone.get("value") or phone.get("canonicalForm") or ""
                digits = _clean_phone(raw)
                if not digits or len(digits) < 8:
                    continue
                entries.append((clean_name, digits))
                print(
                    f"📒 [GOOGLE CONTACT] name={clean_name!r} "
                    f"raw={raw!r} digits={digits!r}"
                )

        page_token = payload.get("nextPageToken")
        if not page_token:
            break

    return entries


def apply_google_contacts(
    db: Session,
    *,
    tenant_id: str,
    access_token: str,
) -> dict[str, Any]:
    """
    Match Google phonebook numbers onto SQLite contacts (last-10 / country-code safe)
    and set contacts.name from Google (Google always wins over WA names).
    Then settle weak message labels.
    """
    entries = fetch_google_phonebook(access_token)
    by_digit: dict[str, str] = {}
    for name, digits in entries:
        for key in phone_digit_variants(digits):
            by_digit.setdefault(key, name)

    print(
        f"📒 [GOOGLE SYNC] tenant={tenant_id} "
        f"google_entries={len(entries)} digit_keys={len(by_digit)}"
    )

    if not by_digit:
        return {
            "status": "ok",
            "imported": 0,
            "matched": 0,
            "updated_contacts": 0,
            "created_contacts": 0,
            "updated_messages": 0,
            "message": "No Google contacts with phone numbers found",
        }

    # Create rows for WhatsApp chats that have messages but no contacts row yet.
    # Google names always win (override_existing=True).
    ensured = ensure_contacts_from_message_chats(
        db,
        tenant_id=tenant_id,
        by_digit=by_digit,
        override_existing=True,
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
    matched_ids: set[int] = set()
    now = datetime.utcnow().isoformat(sep=" ", timespec="seconds")

    for contact_id, jid, existing_name, phone in rows:
        keys = phone_digit_variants(phone) | phone_digit_variants(jid)
        # Also try last-10 of jid/phone even if variants filtered short IDs
        for raw in (phone, jid):
            d = digits_of(raw)
            if len(d) >= 10:
                keys.add(d[-10:])
                keys.add(f"91{d[-10:]}")
                keys.add(d)

        google_name = None
        for key in keys:
            if key in by_digit:
                google_name = by_digit[key]
                break
        if not google_name:
            continue

        matched_ids.add(contact_id)
        existing = usable_person_name(existing_name)
        # Google Contacts is the preferred display name — always win over
        # WhatsApp phonebook / notify / pushName already stored on the row.
        if existing and existing.casefold() == google_name.casefold():
            print(
                f"📒 [GOOGLE MATCH SKIP] jid={jid} already google-named={existing!r}"
            )
            continue

        if existing:
            print(
                f"📒 [GOOGLE MATCH OVERRIDE] jid={jid} phone={phone!r} "
                f"{existing!r} → {google_name!r}"
            )
        else:
            print(
                f"📒 [GOOGLE MATCH UPDATE] jid={jid} phone={phone!r} → name={google_name!r}"
            )
        db.execute(
            text(
                """
                UPDATE contacts
                SET name = :name, updated_at = :ts
                WHERE id = :id AND tenant_jid = :t
                """
            ),
            {"name": google_name, "ts": now, "id": contact_id, "t": tenant_id},
        )
        updated_ids.append(contact_id)

    db.commit()

    from app.controllers.webhook_controller import settle_contact_names_from_db

    settle = settle_contact_names_from_db(db, tenant_jid=tenant_id)
    created = int(ensured.get("created") or 0)
    filled = int(ensured.get("updated") or 0)
    total_updated = len(updated_ids) + created + filled

    return {
        "status": "ok",
        "imported": len(entries),
        "matched": max(len(matched_ids), int(ensured.get("matched_chats") or 0)),
        "updated_contacts": total_updated,
        "created_contacts": created,
        "updated_messages": int(settle.get("updated_messages") or 0),
        "phonebook_names": settle.get("phonebook_names"),
        "message": (
            f"Mapped {total_updated} contacts from Google "
            f"({len(entries)} phone numbers fetched; created {created})."
        ),
    }
