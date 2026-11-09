"""FIFO processing orchestrator with checkpoint resume."""

from __future__ import annotations

import json
import logging
import signal
import traceback

from .ai_client import AIClient, AIProcessingError
from .config import Settings
from .display import PipelineDisplay
from .logging_setup import setup_logging
from .media_handler import CorruptMediaError, assert_valid
from .scanner import QueuedFile, scan_input
from .state import PipelineState, StateStore

process_log = logging.getLogger("media_pipeline.process")
error_log = logging.getLogger("media_pipeline.error")


class Pipeline:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.store = StateStore(settings.state_path)
        self.display = PipelineDisplay()
        self._interrupted = False
        self.queue: list[QueuedFile] = []
        self.state: PipelineState | None = None

    def run(self) -> int:
        self.settings.ensure_dirs()
        setup_logging(self.settings.process_log_path, self.settings.error_log_path)
        self._install_signal_handlers()

        try:
            self.queue = scan_input(self.settings.input_path)
        except FileNotFoundError as exc:
            self.display.console.print(f"[red]{exc}[/red]")
            return 2

        process_log.info(
            "Scan complete | input=%s | files=%s",
            self.settings.input_path,
            len(self.queue),
        )

        if not self.queue:
            self.display.console.print("[yellow]No supported files found.[/yellow]")
            return 0

        self.state = self._load_or_create_state()
        start_index = self.state.current_index

        if start_index >= len(self.queue):
            self.display.console.print(
                f"[green]All {len(self.queue)} files already processed "
                f"(checkpoint cursor={start_index}). Use --reset to re-run.[/green]"
            )
            return 0

        try:
            ai = AIClient(self.settings)
        except AIProcessingError as exc:
            self.display.console.print(f"[red]{exc}[/red]")
            error_log.error("%s", exc)
            return 2

        self.state.status = "running"
        self.store.save(self.state)

        self.display.start(total=len(self.queue), resumed_from=start_index)
        self.display.update(
            last_successful_file=self.state.last_successful_file or "—",
            succeeded=self.state.succeeded,
            skipped=len(self.state.skipped),
            errors=len(self.state.failed),
            status="running",
        )

        exit_code = 0
        try:
            for item in self.queue[start_index:]:
                if self._interrupted:
                    self.state.status = "interrupted"
                    self.store.save(self.state)
                    process_log.warning(
                        "Interrupted | cursor=%s | last_ok=%s",
                        self.state.current_index,
                        self.state.last_successful_file,
                    )
                    exit_code = 130
                    break
                self._process_one(ai, item)
            else:
                self.state.status = "completed"
                self.store.save(self.state)
                process_log.info(
                    "Pipeline completed | succeeded=%s skipped=%s failed=%s",
                    self.state.succeeded,
                    len(self.state.skipped),
                    len(self.state.failed),
                )
        except Exception as exc:
            exit_code = 1
            tb = traceback.format_exc()
            error_log.error("Unhandled pipeline error: %s\n%s", exc, tb)
            process_log.error("Unhandled pipeline error: %s", exc)
            if self.state is not None:
                self.state.status = "interrupted"
                self.store.save(self.state)
            self.display.alert(f"Unhandled: {exc}")
        finally:
            self.display.stop()

        if self.state is not None:
            summary = (
                f"status={self.state.status}\n"
                f"cursor={self.state.current_index}/{self.state.total_files}\n"
                f"succeeded={self.state.succeeded}  "
                f"skipped={len(self.state.skipped)}  "
                f"failed={len(self.state.failed)}\n"
                f"last_successful_file={self.state.last_successful_file or '—'}\n"
                f"checkpoint={self.settings.state_path}\n"
                f"results={self.settings.results_path}\n"
                f"process.log={self.settings.process_log_path}\n"
                f"error.log={self.settings.error_log_path}"
            )
            self.display.print_summary(summary)

        return exit_code

    def _process_one(self, ai: AIClient, item: QueuedFile) -> None:
        assert self.state is not None
        rel = str(item.path)
        self.display.update(
            current_file=item.name,
            current_kind=item.kind.value,
            current_index=item.index,
            status=f"validating {item.kind.value}",
        )
        process_log.info(
            "BEGIN | idx=%s/%s | kind=%s | file=%s | sha256=%s",
            item.index + 1,
            self.state.total_files,
            item.kind.value,
            rel,
            item.sha256[:12],
        )

        # Deduplicate by content hash if already processed in a prior run.
        if item.sha256 in self.state.processed_sha256:
            reason = "already processed (sha256 match)"
            process_log.info("SKIP | idx=%s | reason=%s", item.index, reason)
            self.state.mark_skip(item.index, rel, reason, item.sha256)
            self.store.save(self.state)
            self.display.update(
                current_index=self.state.current_index,
                skipped=len(self.state.skipped),
                status="skipped duplicate",
            )
            return

        try:
            integrity = assert_valid(item)
        except CorruptMediaError as exc:
            reason = exc.reason
            error_log.error("Corrupt/unsupported media | file=%s | reason=%s", rel, reason)
            process_log.warning("SKIP | idx=%s | reason=%s", item.index, reason)
            self.state.mark_skip(item.index, rel, reason, item.sha256)
            self.store.save(self.state)
            self.display.alert(f"Skipped corrupt: {item.name} — {reason}")
            self.display.update(
                current_index=self.state.current_index,
                skipped=len(self.state.skipped),
                status="skipped corrupt",
            )
            return

        process_log.info("Integrity OK | %s", integrity.detail)
        self.display.update(status=f"AI · {item.kind.value}")

        try:
            result = ai.process(item, integrity.detail)
        except AIProcessingError as exc:
            tb = traceback.format_exc()
            error_log.error("API failure | file=%s | error=%s\n%s", rel, exc, tb)
            process_log.error("FAIL | idx=%s | error=%s", item.index, exc)
            self.state.mark_failure(item.index, rel, str(exc))
            self.store.save(self.state)
            self.display.alert(f"API fail: {item.name} — {exc}")
            self.display.update(
                current_index=self.state.current_index,
                errors=len(self.state.failed),
                status="failed (advanced)",
            )
            return
        except Exception as exc:
            tb = traceback.format_exc()
            error_log.error("Unexpected failure | file=%s | error=%s\n%s", rel, exc, tb)
            process_log.error("FAIL | idx=%s | unexpected=%s", item.index, exc)
            self.state.mark_failure(item.index, rel, str(exc))
            self.store.save(self.state)
            self.display.alert(f"Error: {item.name} — {exc}")
            self.display.update(
                current_index=self.state.current_index,
                errors=len(self.state.failed),
                status="failed (advanced)",
            )
            return

        self._append_result(item, result.text, result.model, result.latency_sec, result.tokens)
        self.state.mark_success(item.index, rel, item.sha256)
        self.store.save(self.state)

        process_log.info(
            "OK | idx=%s | model=%s | latency=%.2fs | tokens=%s | preview=%s",
            item.index,
            result.model,
            result.latency_sec,
            result.tokens,
            result.raw_preview[:120].replace("\n", " "),
        )
        self.display.update(
            current_index=self.state.current_index,
            last_successful_file=item.name,
            last_latency_sec=result.latency_sec,
            last_tokens=result.tokens,
            succeeded=self.state.succeeded,
            status="ok",
        )

    def _append_result(
        self,
        item: QueuedFile,
        text: str,
        model: str,
        latency: float,
        tokens: int | None,
    ) -> None:
        record = {
            "index": item.index,
            "path": str(item.path),
            "kind": item.kind.value,
            "sha256": item.sha256,
            "model": model,
            "latency_sec": round(latency, 3),
            "tokens": tokens,
            "result": text,
        }
        with self.settings.results_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    def _load_or_create_state(self) -> PipelineState:
        if self.settings.reset_state:
            self.store.reset()
            process_log.info("Checkpoint reset requested")

        existing = self.store.load()
        input_resolved = str(self.settings.input_path.resolve())

        if existing is not None and existing.input_path == input_resolved:
            # Rebind total if the scan count changed; keep cursor if still valid.
            existing.total_files = len(self.queue)
            if existing.current_index > len(self.queue):
                existing.current_index = len(self.queue)
            process_log.info(
                "Resuming from checkpoint | cursor=%s | last_ok=%s | status=%s",
                existing.current_index,
                existing.last_successful_file,
                existing.status,
            )
            self.display.console.print(
                f"[cyan]Resuming[/cyan] at index {existing.current_index}/"
                f"{existing.total_files} "
                f"(last ok: {existing.last_successful_file or '—'})"
            )
            return existing

        state = PipelineState(
            input_path=input_resolved,
            current_index=0,
            total_files=len(self.queue),
            status="idle",
        )
        self.store.save(state)
        process_log.info("New checkpoint created | total_files=%s", len(self.queue))
        return state

    def _install_signal_handlers(self) -> None:
        def _handler(signum, _frame) -> None:
            self._interrupted = True
            process_log.warning("Signal %s received — finishing current step then stopping", signum)
            self.display.alert("Interrupt received — saving checkpoint…")

        # SIGINT always; SIGTERM where available (not always on Windows).
        signal.signal(signal.SIGINT, _handler)
        if hasattr(signal, "SIGTERM"):
            try:
                signal.signal(signal.SIGTERM, _handler)
            except (ValueError, OSError):
                pass
