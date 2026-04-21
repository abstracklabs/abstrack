"""
Décodeur NFT unifié — ERC-721 transfers + Seaport 1.6 sales (OpenSea Abstract).

Topics suivis :
  ERC721_TRANSFER  : transfers ERC-721 standards
  SEAPORT_ORDER    : OrderFulfilled Seaport 1.6 (0x0000000000000068F116a894984e2DB1123eB395)

Seaport OrderFulfilled ABI :
  event OrderFulfilled(
      bytes32 orderHash,           topic1 (indexed)
      address indexed offerer,     topic2 (indexed) = SELLER
      address indexed zone,        topic3 (indexed)
      address recipient,           data → BUYER
      SpentItem[] offer,           data → NFT (itemType 2=ERC721, 3=ERC1155)
      ReceivedItem[] consideration data → price ETH/WETH
  )
  SpentItem    = (uint8 itemType, address token, uint256 identifier, uint256 amount)
  ReceivedItem = (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)
"""

import logging
from datetime import datetime, timezone
from typing import Optional
from eth_abi import decode as abi_decode

logger = logging.getLogger("indexer.decoder")

# ─── Topics ───────────────────────────────────────────────────────────────────

# keccak256("Transfer(address,address,uint256)") — ERC-721
ERC721_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

# Seaport 1.5 / 1.6 OrderFulfilled — les deux variants observés on-chain
SEAPORT_ORDER_V15 = "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcbc6f3"
SEAPORT_ORDER_V16 = "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31"

SEAPORT_TOPICS = {SEAPORT_ORDER_V15, SEAPORT_ORDER_V16}
TRACKED_TOPICS = {ERC721_TRANSFER} | SEAPORT_TOPICS

# Adresse Seaport 1.6 sur Abstract (pour filtrage optionnel dans les logs)
SEAPORT_16_ADDR = "0x0000000000000068f116a894984e2db1123eb395"

# WETH sur Abstract
WETH_ABSTRACT   = "0x3439153eb7af838ad19d56e1571fbd09333c2809"

ZERO_ADDR = "0x" + "0" * 40
WEI       = 10 ** 18

# itemType Seaport : 0=ETH, 1=ERC20, 2=ERC721, 3=ERC1155, 4=ERC721+criteria, 5=ERC1155+criteria
NFT_ITEM_TYPES = {2, 3, 4, 5}


def decode_nft_log(
    log: dict,
    block_number: int,
    block_ts: datetime,
    eth_usd: float,
) -> Optional[dict]:
    topics = log.get("topics", [])
    if not topics:
        return None

    topic0 = topics[0].hex() if isinstance(topics[0], bytes) else topics[0]
    if not topic0.startswith("0x"):
        topic0 = "0x" + topic0

    if topic0 == ERC721_TRANSFER:
        return _decode_erc721(log, topics, block_number, block_ts)

    if topic0 in SEAPORT_TOPICS:
        logger.info(f"Seaport OrderFulfilled detected — block {block_number} tx {log.get('transactionHash')} topic0={topic0}")
        return _decode_seaport_sale(log, topics, block_number, block_ts, eth_usd)

    return None


# ─── ERC-721 Transfer ────────────────────────────────────────────────────────

def _decode_erc721(log: dict, topics: list, block_number: int, block_ts: datetime) -> Optional[dict]:
    # ERC-721 : 4 topics (sig + from + to + tokenId) ; ERC-20 : 3 topics → ignoré
    if len(topics) != 4:
        return None

    from_addr  = _topic_addr(topics[1])
    to_addr    = _topic_addr(topics[2])
    token_id   = str(int(_topic_hex(topics[3]), 16))
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


# ─── Seaport 1.6 OrderFulfilled ──────────────────────────────────────────────

def _decode_seaport_sale(
    log: dict,
    topics: list,
    block_number: int,
    block_ts: datetime,
    eth_usd: float,
) -> Optional[dict]:
    """
    topics[0] = event signature
    topics[1] = orderHash (bytes32, indexed)
    topics[2] = offerer   (address, indexed) → seller
    topics[3] = zone      (address, indexed)

    data = abi_encode(
        address recipient,              → buyer
        SpentItem[] offer,              → NFT(s) vendu(s)
        ReceivedItem[] consideration    → paiement ETH/WETH
    )
    """
    if len(topics) < 2:
        return None

    # Seaport 1.6 sur Abstract : 3 topics seulement (orderHash n'est PAS indexé)
    # topics[1] = offerer (seller), topics[2] = zone
    seller = _topic_addr(topics[1])  # offerer = celui qui a listé = vendeur

    try:
        raw = bytes.fromhex(log.get("data", "0x")[2:])

        if len(raw) == 0:
            logger.warning(f"Seaport log has empty data — tx {log.get('transactionHash')}")
            return None

        # ABI Seaport 1.6 sur Abstract :
        # bytes32 orderHash (NON indexé — premier champ du data)
        # address recipient (buyer)
        # SpentItem[] offer
        # ReceivedItem[] consideration
        order_hash, recipient, offer, consideration = abi_decode(
            [
                "bytes32",                                          # orderHash (non-indexed)
                "address",                                          # recipient (buyer)
                "(uint8,address,uint256,uint256)[]",                # SpentItem[]
                "(uint8,address,uint256,uint256,address)[]",        # ReceivedItem[]
            ],
            raw,
        )

        buyer = recipient.lower()

        # Trouve le premier NFT dans l'offer (itemType 2=ERC721, 3=ERC1155)
        nft_item = None
        for item in offer:
            item_type, token, identifier, amount = item
            if item_type in NFT_ITEM_TYPES:
                nft_item = item
                break

        if nft_item is None:
            logger.debug(f"Seaport sale has no NFT item (offer itemTypes: {[i[0] for i in offer]}) — tx {log.get('transactionHash')}")
            return None  # pas un NFT sale

        _, nft_token, nft_id, _ = nft_item
        collection = nft_token.lower()
        token_id   = str(nft_id)

        # Prix = somme des ETH natif + WETH dans la consideration
        price_wei = 0
        for item in consideration:
            item_type, token, identifier, amount, recv = item
            if item_type == 0:  # Native ETH
                price_wei += amount
            elif item_type == 1 and token.lower() == WETH_ABSTRACT:  # WETH
                price_wei += amount

        price_eth = price_wei / WEI

    except Exception as exc:
        logger.warning(f"Seaport ABI decode failed — tx {log.get('transactionHash')}: {exc!r} (data[:32]={log.get('data','0x')[:66]})")
        return None  # ABI mismatch ou données corrompues → on saute

    price_usd = round(price_eth * eth_usd, 4) if eth_usd and price_eth > 0 else None

    logger.info(f"Seaport sale decoded: {collection} #{token_id} — {price_eth:.4f} ETH — tx {log.get('transactionHash')}")

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
        "marketplace":     "opensea",
    }


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _topic_hex(t) -> str:
    return t.hex() if isinstance(t, bytes) else t

def _topic_addr(t) -> str:
    h = _topic_hex(t)
    return "0x" + h[-40:]

def _normalize_addr(a) -> str:
    if isinstance(a, bytes):
        return "0x" + a.hex()
    return a.lower() if a else ZERO_ADDR

def _normalize_hash(h) -> str:
    if isinstance(h, bytes):
        return "0x" + h.hex()
    return h or "0x" + "0" * 64
