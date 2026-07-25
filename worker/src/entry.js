import app from './index.js'

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/')
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (isApiPath(url.pathname)) {
      return app.fetch(request, env, ctx)
    }

    return env.ASSETS.fetch(request)
  },

  async scheduled(event, env, ctx) {
    if (typeof app.scheduled === 'function') {
      return app.scheduled(event, env, ctx)
    }
  },
}
