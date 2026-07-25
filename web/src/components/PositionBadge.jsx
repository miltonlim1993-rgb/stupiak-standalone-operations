import { positionMeta } from '@/lib/positions'

export default function PositionBadge({ code, positions = [], compact = false, className = '' }) {
  const meta = positionMeta(code, positions)
  return (
    <span
      className={`chefops-position-badge ${compact ? 'is-compact' : ''} ${className}`.trim()}
      data-pattern={meta.pattern || 'plain'}
      style={{ '--position-color': meta.color || '#64748B' }}
      title={`${meta.code} · ${meta.name}`}
    >
      <span className="chefops-position-code">{meta.code}</span>
      {!compact ? <span className="chefops-position-name">{meta.short_name || meta.name}</span> : null}
    </span>
  )
}
