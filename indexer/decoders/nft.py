"""
Décodeur NFT unifié — ERC-721, ERC-1155, Seaport sales (Abstract).

Topics suivis :
  ERC721_TRANSFER          : Transfer(address,address,uint256)       — ERC-721 (4 topics)
  ERC1155_TRANSFER_SINGLE  : TransferSingle(address,address,address,uint256,uint256)
  ERC1155_TRANSFER_BATCH   : TransferBatch(address,address,address,uint256[],uint256[])
  SEAPORT_ORDER            : OrderFulfilled — Seaport 1.x

Seaport OrderFulfilled — deux variantes selon déploiement :

  Variante A — Abstract (3 topics, orderHash NON indexé) :
    topic[0] = keccak256(signature)
    topic[1] = offerer indexed   → seller
    topic[2] = zone    indexed
    data     = abi_encode(bytes32 orderHash, address recipient, SpentItem[], ReceivedItem[])

  Variante B — Standard Seaport (4 topics, orderHash indexé) :
    topic[0] = keccak256(signature)
    topic[1] = orderHash indexed
    topic[2] = offerer   indexed → seller
    topic[3] = zone      indexed
    data     = abi_encode(address recipient, SpentItem[], ReceivedItem[])

  SpentItem    = (uint8 itemType, address token, uint256 identifier, uint256 amount)
  ReceivedItem = (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)

  itemType : 0=ETH natif, 1=ERC20, 2=ERC721, 3=ERC1155, 4=ERC721+criteria, 5=ERC1155+criteria

BUNDLE SALES :
  Un OrderFulfilled peut contenir plusieurs NFTs dans offer[].
  On génère une vente par NFT, le prix est réparti équitablement.
  Les log_index des items 1+ utilisent l'espace offset [base + 100_000 * i]
  pour éviter les collisions avec les vrais logIndex (toujours < 10_000 par bloc).

Retour : decode_nft_log() retourne toujours list[dict] (vide si non reconnu).
"""

import logging
from datetime import datetime
from eth_abi import decode as abi_decode

logger = logging.getLogger("indexer.decoder")

# ─── Topics ───────────────────────────────────────────────────────────────────

# keccak256("Transfer(address,address,uint256)") — ERC-721 uniquement (4 topics)
ERC721_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

# keccak256("TransferSingle(address,address,address,uint256,uint256)")
ERC1155_TRANSFER_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427243025f8062be770d6113cf00"

# keccak256("TransferBatch(address,address,address,uint256[],uint256[])")
ERC1155_TRANSFER_BATCH = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb"

# keccak256("OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])")
# Identique pour Seaport 1.1 / 1.4 / 1.5 / 1.6
SEAPORT_ORDER = "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcbc6f3"

TRACKED_TOPICS = {ERC721_TRANSFER, ERC1155_TRANSFER_SINGLE, ERC1155_TRANSFER_BATCH, SEAPORT_ORDER}

# Contrats Seaport connus → nom de marketplace
_SEAPORT_CONTRACTS: dict[str, str] = {
    "0x0000000000000068f116a894984e2db1123eb395": "opensea",   # Seaport 1.6 Abstract
    "0x00000000000000adc04c56bf30ac9d3c0aaf14dc": "opensea",   # Seaport 1.5 Ethereum
    "0x00000000000001ad428e4906ae43d8f9852d0dd6": "opensea",   # Seaport 1.4 Ethereum
}

# WETH sur Abstract (connus — plusieurs déploiements possibles)
WETH_ADDRESSES = {
    "0x3439153eb7af838ad19d56e1571fbd09333c2809",  # WETH Abstract v1
    "0x4300000000000000000000000000000000000004",  # WETH Blast/Abstract L2 courant
}

ZERO_ADDR = "0x" + "0" * 40
WEI       = 10 ** 18

# itemType NFT Seaport
NFT_ITEM_TYPES = {2, 3, 4, 5}

# Types d'ABI pour Seaport
_SPENT_ITEM    = "(uint8,address,uint256,uint256)"
_RECV_ITEM     = "(uint8,address,uint256,uint256,address)"
_ABI_WITH_HASH = ["bytes32", "address", f"{_SPENT_ITEM}[]", f"{_RECV_ITEM}[]"]
_ABI_NO_HASH   = ["address",            f"{_SPENT_ITEM}[]", f"{_RECV_ITEM}[]"]

