import app, { OutletRealtimeHub } from './entry.js'
import { refreshAppPacksWhenMasterChanges } from './master-data-watch.js'

const MASTER_WATCH_CRON = '*/2 * * * *'

export default {
  ...app,

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
