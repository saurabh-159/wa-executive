"""
Terminal verification for multimodal ingest + matter speaker formatting.

Usage (from ai_core/ with venv active):
  python scripts/verify_multimodal_ingest.py
  python scripts/verify_multimodal_ingest.py --live   # also POST to running FastAPI
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# io kept for WAV generation

# Allow `python scripts/...` from ai_core/
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _tiny_jpeg_b64() -> str:
    """Load fixture JPEG (UPI receipt stub) for Vision verification."""
    fixture = Path(__file__).resolve().parent / "fixtures_receipt.jpg"
    if fixture.is_file():
        return base64.b64encode(fixture.read_bytes()).decode("ascii")
    raise FileNotFoundError(f"Missing Vision fixture: {fixture}")


def _tiny_wav_b64() -> str:
    """Silent 0.3s mono 16kHz WAV for Whisper path."""
    import wave

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        frames = b"\x00\x00" * 4800  # 0.3s
        wf.writeframes(frames)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def test_format_speakers() -> None:
    from app.services.matter_extractor import format_chat_log_line, format_messages_for_extraction

    you = format_chat_log_line(from_me=True, sender_name="Ignored", text="Deployed the API")
    them = format_chat_log_line(from_me=False, sender_name="Ravi", text="Kab live hoga?")
    assert you.startswith("[You (Saurabh)]:"), you
    assert them.startswith("[Contact (Ravi)]:"), them

    log = format_messages_for_extraction(
        [
            {"is_from_me": True, "sender_name": "Ravi", "text": "SMTP skip kar do", "timestamp": 1},
            {"from_me": False, "sender_name": "Ravi", "text": "Ok thanks", "timestamp": 2},
        ]
    )
    assert "[You (Saurabh)]: SMTP skip kar do" in log
    assert "[Contact (Ravi)]: Ok thanks" in log
    print("[OK] matter_extractor speaker prefixes")


def test_media_processor_unit() -> None:
    from app.services.media_processor import process_media_payload

    # Invalid alphabet should not raise
    bad = process_media_payload("audio", "!!!!!!!!")
    assert "Media extraction unavailable" in bad or bad.startswith("[Media"), bad
    print("[OK] media_processor catches bad base64 without raising")

    # Empty inputs
    assert process_media_payload(None, None) == ""
    assert process_media_payload("audio", "") == ""
    print("[OK] media_processor empty guards")


def test_process_message_payload_local() -> None:
    from app.controllers.webhook_controller import process_message_payload
    from app.models.database import SessionLocal
    from app.models.message import Message

    ts = int(time.time())
    audio_id = f"test_audio_{ts}"
    image_id = f"test_image_{ts}"
    chat_jid = "919999999999@s.whatsapp.net"

    audio_body = {
        "tenant_jid": "verify_multimodal",
        "message_id": audio_id,
        "chat_jid": chat_jid,
        "sender_name": "Ravi",
        "from_me": False,
        "timestamp": ts,
        "text": "[Voice Note]",
        "media_type": "audio",
        "media_base64": _tiny_wav_b64(),
        "is_history": True,
    }
    image_body = {
        "tenant_jid": "verify_multimodal",
        "message_id": image_id,
        "chat_jid": chat_jid,
        "sender_name": "Ravi",
        "from_me": True,  # receipt YOU sent — must store from_me=1
        "timestamp": ts + 1,
        "text": "[Photo]",
        "media_type": "image",
        "media_base64": _tiny_jpeg_b64(),
        "is_history": True,
    }

    r1 = process_message_payload(audio_body)
    r2 = process_message_payload(image_body)
    print("[INGEST audio]", json.dumps(r1, default=str)[:200])
    print("[INGEST image]", json.dumps(r2, default=str)[:200])

    with SessionLocal() as db:
        a = (
            db.query(Message)
            .filter(Message.tenant_jid == "verify_multimodal", Message.message_id == audio_id)
            .first()
        )
        i = (
            db.query(Message)
            .filter(Message.tenant_jid == "verify_multimodal", Message.message_id == image_id)
            .first()
        )
        assert a is not None, "audio row missing"
        assert i is not None, "image row missing"
        assert int(bool(a.is_from_me)) == 0, a.is_from_me
        assert int(bool(i.is_from_me)) == 1, i.is_from_me
        assert a.sender_name == "Ravi"
        print("[DB audio preview]", (a.text or "")[:120])
        print("[DB image preview]", (i.text or "")[:120])
        # Cleanup test rows
        db.delete(a)
        db.delete(i)
        db.commit()
    print("[OK] process_message_payload stored from_me + media text")


def _worker_secret() -> str:
    for candidate in (ROOT / ".env", ROOT.parent / "wa_worker" / ".env"):
        if not candidate.is_file():
            continue
        for line in candidate.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.strip().startswith("WORKER_INTERNAL_SECRET="):
                return line.split("=", 1)[1].strip().strip("\"'")
    return ""


def test_live_http(base_url: str) -> None:
    ts = int(time.time())
    payload = {
        "tenant_jid": "verify_multimodal",
        "message_id": f"curl_img_{ts}",
        "chat_jid": "918888888888@s.whatsapp.net",
        "sender_name": "Payee Test",
        "from_me": False,
        "timestamp": ts,
        "text": "UPI receipt",
        "media_type": "image",
        "media_base64": _tiny_jpeg_b64(),
        "is_history": True,
    }
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    secret = _worker_secret()
    if secret:
        headers["X-Worker-Secret"] = secret
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/v1/messages/ingest",
        data=data,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            print(f"[LIVE HTTP {resp.status}]", body[:300])
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        print(f"[LIVE HTTP failed] {exc.code}: {detail[:300]}")
    except urllib.error.URLError as exc:
        print(f"[LIVE HTTP skipped/failed] {exc}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="Also hit running FastAPI")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    args = parser.parse_args()

    logging_cfg()
    test_format_speakers()
    test_media_processor_unit()
    test_process_message_payload_local()
    if args.live:
        test_live_http(args.base_url)
    print("\nAll verification checks completed.")
    return 0


def logging_cfg() -> None:
    import logging

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")


if __name__ == "__main__":
    raise SystemExit(main())