# Offset log_index pour les items 1+ d'un bundle (évite collision avec vrais logIndex < 10_000)
_BUNDLE_LOG_OFFSET = 100_000
# Offset pour ERC-1155 batch items (distinct de bundle)
_BATCH_LOG_OFFSET  = 10_000


def decode_nft_log(
    log: dict,
    block_number: int,
    block_ts: datetime,
    eth_usd: float,
) -> list[dict]:
    """
    Décode un log Ethereum en événement(s) NFT.
    Retourne une liste (vide si non reconnu, plusieurs éléments pour bundles/batches).
    """
    topics = log.get("topics", [])
    if not topics:
        return []

    topic0 = _topic_hex(topics[0])

    if topic0 == ERC721_TRANSFER:
        r = _decode_erc721(log, topics, block_number, block_ts)
        return [r] if r else []

    if topic0 == ERC1155_TRANSFER_SINGLE:
        r = _decode_erc1155_single(log, topics, block_number, block_ts)
        return [r] if r else []

    if topic0 == ERC1155_TRANSFER_BATCH:
        return _decode_erc1155_batch(log, topics, block_number, block_ts)

    if topic0 == SEAPORT_ORDER:
        # Retourne directement la liste (peut contenir plusieurs ventes pour un bundle)
        return _decode_seaport_sale(log, topics, block_number, block_ts, eth_usd)

    return []


# ─── ERC-721 Transfer ────────────────────────────────────────────────────────

def _decode_erc721(log: dict, topics: list, block_number: int, block_ts: datetime):
    # ERC-721 : exactement 4 topics (sig + from + to + tokenId indexé)
    # ERC-20  : 3 topics (tokenId dans data) → ignoré
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
        "log_index":       _parse_log_index(log),
        "block_number":    block_number,
        "block_ts":        block_ts,
        "collection_addr": collection,
        "token_id":        token_id,
        "from_addr":       from_addr,
        "to_addr":         to_addr,
        "transfer_type":   transfer_type,
        "quantity":        1,
        "token_standard":  "ERC721",
    }


# ─── ERC-1155 TransferSingle ─────────────────────────────────────────────────

def _decode_erc1155_single(log: dict, topics: list, block_number: int, block_ts: datetime):
    # TransferSingle(address operator, address from, address to, uint256 id, uint256 value)
    # topics : [sig, operator(indexed), from(indexed), to(indexed)]
    # data   : abi_encode(uint256 id, uint256 value)
    if len(topics) < 4:
        return None

    from_addr  = _topic_addr(topics[2])
    to_addr    = _topic_addr(topics[3])
    collection = _normalize_addr(log.get("address", ""))

    try:
        raw = _log_data_bytes(log)
        token_id, value = abi_decode(["uint256", "uint256"], raw)
    except Exception as e:
        logger.debug(f"ERC1155 TransferSingle decode failed — tx {log.get('transactionHash')}: {e!r}")
        return None

    if from_addr == ZERO_ADDR:
        transfer_type = "mint"
    elif to_addr == ZERO_ADDR:
        transfer_type = "burn"
    else:
        transfer_type = "transfer"

    return {
        "kind":            "transfer",
        "tx_hash":         _normalize_hash(log.get("transactionHash", "")),
        "log_index":       _parse_log_index(log),
        "block_number":    block_number,
        "block_ts":        block_ts,
        "collection_addr": collection,
        "token_id":        str(token_id),
        "from_addr":       from_addr,
        "to_addr":         to_addr,
        "transfer_type":   transfer_type,
        "quantity":        int(value),
        "token_standard":  "ERC1155",
    }


# ─── ERC-1155 TransferBatch ───────────────────────────────────────────────────

