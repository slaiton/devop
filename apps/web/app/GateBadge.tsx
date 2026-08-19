export function GateBadge({ decision }: { decision: 'apto' | 'requiere_revision' | 'no_apto' | null }) {
  if (decision === 'apto') return <span className="status-ok">✓ APTO</span>;
  if (decision === 'requiere_revision') return <span className="status-warn">⚠ REQUIERE REVISIÓN</span>;
  if (decision === 'no_apto') return <span className="status-bad">❌ NO APTO</span>;
  return <span>-</span>;
}
