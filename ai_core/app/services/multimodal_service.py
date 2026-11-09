import os
import base64
import subprocess
import tempfile
from openai import OpenAI
from app.config import settings
from app.config.rules_knowledge_base import (
    VISION_EXTRACTION_PROMPT,
    VOICE_EXTRACTION_PROMPT,
)

DOWNLOADS_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "../../../wa_worker/downloads")
)

_client = None


def _api_key() -> str:
    """Prefer Settings (.env) and fall back to the process environment."""
    return (settings.OPENAI_API_KEY or os.getenv("OPENAI_API_KEY") or "").strip()


def _get_client():
    """Build the OpenAI client once. Missing key or init errors must not crash callers."""
    global _client
    if _client is not None:
        return _client
    api_key = _api_key()
    if not api_key:
        print("[OpenAI] OPENAI_API_KEY is not set")
        return None
    try:
        _client = OpenAI(api_key=api_key)
    except Exception as e:
        print(f"[OpenAI] Client init failed: {e}")
        return None
    return _client


def _resolve_media_file(file_name: str) -> str:
    """
    Resolve a media reference to a readable file.
    Message rows store a bare filename under wa_worker/downloads.
    Callers that already resolved an absolute path (webhook) are accepted too.
    """
    if not file_name or not str(file_name).strip():
        return ""
    raw = str(file_name).strip().strip('"')
    try:
        if os.path.isabs(raw):
            return raw if os.path.isfile(raw) else ""
        if os.path.isfile(raw):
            return os.path.abspath(raw)
        safe_name = os.path.basename(raw.replace("\\", "/"))
        if not safe_name or safe_name in {".", ".."}:
            return ""
        candidate = os.path.join(DOWNLOADS_DIR, safe_name)
        return candidate if os.path.isfile(candidate) else ""
    except Exception as e:
        print(f"[Media Path Error] {file_name}: {e}")
        return ""


def _image_mime(file_path: str) -> str:
    ext = os.path.splitext(file_path)[1].lower()
    return {
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }.get(ext, "image/jpeg")


def _convert_ogg_to_wav_pyav(input_path: str) -> str:
    """Decode OGG/Opus to 16kHz mono WAV via PyAV (no system ffmpeg required)."""
    try:
        import av
        import numpy as np

        temp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        temp_wav_path = temp_wav.name
        temp_wav.close()

        resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=16000)
        chunks: list = []
        with av.open(input_path, mode="r") as container:
            stream = next((s for s in container.streams if s.type == "audio"), None)
            if stream is None:
                return ""
            for frame in container.decode(stream):
                for out in resampler.resample(frame) or []:
                    arr = out.to_ndarray()
                    if arr.ndim > 1:
                        arr = arr.reshape(-1)
                    chunks.append(arr.astype(np.int16, copy=False))
            # Flush resampler
            for out in resampler.resample(None) or []:
                arr = out.to_ndarray()
                if arr.ndim > 1:
                    arr = arr.reshape(-1)
                chunks.append(arr.astype(np.int16, copy=False))

        if not chunks:
            return ""

        pcm = np.concatenate(chunks)
        import wave

        with wave.open(temp_wav_path, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(pcm.tobytes())

        if os.path.getsize(temp_wav_path) > 100:
            return temp_wav_path
        os.remove(temp_wav_path)
        return ""
    except Exception as e:
        print(f"[Audio Transcode Warning] PyAV WAV convert failed ({e})")
        return ""


def _convert_ogg_to_mp3(input_path: str) -> str:
    """
    WhatsApp OGG/Opus → clean 16kHz mono for Whisper.
    Prefer system ffmpeg; fall back to PyAV→WAV when ffmpeg is missing.
    """
    try:
        temp_mp3 = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
        temp_mp3_path = temp_mp3.name
        temp_mp3.close()

        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            input_path,
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "64k",
            temp_mp3_path,
        ]

        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
        )

        if result.returncode == 0 and os.path.exists(temp_mp3_path) and os.path.getsize(temp_mp3_path) > 100:
            return temp_mp3_path

        if os.path.exists(temp_mp3_path):
            os.remove(temp_mp3_path)
    except Exception as e:
        print(f"[Audio Transcode Warning] ffmpeg conversion skipped ({e}).")

    wav_path = _convert_ogg_to_wav_pyav(input_path)
    if wav_path:
        return wav_path
    return input_path


