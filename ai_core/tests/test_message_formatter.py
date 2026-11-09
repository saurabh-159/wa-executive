"""Unit verification for Layer 2 message normalization & turn-state resolver."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.services.message_formatter import (
    TURN_STATE_PENDING,
    TURN_STATE_RESOLVED,
    build_extraction_context_block,
    detect_answered_turns,
    format_message_line,
    format_messages_for_extraction,
    redact_sensitive_credentials,
    sort_messages_chronologically,
)


def test_speaker_attribution_no_role_inversion():
    you = format_message_line(
        {"from_me": True, "text": "Deployed the API", "timestamp": 1_700_000_000},
        include_timestamp=False,
    )
    them = format_message_line(
        {
            "from_me": False,
            "sender_name": "Adarsh (Uncle Ji)",
            "text": "Live ki timing bta do",
            "timestamp": 1_700_000_100,
        },
        include_timestamp=False,
    )

    assert you.startswith("[You (Saurabh)]:"), you
    assert "[Contact (Adarsh (Uncle Ji))]:" in them, them
    assert "You (Saurabh)" not in them
    assert them.startswith("[Contact"), them

    # is_from_me / from_me both accepted; roles must not flip
    log = format_messages_for_extraction(
        [
            {"is_from_me": True, "sender_name": "Ravi", "text": "raat ko 11 baje", "timestamp": 20},
            {"from_me": False, "sender_name": "Ravi", "text": "To fr check kr lena", "timestamp": 10},
        ]
    )
    lines = [ln for ln in log.splitlines() if ln.strip()]
    assert lines[0].startswith("[") and "[Contact (Ravi)]:" in lines[0]
    assert "[You (Saurabh)]:" in lines[1]
    assert "SMTP" not in log  # sanity: fixture text only


def test_chronological_sort_ascending():
    msgs = [
        {"from_me": True, "text": "second", "timestamp": 200},
        {"from_me": False, "sender_name": "A", "text": "first", "timestamp": 100},
        {"from_me": False, "sender_name": "A", "text": "third", "timestamp": 300},
    ]
    ordered = sort_messages_chronologically(msgs)
    assert [m["text"] for m in ordered] == ["first", "second", "third"]


def test_detect_answered_turns_resolved_by_user():
    messages = [
        {"from_me": False, "sender_name": "Adarsh", "text": "Live ki timing bta do", "timestamp": 1},
        {"from_me": True, "text": "raat ko 11 baje approax", "timestamp": 2},
        {"from_me": False, "sender_name": "Adarsh", "text": "To fr check kr lena", "timestamp": 3},
    ]
    result = detect_answered_turns(messages)
    assert result["turn_state"] == TURN_STATE_RESOLVED
    assert result["resolved"] is True
    assert result["pending"] is False
    assert "already answered" in result["system_hint"].lower()
    assert "Needs you" in result["system_hint"]


def test_detect_answered_turns_pending_user_reply():
    messages = [
        {"from_me": True, "text": "Site almost ready", "timestamp": 1},
        {"from_me": False, "sender_name": "Adarsh", "text": "Password bhej do", "timestamp": 2},
    ]
    result = detect_answered_turns(messages)
    assert result["turn_state"] == TURN_STATE_PENDING
    assert result["pending"] is True
    assert result["resolved"] is False


def test_credential_redaction_masks_secret():
    raw = "Admin panel Password: hptourism@123 please use carefully"
    redacted = redact_sensitive_credentials(raw)
    assert "hptourism@123" not in redacted
    assert "********" in redacted
    assert "[Credentials Shared:" in redacted
    assert "hptourism" in redacted

    ultra = "UltraViewer password: SecretPass99"
    masked = redact_sensitive_credentials(ultra)
    assert "SecretPass99" not in masked
    assert "********" in masked

    combo = "Username: hptourism Password: hptourism@123"
    combo_masked = redact_sensitive_credentials(combo)
    assert "hptourism@123" not in combo_masked
    assert "[Credentials Shared: hptourism / ********]" in combo_masked


def test_build_extraction_context_includes_turn_state():
    messages = [
        {
            "from_me": True,
            "text": "https://hptourism.in/admin Password: hptourism@123",
            "timestamp": 1730672220,
        },
        {
            "from_me": False,
            "sender_name": "Adarsh (Uncle Ji)",
            "text": "Live ki timing bta do",
            "timestamp": 1730712060,
        },
        {
            "from_me": True,
            "text": "raat ko 11 baje approax",
            "timestamp": 1730713560,
        },
        {
            "from_me": False,
            "sender_name": "Adarsh (Uncle Ji)",
            "text": "To fr check kr lena",
            "timestamp": 1730713620,
        },
    ]
    block = build_extraction_context_block(
        messages,
        chat_name="Adarsh (Uncle Ji)",
        chat_jid="919999999999@s.whatsapp.net",
    )
    assert "--- CONVERSATION LOG START (Adarsh (Uncle Ji) |" in block
    assert "[You (Saurabh)]:" in block
    assert "[Contact (Adarsh (Uncle Ji))]:" in block
    assert "hptourism@123" not in block
    assert "[Credentials Shared:" in block
    assert "[SYSTEM TURN STATE]:" in block
    assert TURN_STATE_RESOLVED in block
    assert "Do NOT mark this matter as 'Needs you'" in block


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
