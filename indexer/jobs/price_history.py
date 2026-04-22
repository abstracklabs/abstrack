"""
Historique des prix ETH/USD — CoinGecko daily.

fetch_eth_price_history() récupère les prix depuis CoinGecko et les stocke en DB.
Appelé une fois au démarrage de l'indexer.

Granularité : journalière (suffisante pour les stats NFT).
Source      : CoinGecko /coins/ethereum/market_chart/range (gratuit, sans clé API).
"""

import logging
from datetime import date, datetime, timezone

import aiohttp

logger = logging.getLogger("indexer.price_history")

_COINGECKO_URL = (
    "https://api.coingecko.com/api/v3/coins/ethereum/market_chart/range"
    "?vs_currency=usd&from={from_ts}&to={to_ts}"
)

# Abstract chain launched Jan 27 2025 — on part de Jan 1 2024 pour avoir de la marge
_HISTORY_FROM = datetime(2024, 1, 1, tzinfo=timezone.utc)


async def ensure_eth_price_history(db, http_session: aiohttp.ClientSession) -> int:
    """
    Vérifie si les prix historiques ETH/USD sont à jour.
    Si absent ou incomplet, récupère les données manquantes depuis CoinGecko.
    Retourne le nombre de jours insérés (0 = déjà à jour).
    """
    try:
        latest = await db.get_latest_eth_price_date()
        today  = date.today()

        if latest and (today - latest).days <= 1:
            logger.info(f"ETH price history up to date (latest: {latest})")
            return 0

        # Départ : depuis la dernière date connue ou depuis le début de l'historique
        if latest:
            from_dt = datetime(latest.year, latest.month, latest.day, tzinfo=timezone.utc)
        else:
            from_dt = _HISTORY_FROM

        from_ts = int(from_dt.timestamp())
        to_ts   = int(datetime.now(timezone.utc).timestamp())

        logger.info(
            f"Fetching ETH price history from CoinGecko "
            f"(from={from_dt.date()} to={today}, ~{(today - from_dt.date()).days} days)"
        )

        url = _COINGECKO_URL.format(from_ts=from_ts, to_ts=to_ts)
        async with http_session.get(url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
            if resp.status == 429:
                logger.warning("CoinGecko rate-limited (429) — price history not updated")
                return 0
            if resp.status != 200:
                logger.warning(f"CoinGecko returned HTTP {resp.status} — price history not updated")
                return 0
            payload = await resp.json()

        prices_raw = payload.get("prices", [])
        if not prices_raw:
            logger.warning("CoinGecko returned empty prices list")
            return 0

        # Un prix par jour (CoinGecko peut retourner plusieurs points/jour sur courte période)
        # On garde la valeur de clôture (dernier point de la journée)
        daily: dict[date, float] = {}
        for ts_ms, price in prices_raw:
            d = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).date()
            daily[d] = price  # écrase → garde le dernier (clôture)

        prices = [
            {"date": d, "price_usd": round(price, 4)}
            for d, price in sorted(daily.items())
        ]

        inserted = await db.store_eth_prices(prices)
        logger.info(f"ETH price history: {inserted} day(s) inserted/updated (total {len(prices)} fetched)")
        return inserted

    except Exception as e:
        logger.warning(
            f"ensure_eth_price_history failed: {e!r} — "
            f"price_usd will be NULL for historical sales"
        )
        return 0
