'use client'

import { useQuery } from '@tanstack/react-query'

const API = process.env.NEXT_PUBLIC_API_URL

interface NFTImageProps {
  collection: string
  tokenId:    string | number
  size?:      number   // px, default 40
  className?: string
}

/**
 * Affiche l'image d'un NFT spécifique.
 * Résout tokenURI → metadata → image via le backend (cache 24h).
 */
export function NFTImage({ collection, tokenId, size = 40, className = '' }: NFTImageProps) {
  const { data } = useQuery({
    queryKey:  ['nft-meta', collection, String(tokenId)],
    queryFn:   () =>
      fetch(`${API}/api/v1/collections/${collection}/token/${tokenId}/meta`)
        .then(r => r.json()),
    staleTime: 24 * 60 * 60_000,
    gcTime:    24 * 60 * 60_000,
    retry:     false,
  })

  const imageUrl = data?.image_url

  if (!imageUrl) {
    // Placeholder coloré déterministe basé sur tokenId
    const hue = (Number(tokenId) * 37) % 360
    return (
      <div
        className={`rounded-lg shrink-0 flex items-center justify-center text-white/50 text-xs font-mono ${className}`}
        style={{ width: size, height: size, background: `hsl(${hue}deg 50% 20%)`, minWidth: size }}
      >
        #{String(tokenId).slice(0, 4)}
      </div>
    )
  }

  return (
    <img
      src={imageUrl}
      alt={`#${tokenId}`}
      className={`rounded-lg object-cover shrink-0 ${className}`}
      style={{ width: size, height: size, minWidth: size }}
      onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
      loading="lazy"
    />
  )
}