def _decode_erc1155_batch(log: dict, topics: list, block_number: int, block_ts: datetime) -> list[dict]:
    # TransferBatch(address operator, address from, address to, uint256[] ids, uint256[] values)
    # topics : [sig, operator(indexed), from(indexed), to(indexed)]
    # data   : abi_encode(uint256[] ids, uint256[] values)
    if len(topics) < 4:
        return []

    from_addr  = _topic_addr(topics[2])
    to_addr    = _topic_addr(topics[3])
    collection = _normalize_addr(log.get("address", ""))
    tx_hash    = _normalize_hash(log.get("transactionHash", ""))
    base_idx   = _parse_log_index(log)

    if from_addr == ZERO_ADDR:
        transfer_type = "mint"
    elif to_addr == ZERO_ADDR:
        transfer_type = "burn"
    else:
        transfer_type = "transfer"

    try:
        raw = _log_data_bytes(log)
        ids, values = abi_decode(["uint256[]", "uint256[]"], raw)
    except Exception as e:
        logger.debug(f"ERC1155 TransferBatch decode failed — tx {log.get('transactionHash')}: {e!r}")
        return []

    results = []
    for i, (token_id, value) in enumerate(zip(ids, values)):
        # log_index unique par item du batch
        # Espace réservé : base_idx * BATCH_OFFSET + i (max i limité à BATCH_OFFSET-1)
        item_log_idx = base_idx * _BATCH_LOG_OFFSET + min(i, _BATCH_LOG_OFFSET - 1)
        results.append({
            "kind":            "transfer",
            "tx_hash":         tx_hash,
            "log_index":       item_log_idx,
            "block_number":    block_number,
            "block_ts":        block_ts,
            "collection_addr": collection,
            "token_id":        str(token_id),
            "from_addr":       from_addr,
            "to_addr":         to_addr,
            "transfer_type":   transfer_type,
            "quantity":        int(value),
            "token_standard":  "ERC1155",
        })

    return results


# ─── Seaport OrderFulfilled ───────────────────────────────────────────────────

