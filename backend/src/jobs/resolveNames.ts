/**
 * Résolution on-chain des noms/symboles de collections ERC-721.
 *
 * Appelé au démarrage du backend — résout les noms manquants en faisant
 * des eth_call vers le RPC Abstract sans dépendre de l'indexer Python.
 *
 * Décodage manuel ABI string :
 *   word0 = offset (0x20 = 32)
 *   word1 = string length
 *   word2+ = UTF-8 bytes padded to 32-byte words
 */

import { db }     from '../db/client'
import { logger } from '../lib/logger'

const RPC = process.env.ABSTRACT_RPC_HTTP ?? 'https://api.mainnet.abs.xyz'

// ABI function selectors
const SEL_NAME        = '0x06fdde03'
const SEL_SYMBOL      = '0x95d89b41'
const SEL_CONTRACT_URI = '0xe8a3d485'  // contractURI() — collection-level metadata

const IPFS_GW = 'https://ipfs.io/ipfs/'

function normalizeUri(uri: string): string | null {
  if (!uri) return null
  if (uri.startsWith('ipfs://')) return IPFS_GW + uri.slice(7)
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri
  if (uri.startsWith('data:')) return uri
  return null
}

function encodeUint256(n: number): string {
  return BigInt(n).toString(16).padStart(64, '0')
}

async function fetchMetaFromUri(uri: string): Promise<any | null> {
  const url = normalizeUri(uri)
  if (!url) return null
  if (url.startsWith('data:application/json;base64,')) {
    return JSON.parse(Buffer.from(url.slice('data:application/json;base64,'.length), 'base64').toString())
  }
  if (url.startsWith('data:application/json,')) {
    return JSON.parse(decodeURIComponent(url.slice('data:application/json,'.length)))
  }
  return fetch(url, { signal: AbortSignal.timeout(6_000) }).then(r => r.json()).catch(() => null)
}

async function fetchContractImage(address: string): Promise<string | null> {
  // 1. Essaie contractURI() — metadata de collection
  try {
    const contractUri = await ethCallString(address, SEL_CONTRACT_URI)
    if (contractUri) {
      const meta = await fetchMetaFromUri(contractUri)
      const img = meta?.image ?? meta?.image_url ?? meta?.image_details?.url ?? null
      if (img) return normalizeUri(img)
    }
  } catch { /* fallback */ }

  // 2. Fallback : tokenURI(1) — image du premier token
  try {
    const tokenUri = await ethCallString(address, '0xc87b56dd' + encodeUint256(1))
    if (tokenUri) {
      const meta = await fetchMetaFromUri(tokenUri)
      const img = meta?.image ?? meta?.image_url ?? meta?.image_details?.url ?? null
      if (img) return normalizeUri(img)
    }
  } catch { /* ignore */ }

  return null
}

async function ethCallString(address: string, selector: string): Promise<string> {
  try {
    const res = await fetch(RPC, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: address, data: selector }, 'latest'],
      }),
      signal: AbortSignal.timeout(4_000),
    }).then(r => r.json() as any)

    const hex: string = res.result ?? ''
    if (!hex || hex === '0x') return ''

    const raw = hex.startsWith('0x') ? hex.slice(2) : hex
    if (raw.length < 128) {
      // bytes32 fallback (non-standard contracts)
      const buf = Buffer.from(raw.slice(0, 64).padEnd(64, '0'), 'hex')
      return buf.toString('utf8').replace(/\x00/g, '').trim()
    }

    // Standard ABI string: word0=offset, word1=length, word2+=data
    const strLen = parseInt(raw.slice(64, 128), 16)
    if (strLen === 0 || strLen > 8192) return ''
    const strHex = raw.slice(128, 128 + strLen * 2)
    return Buffer.from(strHex, 'hex').toString('utf8').trim()
  } catch {
    return ''
  }
}

export async function resolveCollectionNames(): Promise<void> {
  let rows: { address: string }[]
  try {
    rows = await db.query(
      `SELECT address FROM collections
       WHERE name IS NULL OR trim(name) = '' OR thumbnail_url IS NULL
       LIMIT 200`
    )
  } catch (err) {
    logger.warn({ err }, 'resolveCollectionNames: could not query collections')
    return
  }

  if (rows.length === 0) return
  logger.info({ count: rows.length }, 'Resolving collection names from chain')

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
           SET name = COALESCE(NULLIF($1, ''), name),
               symbol = COALESCE($2, symbol),
               thumbnail_url = COALESCE($3, thumbnail_url)
           WHERE address = $4`,
          [name || null, symbol || null, thumbnail, address]
        )
        logger.info({ address: address.slice(0, 12), name, symbol, thumbnail: !!thumbnail }, 'Collection meta resolved')
        resolved++
      }

      // ~25 req/s max
      await new Promise(r => setTimeout(r, 40))
    } catch (err) {
      logger.debug({ address, err }, 'Could not resolve collection name')
    }
  }

  logger.info({ resolved, total: rows.length }, 'Collection name resolution complete')
}
