/**
 * Résolution de metadata NFT via tokenURI on-chain.
 *
 * Flux :
 *   1. eth_call tokenURI(tokenId) → URI string
 *   2. Si data: URI base64 → parse inline
 *   3. Si ipfs:// → convertit en HTTP gateway
 *   4. Fetch JSON metadata → retourne image_url + name
 */

const RPC      = process.env.ABSTRACT_RPC_HTTP ?? 'https://api.mainnet.abs.xyz'
const IPFS_GW  = 'https://ipfs.io/ipfs/'
const TIMEOUT  = 6_000

// keccak256("tokenURI(uint256)") → 0xc87b56dd
const SEL_TOKEN_URI = '0xc87b56dd'

export interface NFTMeta {
  image_url: string | null
  name:      string | null
}

/** Encode un uint256 en 32 bytes hex (sans 0x prefix). */
function encodeUint256(n: bigint | number): string {
  return BigInt(n).toString(16).padStart(64, '0')
}

/** Décode une ABI string (offset + length + utf8) ou bytes32 brut. */
function decodeAbiString(hex: string): string {
  const raw = hex.startsWith('0x') ? hex.slice(2) : hex
  if (raw.length < 128) {
    return Buffer.from(raw.slice(0, 64), 'hex').toString('utf8').replace(/\x00/g, '').trim()
  }
  const offset = parseInt(raw.slice(0, 64), 16)
  if (offset === 32) {
    const strLen = parseInt(raw.slice(64, 128), 16)
    if (strLen > 0 && strLen < 4096 && raw.length >= 128 + strLen * 2) {
      return Buffer.from(raw.slice(128, 128 + strLen * 2), 'hex').toString('utf8').trim()
    }
  }
  return Buffer.from(raw.slice(0, 64), 'hex').toString('utf8').replace(/\x00/g, '').trim()
}

/** Normalise une URI : ipfs:// → HTTPS gateway, HTTP → direct. */
function normalizeUri(uri: string): string | null {
  if (!uri) return null
  if (uri.startsWith('ipfs://')) return IPFS_GW + uri.slice(7)
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri
  if (uri.startsWith('data:')) return uri
  return null
}

export async function resolveNFTMeta(
  collection: string,
  tokenId:    string | number,
): Promise<NFTMeta> {
  const blank: NFTMeta = { image_url: null, name: null }

  try {
    // 1. Appel tokenURI(tokenId)
    const callData = SEL_TOKEN_URI + encodeUint256(BigInt(tokenId))
    const rpcRes = await fetch(RPC, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: collection, data: callData }, 'latest'],
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    }).then(r => r.json())

    if (!rpcRes.result || rpcRes.result === '0x') return blank
    const tokenUri = decodeAbiString(rpcRes.result)
    if (!tokenUri) return blank

    // 2. data: URI inline (JSON base64)
    if (tokenUri.startsWith('data:application/json;base64,')) {
      const json = JSON.parse(
        Buffer.from(tokenUri.slice('data:application/json;base64,'.length), 'base64').toString('utf8')
      )
      return {
        image_url: normalizeUri(json.image ?? json.image_url ?? ''),
        name:      json.name ?? null,
      }
    }

    // 3. data: URI inline (JSON brut)
    if (tokenUri.startsWith('data:application/json,')) {
      const json = JSON.parse(decodeURIComponent(tokenUri.slice('data:application/json,'.length)))
      return {
        image_url: normalizeUri(json.image ?? json.image_url ?? ''),
        name:      json.name ?? null,
      }
    }

    // 4. URI externe (HTTP ou IPFS)
    const metaUrl = normalizeUri(tokenUri)
    if (!metaUrl) return blank

    const meta = await fetch(metaUrl, {
      signal: AbortSignal.timeout(TIMEOUT),
    }).then(r => r.json())

    return {
      image_url: normalizeUri(meta.image ?? meta.image_url ?? meta.image_details?.url ?? ''),
      name:      meta.name ?? null,
    }
  } catch {
    return blank
  }
}
