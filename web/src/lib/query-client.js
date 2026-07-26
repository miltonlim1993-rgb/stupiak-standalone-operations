import { QueryClient } from '@tanstack/react-query'

export const queryClientInstance = new QueryClient({
  defaultOptions: {
    queries: {
      // Operational screens keep their current UI while the user works.
      // Fresh data is loaded on first entry, after explicit saves/refreshes,
      // or when a page is revisited after the cache becomes stale.
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
      refetchInterval: false,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 1,
      structuralSharing: true,
    },
  },
})