_local_whisper = None
_local_whisper_failed = False
_last_transcribe_error = ""
_openai_credits_exhausted = False


def get_last_transcribe_error() -> str:
    return _last_transcribe_error or ""


def _filter_hallucination(raw_text: str) -> str:
    text = (raw_text or "").strip()
    if not text:
        return ""
    compact = text.replace(" ", "").replace("\n", "")
    if not compact:
        return ""
    # Discard repetitive single-character loops (common Whisper failure mode)
    if len(compact) > 4 and len(set(compact)) <= 2:
        print(f"[Whisper Filter] Discarded hallucination text: {text[:80]!r}")
        return ""
    # Discard when one char dominates (e.g. Devanagari nukta spam: परप़़़़़़़)
    if len(compact) >= 12:
        from collections import Counter

        top_char, top_count = Counter(compact).most_common(1)[0]
        if top_count / len(compact) >= 0.45:
            print(
                f"[Whisper Filter] Discarded dominant-char hallucination "
                f"({top_char!r} x{top_count}/{len(compact)}): {text[:80]!r}"
            )
            return ""
    return text


def _transcribe_with_openai(file_path: str, display_name: str) -> str:
    """Cloud Whisper-1. Returns '' on failure (billing, network, etc.)."""
    global _last_transcribe_error, _openai_credits_exhausted
    if _openai_credits_exhausted:
        _last_transcribe_error = "OpenAI credits exhausted (cached)"
        return ""

    client = _get_client()
    if client is None:
        _last_transcribe_error = "OPENAI_API_KEY missing"
        return ""

    is_ogg = file_path.lower().endswith(".ogg") or file_path.lower().endswith(".opus")
    processed_path = _convert_ogg_to_mp3(file_path) if is_ogg else file_path
    cleanup_temp = processed_path != file_path

    try:
        from app.services.token_tracker import log_llm_usage

        with open(processed_path, "rb") as audio_file:
            transcript = client.audio.transcriptions.create(
                model="whisper-1",
                file=audio_file,
                prompt=VOICE_EXTRACTION_PROMPT,
                temperature=0.0,
            )
            try:
                audio_sec = max(os.path.getsize(file_path) / 16_000.0, 0.5)
            except OSError:
                audio_sec = 1.0
            log_llm_usage(
                "Audio_Whisper",
                display_name,
                transcript,
                duration_seconds=audio_sec,
                model_name="whisper-1",
                total_tokens=0,
            )
            return _filter_hallucination(getattr(transcript, "text", None) or "")
    except Exception as e:
        err = str(e)
        _last_transcribe_error = err
        if "429" in err or "credits" in err.lower():
            _openai_credits_exhausted = True
            print("[Whisper] OpenAI credits exhausted — switching to local faster-whisper for this process.")
        print(f"[Whisper Error] OpenAI failed on {display_name}: {e}")
        return ""
    finally:
        if cleanup_temp and os.path.exists(processed_path):
            try:
                os.remove(processed_path)
            except Exception:
                pass


def _get_local_whisper():
    """Lazy-load faster-whisper tiny/base model for offline fallback."""
    global _local_whisper, _local_whisper_failed
    if _local_whisper is not None or _local_whisper_failed:
        return _local_whisper
    try:
        from faster_whisper import WhisperModel

        model_size = (os.getenv("LOCAL_WHISPER_MODEL") or "base").strip() or "base"
        print(f"[Whisper Local] Loading faster-whisper model '{model_size}' (cpu/int8)…")
        _local_whisper = WhisperModel(model_size, device="cpu", compute_type="int8")
        print("[Whisper Local] Model ready.")
        return _local_whisper
    except Exception as e:
        _local_whisper_failed = True
        print(f"[Whisper Local] Unavailable: {e}")
        return None


