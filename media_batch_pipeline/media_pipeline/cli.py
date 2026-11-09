"""Command-line entrypoint."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .config import Settings
from .pipeline import Pipeline


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="media-pipeline",
        description=(
            "Scan a chat/media folder, process files in FIFO order via an AI API, "
            "and resume cleanly from a checkpoint after interruption."
        ),
    )
    parser.add_argument(
        "input_path",
        type=Path,
        help="Directory or single file containing chats, audio, images, or documents",
    )
    parser.add_argument(
        "-o",
        "--output-dir",
        type=Path,
        default=None,
        help="Output directory for state.json, logs, and results (default: ./outputs)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and walk the queue without calling the AI API",
    )
    parser.add_argument(
        "--reset",
        action="store_true",
        help="Ignore any existing checkpoint and start from index 0",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=3,
        help="Max AI/API retries with exponential backoff (default: 3)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    input_path = args.input_path.expanduser().resolve()
    output_dir = (
        args.output_dir.expanduser().resolve()
        if args.output_dir
        else Path(os.getenv("PIPELINE_OUTPUT_DIR", "outputs")).expanduser().resolve()
    )

    settings = Settings(
        input_path=input_path,
        output_dir=output_dir,
        dry_run=bool(args.dry_run),
        max_retries=max(1, int(args.retries)),
        reset_state=bool(args.reset),
    )
    return Pipeline(settings).run()


if __name__ == "__main__":
    sys.exit(main())
