import { getCurrentUser } from './auth.js'
import { errorResponse } from './http.js'

const BUNDLED_SOP_MEDIA = {
  '1AEjqI2ObYFy1BMZxnNpM1f6NyQ5vwGIO': '/sop-media/opening-preparation.webp',
  '1QHBKs2c1dWU8Ccoc7p2Jrz6_7Uqmwu0b': '/sop-media/opening-area.webp',
  '1q9Baqt0f1KBpKPeeNf5WTidytnpBc5Dw': '/sop-media/non-busy-cleaning.webp',
  '1oI6JymrFpRhjP1t1nYBJG16sbLCJJgZ7': '/sop-media/closing-kitchen.webp',
  '1_jxnxW-3qx9Mztv1xj_F37AtmpbxpvGN': '/sop-media/closing-front.webp',
  '1jKT007b8OkgYgCpDGIWvVMGOSIdUlLHx': '/sop-media/toilet-closing.webp',
  '1vr6_TVho-49w_bUPEAdrdBYiYPudgvuE': '/sop-media/garbage-bin-wash.webp',
  '1Ong60hAn7jDsBvVexpk4jK3imbac_7zA': '/sop-media/freezer-deep-clean.webp',
}

export async function handleBundledSopMedia(request, env, url) {
  if (request.method !== 'GET') return null
  const match = url.pathname.match(/^\/api\/files\/([A-Za-z0-9_-]{10,})$/)
  if (!match) return null
  const assetPath = BUNDLED_SOP_MEDIA[match[1]]
  if (!assetPath) return null

  try {
    await getCurrentUser(request, env)

    const assetUrl = new URL(assetPath, url.origin)
    const assetResponse = await env.ASSETS.fetch(new Request(assetUrl, {
      method: 'GET',
      headers: {
        Accept: request.headers.get('Accept') || 'image/webp,image/*,*/*;q=0.8',
      },
    }))
    if (!assetResponse.ok) return null

    const headers = new Headers(assetResponse.headers)
    headers.set('Content-Type', 'image/webp')
    headers.set('Content-Disposition', 'inline')
    headers.set('Cache-Control', 'private, max-age=86400, stale-while-revalidate=604800')
    headers.set('X-ChefOps-Media-Source', 'cloudflare-bundled-sop')
    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers,
    })
  } catch (error) {
    return errorResponse(request, env, error)
  }
}
