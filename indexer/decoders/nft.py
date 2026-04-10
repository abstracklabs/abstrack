"""
Décodeur NFT unifié — ERC-721 transfers + marketplace sales.
Supprimé : BaseDecoder abstrait, ERC-1155, ERC-20, système de plugins.
Retourne directement un dict prêt pour PostgreSQL.
"""

from datetime import datetime, timezone
from typing import Optional
from eth_abi import decode as abi_decode

# ─── Topics suivis ────────────────────────────────────────────────────────────

# keccak256("Transfer(address,address,uint256)") — ERC-721
ERC721_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

# keccak256("OrderFulfilled(bytes32,address,address,address,uint256,uint256,address)")
# Adapter ce hash selon l'ABI réel du marketplace Abstract
ABSTRACT_SALE   = "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcbc6f3"

TRACKED_TOPICS = {ERC721_TRANSFER, ABSTRACT_SALE}

ZERO_ADDR = "0x" + "0" * 40
WEI       = 10 ** 18


def decode_nft_log(
    log: dict,
    block_number: int,
    block_ts: datetime,
    eth_usd: float,
) -> Optional[dict]:
    """
    Décode un log brut et retourne un dict ready-to-insert ou None.
    """
    topics = log.get("topics", [])
    if not topics:
        return None

    # Normalisation des topics (bytes ou str)
    topic0 = topics[0].hex() if isinstance(topics[0], bytes) else topics[0]
    if not topic0.startswith("0x"):
        topic0 = "0x" + topic0

    if topic0 == ERC721_TRANSFER:
        return _decode_erc721(log, topics, block_number, block_ts)

    if topic0 == ABSTRACT_SALE:
        return _decode_sale(log, topics, block_number, block_ts, eth_usd)

    return None


# ─── ERC-721 Transfer ────────────────────────────────────────────────────────

def _decode_erc721(log: dict, topics: list, block_number: int, block_ts: datetime) -> Optional[dict]:
    # ERC-721 : 4 topics (sig + from + to + tokenId)
    # ERC-20  : 3 topics → on ignore
    if len(topics) != 4:
        return None

    from_addr = _topic_addr(topics[1])
    to_addr   = _topic_addr(topics[2])
    token_id  = str(int(_topic_hex(topics[3]), 16))
    collection = _normalize_addr(log.get("address", ""))

    if from_addr == ZERO_ADDR:
        transfer_type = "mint"
    elif to_addr == ZERO_ADDR:
        transfer_type = "burn"
    else:
        transfer_type = "transfer"

    return {
        "kind":            "transfer",
        "tx_hash":         _normalize_hash(log.get("transactionHash", "")),
        "log_index":       int(log.get("logIndex", 0)),
        "block_number":    block_number,
        "block_ts":        block_ts,
        "collection_addr": collection,
        "token_id":        token_id,
        "from_addr":       from_addr,
        "to_addr":         to_addr,
        "transfer_type":   transfer_type,
    }


# ─── Marketplace Sale ────────────────────────────────────────────────────────

def _decode_sale(log: dict, topics: list, block_number: int, block_ts: datetime, eth_usd: float) -> Optional[dict]:
    if len(topics) < 3:
        return None

    seller = _topic_addr(topics[2]) if len(topics) > 2 else ZERO_ADDR
    buyer  = _topic_addr(topics[3]) if len(topics) > 3 else ZERO_ADDR

    try:
        raw = bytes.fromhex(log.get("data", "0x")[2:])
        collection_raw, token_id_raw, price_wei, _currency = abi_decode(
            ["address", "uint256", "uint256", "address"], raw
        )
        collection = collection_raw.lower()
        token_id   = str(token_id_raw)
        price_eth  = price_wei / WEI
    except Exception:
        # ABI mismatch → utilise l'adresse du contrat comme collection
        collection = _normalize_addr(log.get("address", ""))
        token_id   = "0"
        price_eth  = 0.0

    price_usd = round(price_eth * eth_usd, 4) if eth_usd else None

    return {
        "kind":            "sale",
        "tx_hash":         _normalize_hash(log.get("transactionHash", "")),
        "block_number":    block_number,
        "block_ts":        block_ts,
        "collection_addr": collection,
        "token_id":        token_id,
        "seller":          seller,
        "buyer":           buyer,
        "price_eth":       price_eth,
        "price_usd":       price_usd,
        "marketplace":     "abstract_market",
    }


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _topic_hex(t) -> str:
    return t.hex() if isinstance(t, bytes) else t

def _topic_addr(t) -> str:
    h = _topic_hex(t)
    # topic est 32 bytes, l'adresse est dans les 20 derniers
    return "0x" + h[-40:]

def _normalize_addr(a) -> str:
    if isinstance(a, bytes):
        return "0x" + a.hex()
    return a.lower() if a else ZERO_ADDR

def _normalize_hash(h) -> str:
    if isinstance(h, bytes):
        return "0x" + h.hex()
    return h or "0x" + "0" * 64
