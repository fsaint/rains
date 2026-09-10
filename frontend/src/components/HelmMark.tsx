/**
 * The Helm mark, from the Station brand direction approved 2026-09-10.
 *
 * Two posts and a live crossbar with a node at the centre: the posts are the client and the
 * account, the green bar between them is the address, the dot is the agent. It replaces the
 * lucide Shield, which said "security vendor" rather than "running instrument", and it is the
 * same drawing as helm.mom's nav mark and /favicon.svg.
 *
 * The counter circle has to be painted in the colour of whatever sits behind the mark, so it
 * reads as a hole rather than a dark blob. Every place the app uses it today is on
 * `bg-reins-navy`, which is the default.
 */
type HelmMarkProps = {
  className?: string;
  /** the surface the mark sits on, painted into the counter circle */
  ground?: string;
};

export default function HelmMark({ className = 'w-8 h-8', ground = '#1a2332' }: HelmMarkProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label="Helm"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="5" y="4" width="4" height="24" rx="1.4" fill="#E8EDF2" />
      <rect x="23" y="4" width="4" height="24" rx="1.4" fill="#E8EDF2" />
      <rect x="9" y="14.2" width="14" height="3.6" fill="#34D399" />
      <circle cx="16" cy="16" r="3.6" fill={ground} />
      <circle cx="16" cy="16" r="2" fill="#34D399" />
    </svg>
  );
}
