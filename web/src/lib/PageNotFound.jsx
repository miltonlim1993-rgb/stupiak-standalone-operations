import { Link, useLocation } from 'react-router-dom'

export default function PageNotFound() {
  const location = useLocation()
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="max-w-md w-full text-center space-y-5">
        <h1 className="text-7xl font-light text-muted-foreground/30">404</h1>
        <div>
          <h2 className="text-2xl font-semibold">Page not found</h2>
          <p className="mt-2 text-muted-foreground">The route “{location.pathname}” does not exist in ChefOps.</p>
        </div>
        <Link to="/" className="inline-flex px-4 py-2 rounded-md border border-border hover:bg-muted">Go home</Link>
      </div>
    </div>
  )
}
