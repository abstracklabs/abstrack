"""
Historique des prix ETH/USD.

Sources (par ordre de priorité) :
  1. CoinGecko Pro/Demo  — si COINGECKO_API_KEY est défini (header x-cg-pro-api-key)
  2. Binance public API  — ETHUSDT daily klines, sans clé, 1 000 bougies/requête

Granularité : journalière (suffisante pour les stats NFT).
Appelé une fois au démarrage de l'indexer.
"""

import logging
import os
from datetime import date, datetime, timezone

import aiohttp

logger = logging.getLogger("indexer.price_history")

# Abstract chain launched Jan 27 2025 — on part de Jan 1 2024 pour avoir de la marge
_HISTORY_FROM = datetime(2024, 1, 1, tzinfo=timezone.utc)

_COINGECKO_URL = (
    "https://api.coingecko.com/api/v3/coins/ethereum/market_chart/range"
    "?vs_currency=usd&from={from_ts}&to={to_ts}"
)
_BINANCE_URL = "https://api.binance.com/api/v3/klines"
_BINANCE_LIMIT = 1000  # max candles per request


async def ensure_eth_price_history(db, http_session: aiohttp.ClientSession) -> int:
    """
    Vérifie si les prix historiques ETH/USD sont à jour.
    Si absent ou incomplet, récupère les données manquantes.
    Retourne le nombre de jours insérés (0 = déjà à jour).
    """
    try:
        latest = await db.get_latest_eth_price_date()
        today  = date.today()

        if latest and (today - latest).days <= 1:
            logger.info(f"ETH price history up to date (latest: {latest})")
            return 0

        if latest:
            from_dt = datetime(latest.year, latest.month, latest.day, tzinfo=timezone.utc)
        else:
            from_dt = _HISTORY_FROM

        logger.info(
            f"Fetching ETH price history "
            f"(from={from_dt.date()} to={today}, "
            f"~{(today - from_dt.date()).days} days)"
        )

        daily = await _fetch_via_binance(http_session, from_dt)

        if not daily:
            logger.warning("All price sources failed — price_usd will be NULL for historical sales")
            return 0

        prices = [
            {"date": d, "price_usd": round(price, 4)}
            for d, price in sorted(daily.items())
        ]

        inserted = await db.store_eth_prices(prices)
        logger.info(
            f"ETH price history: {inserted} day(s) inserted/updated "
            f"(total {len(prices)} fetched)"
        )
        return inserted

    except Exception as e:
        logger.warning(
            f"ensure_eth_price_history failed: {e!r} — "
            f"price_usd will be NULL for historical sales"
        )
        return 0


# ─── CoinGecko ────────────────────────────────────────────────────────────────

async def _fetch_via_coingecko(
    http_session: aiohttp.ClientSession,
    from_dt: datetime,
) -> dict[date, float]:
    """
    Tente CoinGecko avec clé API si disponible (Pro ou Demo).
    Retourne {} si l'appel échoue.
    """
    api_key = os.getenv("COINGECKO_API_KEY", "").strip()
    headers = {}
    if api_key:
        # CoinGecko accepte x-cg-pro-api-key pour le plan Pro
        # et x-cg-demo-api-key pour le plan Demo gratuit
        headers["x-cg-pro-api-key"] = api_key

    from_ts = int(from_dt.timestamp())
    to_ts   = int(datetime.now(timezone.utc).timestamp())
    url     = _COINGECKO_URL.format(from_ts=from_ts, to_ts=to_ts)

    try:
        async with http_session.get(
            url, headers=headers, timeout=aiohttp.ClientTimeout(total=30)
        ) as resp:
            if resp.status == 401:
                logger.info("CoinGecko 401 — no valid API key, switching to Binance")
                return {}
            if resp.status == 429:
                logger.warning("CoinGecko rate-limited (429)")
                return {}
            if resp.status != 200:
                logger.warning(f"CoinGecko HTTP {resp.status}")
                return {}
            payload = await resp.json()

        prices_raw = payload.get("prices", [])
        if not prices_raw:
            return {}

        daily: dict[date, float] = {}
        for ts_ms, price in prices_raw:
            d = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).date()
            daily[d] = price  # dernier point = clôture
        logger.info(f"CoinGecko: fetched {len(daily)} days")
        return daily

    except Exception as e:
        logger.warning(f"CoinGecko fetch error: {e!r}")
        return {}


# ─── Binance ──────────────────────────────────────────────────────────────────

async def _fetch_via_binance(
    http_session: aiohttp.ClientSession,
    from_dt: datetime,
) -> dict[date, float]:
    """
    Binance public API — ETHUSDT daily klines, sans authentification.
    Jusqu'à 1 000 bougies par requête ; on pagine si nécessaire.
    Retourne {} si l'appel échoue.
    """
    daily: dict[date, float] = {}
    start_ms = int(from_dt.timestamp() * 1000)
    end_ms   = int(datetime.now(timezone.utc).timestamp() * 1000)

    try:
        cursor = start_ms
        while cursor < end_ms:
            params = {
                "symbol":    "ETHUSDT",
                "interval":  "1d",
                "startTime": cursor,
                "endTime":   end_ms,
                "limit":     _BINANCE_LIMIT,
            }
            async with http_session.get(
                _BINANCE_URL, params=params, timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status != 200:
                    logger.warning(f"Binance HTTP {resp.status}")
                    break
                klines = await resp.json()

            if not klines:
                break

            for k in klines:
                # [openTime, open, high, low, close, volume, closeTime, ...]
                open_ts_ms = k[0]
                close_price = float(k[4])  # clôture
                d = datetime.fromtimestamp(open_ts_ms / 1000, tz=timezone.utc).date()
                daily[d] = close_price

            # Avance le curseur : dernière bougie open_ts + 1 jour
            last_open_ms = klines[-1][0]
            cursor = last_open_ms + 86_400_000  # +1j en ms

            if len(klines) < _BINANCE_LIMIT:
                break  # dernière page

        if daily:
            logger.info(f"Binance: fetched {len(daily)} days of ETH/USD")
        else:
            logger.warning("Binance returned no klines")

    except Exception as e:
        logger.warning(f"Binance fetch error: {e!r}")

    return daily
