// Runtime directory access is D1-only.
//
// These compatibility exports remain temporarily because older modules/tests may
// import them, but they must never read Google Sheets or re-enable a bootstrap
// source at runtime. Historical recovery belongs in reviewed offline tooling,
// not in the production request path.

export function legacyDirectoryFallbackEnabled() {
  return false
}

export async function directoryBootstrapComplete() {
  return true
}

export async function markDirectoryBootstrapComplete(_env, details = {}) {
  return {
    status: 'retired',
    completed_at: new Date().toISOString(),
    source: 'd1-only-runtime',
    ...details,
  }
}

export async function listLegacyDirectoryRecordsDuringBootstrap() {
  return []
}

export async function findLegacyDirectoryUserDuringBootstrap() {
  return null
}
