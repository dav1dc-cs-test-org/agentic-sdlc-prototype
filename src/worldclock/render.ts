import { hourHandAngle, minuteHandAngle, secondHandAngle } from './geometry.ts';
import { resolveLocalTime } from './time.ts';

const FACE_RADIUS = 80;
const CENTER = FACE_RADIUS;
const TICK_OUTER = FACE_RADIUS - 4;
const TICK_INNER = FACE_RADIUS - 14;
const HOUR_HAND_LENGTH = FACE_RADIUS * 0.5;
const MINUTE_HAND_LENGTH = FACE_RADIUS * 0.75;
const SECOND_HAND_LENGTH = FACE_RADIUS * 0.85;

/**
 * Escapes &, <, >, and quote characters with XML entities so a value can be
 * safely embedded in SVG text content or attribute values.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Formats a number with fixed precision, trimming trailing zeros/decimal
 * point, so repeated calls with the same input always produce identical
 * output regardless of floating point representation.
 */
function formatNumber(value: number): string {
  return value.toFixed(3).replace(/\.?0+$/, '');
}

/**
 * Computes the endpoint of a clock hand of the given length and angle
 * (degrees clockwise from twelve), anchored at the clock face centre.
 */
function handPoint(angleDegrees: number, length: number): { x: number; y: number } {
  const radians = ((angleDegrees - 90) * Math.PI) / 180;
  return {
    x: CENTER + length * Math.cos(radians),
    y: CENTER + length * Math.sin(radians),
  };
}

/**
 * Renders a single analog clock face as an SVG <g> group, translated to the
 * given x-offset. Contains one circular face, twelve hour ticks, three hand
 * lines (hour, minute, second), and an escaped text label showing the
 * timezone identifier. Pure: no Date.now(), process.env, or file/network/
 * console I/O; the instant is always the explicit parameter.
 */
export function renderClock(instant: Date, timeZone: string, x: number): string {
  const { hour, minute, second } = resolveLocalTime(instant, timeZone);

  const ticks: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const angle = i * 30;
    const outer = handPoint(angle, TICK_OUTER);
    const inner = handPoint(angle, TICK_INNER);
    ticks.push(
      `<line x1="${formatNumber(inner.x)}" y1="${formatNumber(inner.y)}" x2="${formatNumber(outer.x)}" y2="${formatNumber(outer.y)}" stroke="black" />`,
    );
  }

  const hourPoint = handPoint(hourHandAngle(hour, minute), HOUR_HAND_LENGTH);
  const minutePoint = handPoint(minuteHandAngle(minute, second), MINUTE_HAND_LENGTH);
  const secondPoint = handPoint(secondHandAngle(second), SECOND_HAND_LENGTH);

  const hands = [
    `<line x1="${formatNumber(CENTER)}" y1="${formatNumber(CENTER)}" x2="${formatNumber(hourPoint.x)}" y2="${formatNumber(hourPoint.y)}" stroke="black" stroke-width="4" />`,
    `<line x1="${formatNumber(CENTER)}" y1="${formatNumber(CENTER)}" x2="${formatNumber(minutePoint.x)}" y2="${formatNumber(minutePoint.y)}" stroke="black" stroke-width="3" />`,
    `<line x1="${formatNumber(CENTER)}" y1="${formatNumber(CENTER)}" x2="${formatNumber(secondPoint.x)}" y2="${formatNumber(secondPoint.y)}" stroke="red" stroke-width="1" />`,
  ];

  const label = escapeXml(timeZone);

  return [
    `<g transform="translate(${formatNumber(x)},0)">`,
    `<circle cx="${formatNumber(CENTER)}" cy="${formatNumber(CENTER)}" r="${formatNumber(FACE_RADIUS)}" fill="white" stroke="black" stroke-width="2" />`,
    ...ticks,
    ...hands,
    `<text x="${formatNumber(CENTER)}" y="${formatNumber(FACE_RADIUS * 2 - 6)}" text-anchor="middle" font-size="10">${label}</text>`,
    '</g>',
  ].join('');
}