def _decode_seaport_sale(
    log: dict,
    topics: list,
    block_number: int,
    block_ts: datetime,
    eth_usd: float,
) -> list[dict]:
    """
    Décode un log Seaport OrderFulfilled en une ou plusieurs ventes.

    Un ordre Seaport peut contenir plusieurs NFTs (bundle) dans offer[].
    On génère une vente par NFT, le prix total est réparti équitablement.

    Retourne une liste vide si le log est invalide ou ne contient aucun NFT.
    """
    n_topics = len(topics)

    if n_topics == 3:
        candidates = [
            (_topic_addr(topics[1]), _ABI_WITH_HASH, "A"),
            (_topic_addr(topics[1]), _ABI_NO_HASH,   "A-alt"),
        ]
    elif n_topics == 4:
        candidates = [
            (_topic_addr(topics[2]), _ABI_NO_HASH,   "B"),
            (_topic_addr(topics[2]), _ABI_WITH_HASH, "B-alt"),
        ]
    else:
        logger.debug(
            f"Seaport log with unexpected topic count {n_topics} — "
            f"tx {log.get('transactionHash')} — skipping"
        )
        return []

    raw = _log_data_bytes(log)
    if not raw:
        logger.warning(f"Seaport log has empty data — tx {log.get('transactionHash')}")
        return []

    # Essaie la variante primaire puis la variante de secours
    seller = decoded = abi = variant = None
    for s, a, v in candidates:
        try:
            decoded = abi_decode(a, raw)
            seller, abi, variant = s, a, v
            if v.endswith("-alt"):
                logger.debug(
                    f"Seaport fallback variant {v} succeeded — tx {log.get('transactionHash')}"
                )
            break
        except Exception as exc:
            if not v.endswith("-alt"):
                logger.debug(
                    f"Seaport primary variant {v} failed, trying fallback — "
                    f"tx {log.get('transactionHash')}: {exc!r}"
                )
            else:
                logger.warning(
                    f"Seaport ABI decode failed (both variants) — "
                    f"tx {log.get('transactionHash')}: {exc!r} "
                    f"(data[:32]={log.get('data', '0x')[:66]})"
                )
                return []

    try:
        if abi == _ABI_WITH_HASH:
            _order_hash, recipient, offer, consideration = decoded
        else:
            recipient, offer, consideration = decoded

        buyer = recipient.lower()

        # Prix total = somme ETH natif + WETH dans la consideration
        price_wei_total = sum(
            amount
            for item_type, token, _id, amount, _recv in consideration
            if item_type == 0                                              # ETH natif
            or (item_type == 1 and token.lower() in WETH_ADDRESSES)       # WETH
        )

        # Collecte tous les NFTs dans l'offer (bundle support)
        nft_items = [
            (nft_token, nft_id)
            for item_type, nft_token, nft_id, _amount in offer
            if item_type in NFT_ITEM_TYPES
        ]

        if not nft_items:
            logger.debug(
                f"Seaport sale has no NFT item "
                f"(itemTypes: {[i[0] for i in offer]}) — tx {log.get('transactionHash')}"
            )
            return []

    except Exception as exc:
        logger.warning(
            f"Seaport decode error (variant {variant}) — "
            f"tx {log.get('transactionHash')}: {exc!r}"
        )
        return []

    # Prix réparti équitablement entre tous les NFTs du bundle
    n_nfts = len(nft_items)
    price_eth_each = (price_wei_total // n_nfts) / WEI  # division entière pour éviter les erreurs flottantes

    contract_addr = _normalize_addr(log.get("address", ""))
    marketplace   = _SEAPORT_CONTRACTS.get(contract_addr, "seaport")
    tx_hash       = _normalize_hash(log.get("transactionHash", ""))
    base_log_idx  = _parse_log_index(log)

    if n_nfts > 1:
        logger.info(
            f"Seaport bundle ({marketplace}, variant {variant}): "
            f"{n_nfts} NFTs — {price_eth_each * n_nfts:.4f} ETH total — tx {tx_hash}"
        )

    results = []
    for i, (nft_token, nft_id) in enumerate(nft_items):
        price_usd = round(price_eth_each * eth_usd, 4) if eth_usd and price_eth_each > 0 else None

        # log_index unique par item du bundle
        # Item 0 : log_index réel (rétrocompatible avec les données existantes)
        # Items 1+ : espace offset [base + BUNDLE_OFFSET * i] (jamais atteint par de vrais logIndex)
        log_idx = base_log_idx if i == 0 else base_log_idx + _BUNDLE_LOG_OFFSET * i

        if i == 0:
            logger.info(
                f"Seaport sale ({marketplace}, variant {variant}): "
                f"{nft_token.lower()} #{nft_id} — {price_eth_each:.4f} ETH — tx {tx_hash}"
            )

        results.append({
            "kind":            "sale",
            "tx_hash":         tx_hash,
            "log_index":       log_idx,
            "block_number":    block_number,
            "block_ts":        block_ts,
            "collection_addr": nft_token.lower(),
            "token_id":        str(nft_id),
            "seller":          seller,
            "buyer":           buyer,
            "price_eth":       price_eth_each,
            "price_usd":       price_usd,
            "marketplace":     marketplace,
        })

    return results


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _log_data_bytes(log: dict) -> bytes:
    """Convertit log['data'] en bytes bruts."""
    data = log.get("data", b"")
    if isinstance(data, (bytes, bytearray)):
        return bytes(data)
    s = data if isinstance(data, str) else str(data)
    return bytes.fromhex(s[2:] if s.startswith("0x") else s)

def _topic_hex(t) -> str:
    """Convertit un topic en hex string avec préfixe 0x."""
    if isinstance(t, (bytes, bytearray)):
        return "0x" + t.hex()
    s = str(t)
    return s if s.startswith("0x") else "0x" + s

def _topic_addr(t) -> str:
    """Extrait une adresse Ethereum (20 octets) depuis un topic de 32 octets."""
    h = _topic_hex(t)
    return "0x" + h[-40:].lower()

def _normalize_addr(a) -> str:
    """Normalise une adresse en minuscules avec préfixe 0x."""
    if isinstance(a, (bytes, bytearray)):
        return "0x" + a.hex().lower()
    s = str(a) if a else ""
    if not s:
        return ZERO_ADDR
    return (s if s.startswith("0x") else "0x" + s).lower()

def _normalize_hash(h) -> str:
    """Normalise un hash de transaction en minuscules avec préfixe 0x."""
    if isinstance(h, (bytes, bytearray)):
        return "0x" + h.hex().lower()
    s = str(h) if h else ""
    if not s:
        return "0x" + "0" * 64
    return (s if s.startswith("0x") else "0x" + s).lower()

def _parse_log_index(log: dict) -> int:
    """Extrait logIndex depuis un log web3 (int, hex string, ou bytes)."""
    v = log.get("logIndex", 0)
    if isinstance(v, int):
        return v
    if isinstance(v, (bytes, bytearray)):
        return int.from_bytes(v, "big")
    s = str(v)
    return int(s, 16) if s.startswith("0x") else int(s or "0")
