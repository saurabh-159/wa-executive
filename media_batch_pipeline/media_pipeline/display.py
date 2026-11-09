"""Rich live terminal dashboard for pipeline progress."""

from __future__ import annotations

from dataclasses import dataclass, field

from rich.console import Console, Group
from rich.live import Live
from rich.markup import escape
from rich.panel import Panel
from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    SpinnerColumn,
    TextColumn,
    TimeElapsedColumn,
    TimeRemainingColumn,
)
from rich.table import Table
from rich.text import Text


@dataclass
class DisplayState:
    current_file: str = "—"
    current_kind: str = "—"
    current_index: int = 0
    total_files: int = 0
    last_successful_file: str = "—"
    last_latency_sec: float | None = None
    last_tokens: int | None = None
    status: str = "starting"
    errors: int = 0
    skipped: int = 0
    succeeded: int = 0
    last_error: str = ""
    alerts: list[str] = field(default_factory=list)


class PipelineDisplay:
    def __init__(self) -> None:
        self.console = Console()
        self.state = DisplayState()
        self.progress = Progress(
            SpinnerColumn(),
            TextColumn("[bold blue]{task.description}"),
            BarColumn(bar_width=40),
            MofNCompleteColumn(),
            TextColumn("•"),
            TimeElapsedColumn(),
            TextColumn("ETA"),
            TimeRemainingColumn(),
            console=self.console,
            expand=False,
        )
        self._task_id = None
        self._live: Live | None = None

    def start(self, total: int, resumed_from: int = 0) -> None:
        self.state.total_files = total
        self.state.current_index = resumed_from
        self._task_id = self.progress.add_task("Processing", total=total)
        if resumed_from > 0:
            self.progress.update(self._task_id, completed=resumed_from)
        self._live = Live(
            self._render(),
            console=self.console,
            refresh_per_second=8,
            transient=False,
        )
        self._live.start()

    def stop(self) -> None:
        if self._live is not None:
            self._live.update(self._render())
            self._live.stop()
            self._live = None

    def update(self, **kwargs) -> None:
        for key, value in kwargs.items():
            if hasattr(self.state, key):
                setattr(self.state, key, value)
        if self._task_id is not None:
            self.progress.update(
                self._task_id,
                completed=min(self.state.current_index, self.state.total_files),
                description=f"Processing · {self.state.status}",
            )
        if self._live is not None:
            self._live.update(self._render())

    def alert(self, message: str) -> None:
        self.state.alerts.append(message)
        self.state.alerts = self.state.alerts[-5:]
        self.state.last_error = message
        self.update()

    def _render(self) -> Panel:
        s = self.state
        table = Table.grid(padding=(0, 2))
        table.add_column(style="dim", justify="right")
        table.add_column()

        speed = "—"
        if s.last_latency_sec is not None:
            speed = f"{s.last_latency_sec:.2f}s"
            if s.last_tokens is not None:
                speed += f" · {s.last_tokens} tokens"

        table.add_row("Cursor", f"{s.current_index} / {s.total_files}")
        table.add_row(
            "Active",
            f"[{escape(s.current_kind)}] {escape(s.current_file)}",
        )
        table.add_row("Last OK", escape(s.last_successful_file or "—"))
        table.add_row("Speed", speed)
        table.add_row(
            "Counts",
            f"ok={s.succeeded}  skip={s.skipped}  err={s.errors}",
        )
        table.add_row("Status", Text(s.status, style="bold cyan"))

        alert_text = Text()
        if s.alerts:
            for line in s.alerts:
                alert_text.append("⚠ ", style="bold red")
                alert_text.append(line + "\n", style="red")
        else:
            alert_text.append("No errors", style="dim")

        body = Group(
            self.progress,
            table,
            Panel(alert_text, title="Error alerts", border_style="red" if s.alerts else "dim"),
        )
        return Panel(
            body,
            title="Media Batch Pipeline",
            border_style="bright_blue",
            padding=(1, 2),
        )

    def print_summary(self, message: str) -> None:
        self.console.print(Panel(escape(message), title="Run complete", border_style="green"))
