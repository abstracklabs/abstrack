"""
Abstrack Indexer — point d'entrée.

Logs de démarrage :
  INFO  "Logging initialized"           — format et niveau actifs
  INFO  "Indexer starting"              — avec le last_block connu
  INFO  "Connected to Abstract node"    — connexion RPC établie
  INFO  "Catching up N blocks"          — si blocs manqués
  INFO  "Indexer stopped"               — arrêt propre
  ERROR "Fatal startup error"           — si erreur irrécupérable au boot
"""

import asyncio
import logging
import os
import signal
import sys

# setup_logging() DOIT être appelé avant tout autre import qui logue
from core.log import setup_logging
setup_logging()

from core.listener import LiveListener
from storage.db import Database

logger = logging.getLogger("indexer")


async def main():
    db = Database(_env("DATABASE_URL"))

    try:
        await db.connect()
    except RuntimeError as e:
        logger.error("Fatal startup error — cannot connect to PostgreSQL: %s", e)
        sys.exit(1)

    last_block = await db.get_last_block()
    logger.info(
        "Indexer starting",
        extra={
            "last_block":   last_block,
            "rpc_wss":      _mask(_env("ABSTRACT_RPC_WSS")),
            "rpc_http":     _mask(_env("ABSTRACT_RPC_HTTP")),
            "log_level":    os.getenv("LOG_LEVEL", "INFO"),
        }
    )

    listener = LiveListener(
        rpc_wss  = _env("ABSTRACT_RPC_WSS"),
        rpc_http = _env("ABSTRACT_RPC_HTTP"),
        db       = db,
    )

    loop = asyncio.get_running_loop()
    stop = asyncio.Event()

    def _shutdown(sig, _):
        logger.info("Shutdown signal received", extra={"signal": sig.name})
        stop.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _shutdown, sig, None)

    listener_task = asyncio.create_task(listener.start())
    stop_task     = asyncio.create_task(stop.wait())

    try:
        # Attend le premier terminé : soit un crash du listener, soit le signal d'arrêt
        done, pending = await asyncio.wait(
            [listener_task, stop_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        # Annule la tâche encore en cours
        for task in pending:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        # Propage l'exception si le listener a crashé
        for task in done:
            if task.exception():
                raise task.exception()
    except Exception as e:
        logger.error("Unexpected error in main loop: %s", e, exc_info=True)
    finally:
        await listener.stop()
        await db.close()
        logger.info("Indexer stopped cleanly")


def _env(key: str) -> str:
    val = os.getenv(key)
    if not val:
        logger.error(f"Missing required environment variable: {key}")
        sys.exit(1)
    return val


def _mask(url: str) -> str:
    """Masque les credentials dans les URLs pour les logs."""
    if "://" in url and "@" in url:
        scheme, rest = url.split("://", 1)
        _, host_part = rest.split("@", 1)
        return f"{scheme}://***@{host_part}"
    return url


if __name__ == "__main__":
    asyncio.run(main())
