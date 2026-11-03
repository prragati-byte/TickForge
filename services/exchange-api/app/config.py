"""Settings, read once from environment variables (see docs/CONTRACTS.md section 5)."""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Settings:
    engine_host: str = "127.0.0.1"
    engine_port: int = 9100
    data_dir: str = ".run/data"
    memory_db: bool = False  # tests only: keep trades in memory instead of tickforge_db

    # Knobs for tests; not read from the environment.
    traders_start_running: bool = True
    orders_per_second: float = 4.0  # virtual-trader order rate at speed 1
    tick_seconds: float = 1.0  # how often books, traders and telemetry are pushed
    reconnect_seconds: float = 1.0

    @classmethod
    def from_env(cls) -> "Settings":
        env = os.environ
        return cls(
            engine_host=env.get("TICKFORGE_ENGINE_HOST", "127.0.0.1"),
            engine_port=int(env.get("TICKFORGE_ENGINE_PORT", "9100")),
            data_dir=env.get("TICKFORGE_DATA_DIR", ".run/data"),
            memory_db=env.get("TICKFORGE_MEMORY_DB", "") == "1",
        )
