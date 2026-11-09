"""Verify Firebase Google ID tokens on the server.

The service-account private key stays in ai_core/.env. Browser requests must
send Authorization: Bearer <Firebase ID token>. The tenant id is taken from
the verified token, never from a client-supplied header or query param.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
from pathlib import Path
from urllib.parse import parse_qsl, urlencode

from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)

_ENV_PATH = Path(__file__).resolve().parents[2] / ".env"
_firebase_app = None
_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}


def _load_env() -> None:
    try:
        from dotenv import load_dotenv

        load_dotenv(_ENV_PATH)
    except Exception:
        logger.debug("python-dotenv could not load %s", _ENV_PATH)


def _clean_uid(value: str | None) -> str:
    uid = str(value or "").strip()
    if not uid or len(uid) > 128:
        return ""
    if not all(c.isalnum() or c in "_-" for c in uid):
        return ""
    return uid


def _private_key() -> str:
    raw = os.getenv("FIREBASE_PRIVATE_KEY", "")
    key = raw.strip()
    if len(key) >= 2 and key[0] == key[-1] and key[0] in {'"', "'"}:
        key = key[1:-1]
    key = key.replace("\\n", "\n").strip()
    if "BEGIN PRIVATE KEY" not in key or "END PRIVATE KEY" not in key:
        raise RuntimeError("FIREBASE_PRIVATE_KEY is missing or is not a PEM key")
    return key


def credentials_configured() -> bool:
    _load_env()
    return bool(
        os.getenv("FIREBASE_PROJECT_ID", "").strip()
        and os.getenv("FIREBASE_CLIENT_EMAIL", "").strip()
        and os.getenv("FIREBASE_PRIVATE_KEY", "").strip()
    )


def get_firebase_app():
    """Initialize Firebase Admin once. Raises RuntimeError when env is incomplete."""
    global _firebase_app
    if _firebase_app is not None:
        return _firebase_app

    _load_env()
    if not credentials_configured():
        raise RuntimeError("Firebase admin credentials are not set")

    import firebase_admin
    from firebase_admin import credentials

    project_id = os.environ["FIREBASE_PROJECT_ID"].strip()
    client_email = os.environ["FIREBASE_CLIENT_EMAIL"].strip()
    try:
        cred = credentials.Certificate(
            {
                "type": "service_account",
                "project_id": project_id,
                "private_key": _private_key(),
                "client_email": client_email,
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        )
        try:
            _firebase_app = firebase_admin.get_app()
        except ValueError:
            _firebase_app = firebase_admin.initialize_app(cred)
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError("Firebase admin credentials were rejected") from exc
    return _firebase_app


def _allowed_email(email: str) -> bool:
    raw = os.getenv("FIREBASE_ALLOWED_EMAILS", "")
    allowed = [part.strip().lower() for part in raw.split(",") if part.strip()]
    if not allowed:
        return True
    return (email or "").strip().lower() in allowed


def verify_google_id_token(token: str) -> dict:
    """Return decoded claims for a Google-signed, email-verified Firebase user."""
    get_firebase_app()
    from firebase_admin import auth

    claims = auth.verify_id_token(token, check_revoked=False)
    provider = (claims.get("firebase") or {}).get("sign_in_provider")
    if provider != "google.com":
        raise PermissionError("Only Google sign-in is allowed")
    if not claims.get("email_verified"):
        raise PermissionError("Google email is not verified")
    email = str(claims.get("email") or "")
    if not _allowed_email(email):
        raise PermissionError("This Google account is not allowed")
    uid = _clean_uid(claims.get("uid") or claims.get("sub"))
    if not uid:
        raise ValueError("Token has no usable user id")
    claims["uid"] = uid
    return claims


def verified_tenant_id(request: Request) -> str:
    """Tenant id stamped by the auth middleware from the verified Firebase uid."""
    state_uid = _clean_uid(getattr(request.state, "firebase_uid", "") or "")
    if state_uid:
        return state_uid
    header_uid = _clean_uid(
        request.headers.get("x-tenant-jid") or request.headers.get("X-Tenant-JID")
    )
    if header_uid:
        return header_uid
    raise HTTPException(status_code=401, detail="Sign-in is required.")


def _header_value(scope: dict, name: str) -> str:
    target = name.lower().encode("latin-1")
    for key, value in scope.get("headers") or []:
        if key.lower() == target:
            return value.decode("latin-1")
    return ""


def _client_host(scope: dict) -> str:
    client = scope.get("client")
    if not client:
        return ""
    return str(client[0] or "")


def _is_local_host(host: str) -> bool:
    return host in _LOCAL_HOSTS or host.startswith("::ffff:127.0.0.1")


def _worker_secret_ok(scope: dict) -> bool:
    """Local WhatsApp worker calls are trusted only with the shared secret."""
    if not _is_local_host(_client_host(scope)):
        return False
    expected = os.getenv("WORKER_INTERNAL_SECRET", "").strip()
    provided = _header_value(scope, "x-worker-secret").strip()
    if not expected or not provided:
        return False
    return hmac.compare_digest(provided, expected)


async def _reject(send, status: int, detail: str) -> None:
    body = json.dumps({"detail": detail}).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


class FirebaseAuthMiddleware:
    """Require a Firebase Google ID token on browser API routes.

    The WhatsApp worker authenticates with WORKER_INTERNAL_SECRET instead of
    a user token. Browser routes require a Google ID token.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path") or ""
        method = (scope.get("method") or "GET").upper()

        if method == "OPTIONS" or not path.startswith("/api/v1/"):
            await self.app(scope, receive, send)
            return

        if path.startswith("/api/v1/webhook") or path.startswith("/api/v1/messages"):
            if not _worker_secret_ok(scope):
                await _reject(send, 403, "Webhook is only available to the local worker.")
                return
            await self.app(scope, receive, send)
            return

        if _worker_secret_ok(scope):
            await self.app(scope, receive, send)
            return

        header = _header_value(scope, "authorization").strip()
        if not header.lower().startswith("bearer "):
            await _reject(send, 401, "Sign-in is required.")
            return
        token = header[7:].strip()
        if not token or len(token) > 8192:
            await _reject(send, 401, "Sign-in is required.")
            return

        try:
            claims = verify_google_id_token(token)
        except RuntimeError:
            logger.warning("Firebase admin is not configured; refusing API request")
            await _reject(send, 503, "Sign-in is not configured on the server.")
            return
        except PermissionError as exc:
            await _reject(send, 403, str(exc))
            return
        except Exception as exc:
            logger.info("Rejected Firebase token: %s", type(exc).__name__)
            await _reject(send, 401, "Sign-in expired or invalid. Please sign in again.")
            return

        uid = claims["uid"]
        email = str(claims.get("email") or "")
        scope = dict(scope)
        headers = [
            (key, value)
            for key, value in scope.get("headers") or []
            if key.lower() != b"x-tenant-jid"
        ]
        headers.append((b"x-tenant-jid", uid.encode("ascii")))
        scope["headers"] = headers

        state = dict(scope.get("state") or {})
        state["firebase_uid"] = uid
        state["firebase_email"] = email
        scope["state"] = state

        pairs = [
            (key, value)
            for key, value in parse_qsl(
                scope.get("query_string", b"").decode("latin-1"),
                keep_blank_values=True,
            )
            if key not in ("tenant_id", "tenant_jid")
        ]
        pairs.append(("tenant_id", uid))
        pairs.append(("tenant_jid", uid))
        scope["query_string"] = urlencode(pairs).encode("ascii")

        await self.app(scope, receive, send)
