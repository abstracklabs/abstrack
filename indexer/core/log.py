"""
Configuration du logging pour l'indexer.

Stratégie :
  - production (LOG_FORMAT=json ou absence de TTY) : JSON structuré sur stdout
  - développement (TTY détecté)                   : format texte coloré lisible

Zéro dépendance externe — utilise uniquement le module `logging` standard.

Champs présents dans chaque log JSON :
  time, level, service, component, msg + champs contextuels

Exemples de sortie production (1 ligne par event) :

  {"time":"2026-04-09T12:00:01Z","level":"INFO","service":"indexer","component":"main","msg":"Indexer starting","last_block":4823100}
  {"time":"2026-04-09T12:00:05Z","level":"INFO","service":"indexer","component":"listener","msg":"Block processed","block":4823105,"sales":2,"transfers":5}
  {"time":"2026-04-09T12:00:08Z","level":"WARNING","service":"indexer","component":"listener","msg":"get_logs timeout","block":4823106}
  {"time":"2026-04-09T12:00:09Z","level":"ERROR","service":"indexer","component":"db","msg":"DB transient error","attempt":1,"error":"connection refused"}

Exemples de sortie développement :

  12:00:01 [INFO ] [listener] Block 4823105 — 2 sales, 5 transfers
  12:00:08 [WARN ] [listener] get_logs timeout at block 4823106 — skipping
  12:00:09 [ERROR] [db]       DB transient error (attempt 1/3): connection refused
"""

import json
import logging
import os
import sys
from datetime import datetime, timezone

SERVICE = "indexer"


class _JsonFormatter(logging.Formatter):
    """Formateur JSON compact — 1 log = 1 ligne, parseable par n'importe quel outil."""

    def format(self, record: logging.LogRecord) -> str:
        # Champs de base
        payload: dict = {
            "time":      datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "level":     record.levelname,
            "service":   SERVICE,
            "component": record.name.removeprefix("indexer.") if record.name.startswith("indexer.") else record.name,
            "msg":       record.getMessage(),
        }

        # Champs extra passés via `extra={}` ou `logging.info("msg", extra={"k": v})`
        for key, val in record.__dict__.items():
            if key not in _STDLIB_ATTRS and not key.startswith("_"):
                payload[key] = val

        # Exception si présente
        if record.exc_info:
            payload["error"]     = str(record.exc_info[1])
            payload["exc_type"]  = record.exc_info[0].__name__ if record.exc_info[0] else None

        return json.dumps(payload, default=str)


class _DevFormatter(logging.Formatter):
    """Format texte lisible pour le développement local."""

    COLORS = {
        "DEBUG":    "\033[36m",   # cyan
        "INFO":     "\033[32m",   # vert
        "WARNING":  "\033[33m",   # jaune
        "ERROR":    "\033[31m",   # rouge
        "CRITICAL": "\033[35m",   # magenta
    }
    RESET = "\033[0m"

    def format(self, record: logging.LogRecord) -> str:
        color     = self.COLORS.get(record.levelname, "")
        level     = f"{color}{record.levelname:<5}{self.RESET}"
        component = record.name.removeprefix("indexer.") if record.name.startswith("indexer.") else record.name
        time      = datetime.now().strftime("%H:%M:%S")
        msg       = record.getMessage()

        base = f"{time} [{level}] [{component:<10}] {msg}"

        if record.exc_info:
            base += f"\n  {record.exc_info[1]}"

        return base


# Attributs stdlib à exclure des champs extra en JSON
_STDLIB_ATTRS = frozenset({
    "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
    "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
    "created", "msecs", "relativeCreated", "thread", "threadName",
    "processName", "process", "taskName", "message",
})


def setup_logging(level: str | None = None) -> None:
    """
    Initialise le logging global.
    Appeler une seule fois au démarrage (dans main.py).

    Args:
        level: Override du niveau (DEBUG, INFO, WARNING, ERROR).
               Par défaut lit LOG_LEVEL depuis l'env, puis INFO.
    """
    log_level_name = (level or os.getenv("LOG_LEVEL", "INFO")).upper()
    log_level      = getattr(logging, log_level_name, logging.INFO)

    # JSON en prod, texte coloré si TTY détecté ou LOG_FORMAT=text forcé
    use_json = (
        os.getenv("LOG_FORMAT", "").lower() == "json"
        or (not sys.stdout.isatty() and os.getenv("LOG_FORMAT", "").lower() != "text")
    )

    formatter = _JsonFormatter() if use_json else _DevFormatter()

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    # Configure le logger racine — tous les sous-loggers en héritent
    root = logging.getLogger()
    root.setLevel(log_level)
    root.handlers.clear()
    root.addHandler(handler)

    # Réduit le bruit des libs tierces
    logging.getLogger("web3").setLevel(logging.WARNING)
    logging.getLogger("asyncio").setLevel(logging.WARNING)
    logging.getLogger("aiohttp").setLevel(logging.WARNING)
    logging.getLogger("asyncpg").setLevel(logging.WARNING)

    fmt = "json" if use_json else "text"
    logging.getLogger("indexer").info(
        f"Logging initialized — level={log_level_name} format={fmt}"
    )
