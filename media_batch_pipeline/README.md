# Media Batch Pipeline

Production-oriented Python CLI that recursively scans a chat/media folder, queues files in **strict FIFO order**, validates media integrity, sends each item to an AI API, and **resumes from a checkpoint** if the process crashes or is interrupted.

## Features

- Recursive scan for chats, audio, images, and documents
- Ordered FIFO queue with stable lexical paths
- Live Rich terminal UI (progress, active file, latency, error alerts)
- Checkpoint cursor in `state.json` after every step (`current_index`, `total_files`, `last_successful_file`)
- Corrupt/unsupported files logged and skipped without stalling the pipeline
- Dual logs: `process.log` (audit) + `error.log` (exceptions)
- Tenacity retries with exponential backoff (default 3 attempts)
- Graceful SIGINT/SIGTERM handling — checkpoint saved, no silent data loss

## Layout

```
media_batch_pipeline/
├── run.py
├── requirements.txt
├── .env.example
├── README.md
└── media_pipeline/
    ├── cli.py              # argparse entry
    ├── config.py           # settings / paths
    ├── scanner.py          # recursive FIFO queue
    ├── state.py            # atomic state.json checkpoint
    ├── media_handler.py    # integrity checks
    ├── ai_client.py        # OpenAI + tenacity retries
    ├── logging_setup.py    # process.log / error.log
    ├── display.py          # Rich live dashboard
    └── pipeline.py         # orchestrator
```

## Supported extensions

| Kind | Extensions |
|------|------------|
| Chat / transcript | `.txt` `.json` `.jsonl` `.md` `.csv` `.html` `.log` |
| Audio | `.mp3` `.ogg` `.wav` `.m4a` `.flac` `.aac` `.wma` `.opus` |
| Image | `.jpg` `.jpeg` `.png` `.gif` `.webp` `.bmp` `.tiff` |
| Document | `.pdf` `.doc` `.docx` `.rtf` `.odt` |

## Setup

```bash
cd media_batch_pipeline
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
copy .env.example .env   # or: cp .env.example .env
```

Edit `.env` and set `OPENAI_API_KEY`.

## Run

Dry-run (no API calls — validates scan, integrity, checkpoint wiring):

```bash
python run.py "C:\path\to\chats_or_media" --dry-run
```

Full processing:

```bash
python run.py "C:\path\to\chats_or_media" -o .\outputs
```

Or as a module:

```bash
python -m media_pipeline "C:\path\to\chats_or_media" --dry-run
```

### Useful flags

| Flag | Meaning |
|------|---------|
| `-o / --output-dir` | Where `state.json`, logs, and `results.jsonl` are written (default `./outputs`) |
| `--dry-run` | Walk queue + integrity checks without calling OpenAI |
| `--reset` | Discard checkpoint and start from index `0` |
| `--retries N` | Max API retries with exponential backoff (default `3`) |

## Resume behavior

After every file (success, skip, or exhausted failure) the pipeline atomically writes `outputs/state.json`:

```json
{
  "current_index": 12,
  "total_files": 40,
  "last_successful_file": "...",
  "processed_sha256": ["..."],
  "status": "running"
}
```

On restart with the **same input path**, the pipeline:

1. Reloads the checkpoint
2. Continues from `current_index`
3. Skips content already recorded by SHA-256 (no duplicate AI work)

Interrupt with `Ctrl+C` — the current step finishes writing state, then the process exits cleanly.

## Outputs

| File | Purpose |
|------|---------|
| `state.json` | Cursor / resume checkpoint |
| `results.jsonl` | One JSON result per successful file |
| `process.log` | Timestamped info, latency, tokens, previews |
| `error.log` | Corrupt files, API failures, stack traces |

## Processing map

| File kind | AI action |
|-----------|-----------|
| Audio | Whisper transcription |
| Image | GPT vision extraction |
| Chat / document | GPT summary + action items |

## Notes

- Corrupt or unsupported media is logged to `error.log`, skipped, and the cursor advances.
- After API retries are exhausted, the failure is recorded and the cursor still advances so a bad file cannot freeze the queue forever. Re-process failures later with a filtered folder or by editing `state.json`.
- Use `--reset` only when you intentionally want a fresh run for the same input.
