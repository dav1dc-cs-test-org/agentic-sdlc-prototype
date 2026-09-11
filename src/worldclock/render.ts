import { hourHandAngle, minuteHandAngle, secondHandAngle } from './geometry.ts';
import { resolveLocalTime } from './time.ts';

const FACE_RADIUS = 90;
const CENTER = 100;
const HOUR_HAND_LENGTH = 45;
const MINUTE_HAND_LENGTH = 65;
const SECOND_HAND_LENGTH = 75;
const TICK_INNER_RADIUS = 78;

/**
 * Escapes &, <, >, and quote characters so a string is safe to embed inside
 * SVG text content or attribute values.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function format(value: number): string {
  return value.toFixed(3);
}

/** Computes the (x, y) endpoint of a clock hand given its angle and length. */
function handPoint(angleDegrees: number, length: number): { x: number; y: number } {
  const radians = ((angleDegrees - 90) * Math.PI) / 180;
  return {
    x: CENTER + length * Math.cos(radians),
    y: CENTER + length * Math.sin(radians),
  };
}

function renderHourTicks(): string {
  const ticks: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const angle = i * 30;
    const inner = handPoint(angle, TICK_INNER_RADIUS);
    const outer = handPoint(angle, FACE_RADIUS);
    ticks.push(
      `<line x1="${format(inner.x)}" y1="${format(inner.y)}" x2="${format(outer.x)}" y2="${format(outer.y)}" stroke="black" stroke-width="2" />`,
    );
  }
  return ticks.join('');
}

/**
 * Renders a single analog clock face as an SVG <g> group translated by x,
 * containing a circular face, twelve hour ticks, three hands (hour, minute,
 * second), and a text label showing the escaped timezone identifier. Pure:
 * the instant is an explicit parameter with no Date.now(), process.env, or
 * file/network/console I/O.
 */
export function renderClock(instant: Date, timeZone: string, x: number): string {
  const { hour, minute, second } = resolveLocalTime(instant, timeZone);

  const hourAngle = hourHandAngle(hour, minute);
  const minuteAngle = minuteHandAngle(minute, second);
  const secondAngle = secondHandAngle(second);

  const hourPoint = handPoint(hourAngle, HOUR_HAND_LENGTH);
  const minutePoint = handPoint(minuteAngle, MINUTE_HAND_LENGTH);
  const secondPoint = handPoint(secondAngle, SECOND_HAND_LENGTH);

  const label = escapeXml(timeZone);

  return [
    `<g transform="translate(${format(x)}, 0)">`,
    `<circle cx="${format(CENTER)}" cy="${format(CENTER)}" r="${format(FACE_RADIUS)}" fill="white" stroke="black" stroke-width="2" />`,
    renderHourTicks(),
    `<line x1="${format(CENTER)}" y1="${format(CENTER)}" x2="${format(hourPoint.x)}" y2="${format(hourPoint.y)}" stroke="black" stroke-width="4" />`,
    `<line x1="${format(CENTER)}" y1="${format(CENTER)}" x2="${format(minutePoint.x)}" y2="${format(minutePoint.y)}" stroke="black" stroke-width="3" />`,
    `<line x1="${format(CENTER)}" y1="${format(CENTER)}" x2="${format(secondPoint.x)}" y2="${format(secondPoint.y)}" stroke="red" stroke-width="1" />`,
    `<text x="${format(CENTER)}" y="${format(CENTER + FACE_RADIUS + 20)}" text-anchor="middle" font-size="14">${label}</text>`,
    '</g>',
  ].join('');
}