def _transcribe_with_local(file_path: str, display_name: str) -> str:
    """Offline faster-whisper fallback when OpenAI Whisper is unavailable."""
    global _last_transcribe_error
    model = _get_local_whisper()
    if model is None:
        return ""

    # Prefer a clean mono WAV/MP3 for local decode (WhatsApp OGG often hallucinates)
    is_ogg = file_path.lower().endswith(".ogg") or file_path.lower().endswith(".opus")
    processed_path = _convert_ogg_to_mp3(file_path) if is_ogg else file_path
    cleanup_temp = processed_path != file_path

    try:
        def _run(language=None):
            segments, info = model.transcribe(
                processed_path,
                beam_size=5,
                vad_filter=True,
                temperature=0.0,
                condition_on_previous_text=False,
                compression_ratio_threshold=2.4,
                no_speech_threshold=0.6,
                language=language,
            )
            parts = []
            for seg in segments:
                bit = (getattr(seg, "text", None) or "").strip()
                if bit:
                    parts.append(bit)
            return _filter_hallucination(" ".join(parts)), getattr(info, "language", None)

        text, lang = _run(None)
        # Auto-detect sometimes loops on Hindi WhatsApp notes — retry with hi/en
        if not text:
            for forced in ("hi", "en"):
                text, lang = _run(forced)
                if text:
                    break

        if text:
            print(f"[Whisper Local] OK on {display_name} (lang={lang or '?'}): {text[:80]!r}")
            _last_transcribe_error = ""
            return text

        _last_transcribe_error = "Local transcript empty or filtered"
        return ""
    except Exception as e:
        _last_transcribe_error = str(e)
        print(f"[Whisper Local] Failed on {display_name}: {e}")
        return ""
    finally:
        if cleanup_temp and os.path.exists(processed_path):
            try:
                os.remove(processed_path)
            except Exception:
                pass


def transcribe_audio_file(file_name: str) -> str:
    """
    Transcribe a voice note.
    1) Prefer OpenAI whisper-1 (fast/accurate when billed)
    2) Fall back to local faster-whisper when OpenAI is out of credits / unreachable
    """
    global _last_transcribe_error
    _last_transcribe_error = ""

    if not file_name:
        return ""

    file_path = _resolve_media_file(file_name)
    if not file_path or not os.path.exists(file_path):
        _last_transcribe_error = f"Media file not found: {file_name}"
        return ""

    try:
        if os.path.getsize(file_path) < 150:
            print(
                f"[Whisper Guard] File {file_name} too small or empty "
                f"({os.path.getsize(file_path)} bytes)."
            )
            _last_transcribe_error = "Audio file empty or too small"
            return ""
    except Exception:
        return ""

    text = _transcribe_with_openai(file_path, file_name)
    if text:
        return text

    # OpenAI billing/network failures → local model so Today Desk still works
    return _transcribe_with_local(file_path, file_name)


def encode_image_to_base64(file_path: str) -> str:
    resolved = _resolve_media_file(file_path)
    if not resolved:
        return ""
    try:
        with open(resolved, "rb") as image_file:
            return base64.b64encode(image_file.read()).decode("utf-8")
    except Exception as e:
        print(f"[Vision Error] Could not read image {file_path}: {e}")
        return ""


def extract_image_context(file_name: str, chat_context: str = "") -> str:
    """
    GPT-4o Vision ke through Multi-Domain Images, Handwritten Notes, Medical Reports,
    Govt/Office Forms, aur UI Screenshots se high-precision factual data extract karta hai.
    """
    if not file_name:
        return ""

    file_path = _resolve_media_file(file_name)
    if not file_path:
        return ""

    try:
        if os.path.getsize(file_path) < 5 * 1024:
            print(
                f"[Vision Guard] File {file_name} too small "
                f"({os.path.getsize(file_path)} bytes) — skipping OCR."
            )
            return ""
    except OSError:
        return ""

    ctx = (chat_context or "").strip().lower()
    if "sticker" in ctx:
        print(f"[Vision Guard] Sticker caption for {file_name} — skipping OCR.")
        return ""

    client = _get_client()
    if client is None:
        return ""

    try:
        from app.services.token_tracker import log_llm_usage

        base64_img = encode_image_to_base64(file_path)
        if not base64_img:
            return ""

        prompt = VISION_EXTRACTION_PROMPT.format(chat_context=chat_context or "")
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{_image_mime(file_path)};base64,{base64_img}",
                                "detail": "low",  # Low detail keeps token cost low and latency fast
                            },
                        },
                    ],
                }
            ],
            max_tokens=250,
            temperature=0.1,  # Factual OCR consistency ke liye strict low temperature
        )
        log_llm_usage("Vision_OCR", file_name, response, model_name="gpt-4o")
        choices = getattr(response, "choices", None) or []
        if not choices or not getattr(choices[0], "message", None):
            return ""
        return (choices[0].message.content or "").strip()
    except Exception as e:
        print(f"[Vision Error] Failed on {file_name}: {e}")
        return ""