/**
 * Résolution on-chain des métadonnées de collections ERC-721.
 *
 * Résout : name, symbol, thumbnail_url
 *
 * Stratégie thumbnail (par ordre de priorité) :
 *   1. contractURI() → metadata JSON → image
 *   2. tokenURI(1)   → metadata JSON → image
 *
 * Décodage ABI string générique (supporte offset != 32) :
 *   word0 = offset (en bytes) vers la longueur
 *   word[offset/32] = longueur string
 *   bytes suivants  = UTF-8 data
 */

import { db }     from '../db/client'
import { logger } from '../lib/logger'

const RPC     = process.env.ABSTRACT_RPC_HTTP ?? 'https://api.mainnet.abs.xyz'
const IPFS_GW = 'https://ipfs.io/ipfs/'

// ABI selectors
const SEL_NAME         = '0x06fdde03'
const SEL_SYMBOL       = '0x95d89b41'
const SEL_CONTRACT_URI = '0xe8a3d485'

function normalizeUri(uri: string): string | null {
  if (!uri) return null
  if (uri.startsWith('ipfs://'))                  return IPFS_GW + uri.slice(7)
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri
  if (uri.startsWith('data:'))                    return uri
  return null
}

function encodeUint256(n: number): string {
  return BigInt(n).toString(16).padStart(64, '0')
}

async function fetchMetaFromUri(uri: string): Promise<any | null> {
  const url = normalizeUri(uri)
  if (!url) return null
  if (url.startsWith('data:application/json;base64,')) {
    try {
      return JSON.parse(Buffer.from(url.slice(29), 'base64').toString())
    } catch { return null }
  }
  if (url.startsWith('data:application/json,')) {
    try {
      return JSON.parse(decodeURIComponent(url.slice(22)))
    } catch { return null }
  }
  return fetch(url, { signal: AbortSignal.timeout(6_000) })
    .then(r => r.json() as any)
    .catch(() => null)
}

/**
 * eth_call → decode ABI string
 * Gère correctement tous les offsets ABI (pas seulement offset=32).
 */
async function ethCallString(address: string, selector: string): Promise<string> {
  try {
    const res: any = await fetch(RPC, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: address, data: selector }, 'latest'],
      }),
      signal: AbortSignal.timeout(4_000),
    }).then(r => r.json() as any)

    const hex: string = res?.result ?? ''
    if (!hex || hex === '0x') return ''

    const raw = hex.startsWith('0x') ? hex.slice(2) : hex

    // Fallback bytes32 : réponse trop courte pour être un ABI string encodé
    if (raw.length < 128) {
      return Buffer.from(raw.slice(0, 64).padEnd(64, '0'), 'hex')
        .toString('utf8').replace(/\x00/g, '').trim()
    }

    // Décodage ABI string générique — offset peut être 0x20, 0x40, 0x60…
    const offsetBytes = parseInt(raw.slice(0, 64), 16)   // offset en octets
    const offsetHex   = offsetBytes * 2                   // offset en chars hex
    if (offsetHex + 64 > raw.length) return ''

    const strLen = parseInt(raw.slice(offsetHex, offsetHex + 64), 16)
    if (strLen <= 0 || strLen > 8192) return ''

    const end = offsetHex + 64 + strLen * 2
    if (end > raw.length) return ''

    return Buffer.from(raw.slice(offsetHex + 64, end), 'hex').toString('utf8').trim()
  } catch {
    return ''
  }
}

async function fetchContractImage(address: string): Promise<string | null> {
  // 1. contractURI() — metadata niveau collection (le plus propre)
  try {
    const contractUri = await ethCallString(address, SEL_CONTRACT_URI)
    if (contractUri) {
      const meta = await fetchMetaFromUri(contractUri)
      const img  = meta?.image ?? meta?.image_url ?? meta?.image_details?.url ?? null
      if (img) return normalizeUri(img)
    }
  } catch { /* fallback */ }

  // 2. tokenURI(1) — image du premier token
  try {
    const tokenUri = await ethCallString(address, '0xc87b56dd' + encodeUint256(1))
    if (tokenUri) {
      const meta = await fetchMetaFromUri(tokenUri)
      const img  = meta?.image ?? meta?.image_url ?? meta?.image_details?.url ?? null
      if (img) return normalizeUri(img)
    }
  } catch { /* ignore */ }

  return null
}

/**
 * Résout name + symbol + thumbnail pour les collections sans métadonnées.
 * Tourne au démarrage puis toutes les heures tant qu'il reste des collections sans thumbnail.
 */
export async function resolveCollectionNames(): Promise<void> {
  let rows: { address: string }[]
  try {
    rows = await db.query(
      `SELECT address FROM collections
       WHERE (name IS NULL OR trim(name) = '' OR thumbnail_url IS NULL)
       ORDER BY created_at ASC
       LIMIT 500`
    )
  } catch (err) {
    logger.warn({ err }, 'resolveCollectionNames: DB query failed')
    return
  }

  if (rows.length === 0) return

  logger.info({ count: rows.length }, 'Resolving collection metadata from chain')
  let resolved = 0

  for (const { address } of rows) {
    try {
      const [name, symbol] = await Promise.all([
        ethCallString(address, SEL_NAME),
        ethCallString(address, SEL_SYMBOL),
      ])
      const thumbnail = await fetchContractImage(address)

      if (name || symbol || thumbnail) {
        await db.query(
          `UPDATE collections
           SET name          = COALESCE(NULLIF($1, ''), name),
               symbol        = COALESCE(NULLIF($2, ''), symbol),
               thumbnail_url = COALESCE($3, thumbnail_url)
           WHERE address = $4`,
          [name || null, symbol || null, thumbnail, address]
        )
        resolved++
        logger.info(
          { addr: address.slice(0, 10), name, thumbnail: !!thumbnail },
          'Collection meta resolved'
        )
      }

      // ~25 req/s max pour ne pas saturer le RPC
      await new Promise(r => setTimeout(r, 40))
    } catch (err) {
      logger.debug({ address, err }, 'Could not resolve collection meta')
    }
  }

  logger.info({ resolved, total: rows.length }, 'Collection metadata resolution complete')

  // Si des collections sont encore sans thumbnail → retenter dans 1h
  if (rows.length === 500) {
    setTimeout(() => {
      resolveCollectionNames().catch(err =>
        logger.warn({ err }, 'resolveCollectionNames periodic retry failed')
      )
    }, 60 * 60 * 1000)
  }
}
