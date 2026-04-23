/**
 * Utilitaire fetch centralisé.
 * - Vérifie r.ok avant de parser le JSON
 * - Lance une erreur lisible si le serveur répond 4xx/5xx
 * - React Query captera ces erreurs et affichera un état d'erreur propre
 */
export async function apiFetch<T = unknown>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) {
    throw new Error(`API error ${r.status} — ${r.statusText} (${url})`)
  }
  return r.json() as Promise<T>
}
