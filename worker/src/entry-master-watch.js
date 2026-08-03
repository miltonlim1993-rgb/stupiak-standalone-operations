import app, { OutletRealtimeHub } from './entry.js'
import { refreshAppPacksWhenMasterChanges } from './master-data-watch.js'

const MASTER_WATCH_CRON = '*/2 * * * *'
const MASTER_WATCH_STATE_KEY = 'chefops:master-data-watch:v1'

async function masterWatchStatus(env) {
  const configured = Boolean(env.GOOGLE_MASTER_SPREADSHEET_ID || env.GOOGLE_SPREADSHEET_ID)
  if (!env.APP_DATA_PACKS?.get) {
    return { configured, state_available: false }
  }

  try {
    const state = await env.APP_DATA_PACKS.get(MASTER_WATCH_STATE_KEY, 'json')
    return {
      configured,
      state_available: Boolean(state),
      spreadsheet_id: String(state?.spreadsheet_id || ''),
      modified_time: String(state?.modified_time || ''),
      published_at: String(state?.published_at || ''),
      packs: Array.isArray(state?.packs) ? state.packs : [],
    }
  } catch (error) {
    console.error('Unable to read Master watcher health state', error)
    return {
      configured,
      state_available: false,
      status_error: String(error?.message || error).slice(0, 300),
    }
  }
}

export default {
  ...app,

  async fetch(request, env, ctx) {
    const response = await app.fetch(request, env, ctx)
    const url = new URL(request.url)
    if (request.method !== 'GET' || url.pathname !== '/api/health' || !response.ok) return response

    try {
      const payload = await response.clone().json()
      const watch = await masterWatchStatus(env)
      const headers = new Headers(response.headers)
      headers.set('Content-Type', 'application/json; charset=utf-8')
      return new Response(JSON.stringify({
        ...payload,
        deployment: {
          ...(payload.deployment || {}),
          master_data_watch: {
            policy: 'drive-modified-time-v1',
            cron: MASTER_WATCH_CRON,
            enabled: true,
            ...watch,
          },
        },
      }), {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    } catch (error) {
      console.error('Unable to augment health with Master watcher status', error)
      return response
    }
  },

  async scheduled(event, env, ctx) {
    if (String(event?.cron || '') === MASTER_WATCH_CRON) {
      const refresh = refreshAppPacksWhenMasterChanges(env)
        .then((result) => {
          if (result.changed) {
            console.log('Master data changed; app packs published', result)
          }
          return result
        })
        .catch((error) => {
          console.error('Master data watcher failed', error)
          throw error
        })
      ctx.waitUntil(refresh)
      return
    }

    if (typeof app.scheduled === 'function') {
      return app.scheduled(event, env, ctx)
    }
  },
}

export { OutletRealtimeHub }
