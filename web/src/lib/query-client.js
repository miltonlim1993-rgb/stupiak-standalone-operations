import { QueryClient } from '@tanstack/react-query'

export const queryClientInstance = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchInterval: 20_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: 'always',
      refetchOnReconnect: 'always',
      retry: 1,
    },
  },
})
