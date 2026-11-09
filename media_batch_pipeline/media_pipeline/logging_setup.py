"""Dual-file logging: process.log (debug/audit) + error.log (failures)."""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path


PROCESS_LOGGER = "media_pipeline.process"
ERROR_LOGGER = "media_pipeline.error"


def setup_logging(process_log: Path, error_log: Path) -> tuple[logging.Logger, logging.Logger]:
    process_log.parent.mkdir(parents=True, exist_ok=True)
    error_log.parent.mkdir(parents=True, exist_ok=True)

    fmt = logging.Formatter(
        "%(asctime)s | %(levelname)-8s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    process = logging.getLogger(PROCESS_LOGGER)
    process.handlers.clear()
    process.setLevel(logging.DEBUG)
    process.propagate = False
    process_handler = RotatingFileHandler(
        process_log,
        maxBytes=10 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    process_handler.setFormatter(fmt)
    process_handler.setLevel(logging.DEBUG)
    process.addHandler(process_handler)

    errors = logging.getLogger(ERROR_LOGGER)
    errors.handlers.clear()
    errors.setLevel(logging.WARNING)
    errors.propagate = False
    error_handler = RotatingFileHandler(
        error_log,
        maxBytes=5 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    error_handler.setFormatter(fmt)
    error_handler.setLevel(logging.WARNING)
    errors.addHandler(error_handler)

    return process, errors
