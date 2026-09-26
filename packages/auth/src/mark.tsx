/**
 * <DrobekMark>: the drobek mascot as inline SVG, drawn from the shared pixel
 * map in @drobek/email/mascot (the same crumb www, the favicon and the e-mails
 * show).
 * `idle` adds the www idle loop — a hop every 3.2 s with the crumb bouncing
 * on landing, blinks and glances on their own clocks — and is off for anyone
 * who prefers reduced motion. Decorative: hidden from assistive tech unless
 * a `title` is given.
 */
import { MASCOT_HEIGHT, MASCOT_RECTS, MASCOT_WIDTH } from '@drobek/email/mascot';

export { mascotDataUri } from '@drobek/email/mascot';

const IDLE_CSS = `@media (prefers-reduced-motion: no-preference){
.dm-idle .dm-body,.dm-idle .dm-crumb,.dm-idle .dm-eyes,.dm-idle .dm-lid{animation:3.2s step-end infinite}
.dm-idle .dm-body{animation-name:dm-hop}.dm-idle .dm-crumb{animation-name:dm-crumb}
.dm-idle .dm-eyes{animation-name:dm-look;animation-duration:7.9s}.dm-idle .dm-lid{animation-name:dm-blink;animation-duration:5.3s}}
@keyframes dm-hop{0%{transform:none}72%{transform:translateY(-1px)}76%{transform:translateY(-2px)}84%{transform:translateY(-1px)}88%{transform:none}}
@keyframes dm-crumb{0%{transform:none}88%{transform:translateY(-1px)}94%{transform:none}}
@keyframes dm-look{0%{transform:none}22%{transform:translateX(-1px)}36%{transform:none}58%{transform:translateX(1px)}70%{transform:none}}
@keyframes dm-blink{0%{opacity:1}40%{opacity:0}42%{opacity:1}47%{opacity:0}49%{opacity:1}}`;

function rects(part: 'body' | 'lid' | 'eye' | 'crumb') {
  return MASCOT_RECTS.filter((r) => r.part === part).map((r) => (
    <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
  ));
}

export function DrobekMark({ size = 32, idle = false, title }: { size?: number; idle?: boolean; title?: string }) {
  const height = Math.round((size * MASCOT_HEIGHT) / MASCOT_WIDTH);
  return (
    <svg
      viewBox={`0 0 ${MASCOT_WIDTH} ${MASCOT_HEIGHT}`}
      width={size}
      height={height}
      shapeRendering="crispEdges"
      className={idle ? 'dm-idle' : undefined}
      style={{ display: 'block', overflow: 'visible' }}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-testid="drobek-mark"
    >
      {idle ? <style>{IDLE_CSS}</style> : null}
      <g className="dm-body">
        {rects('body')}
        <g className="dm-eyes">
          <g className="dm-lid">{rects('lid')}</g>
          {rects('eye')}
        </g>
      </g>
      <g className="dm-crumb">{rects('crumb')}</g>
    </svg>
  );
}
