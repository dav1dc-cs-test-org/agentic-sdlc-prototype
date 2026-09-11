import { renderClock } from './render.ts';

const CLOCK_WIDTH = 200;
const CLOCK_HEIGHT = 240;

export interface RenderClocksOptions {
  clockWidth?: number;
  clockHeight?: number;
}

function format(value: number): string {
  return value.toFixed(3);
}

/**
 * Assembles one or more analog clock faces into a single deterministic SVG
 * document, one clock per supplied IANA timezone, laid out left to right in
 * the order given. Duplicate timezones render independently. An empty
 * timeZones array yields a valid, well-formed empty SVG document rather than
 * throwing. Pure: the instant is an explicit parameter with no Date.now(),
 * process.env, or file/network/console I/O.
 */
export function renderClocks(instant: Date, timeZones: string[], options?: RenderClocksOptions): string {
  const clockWidth = options?.clockWidth ?? CLOCK_WIDTH;
  const clockHeight = options?.clockHeight ?? CLOCK_HEIGHT;
  const width = clockWidth * timeZones.length;

  const groups = timeZones.map((timeZone, index) => renderClock(instant, timeZone, index * clockWidth)).join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${format(width)}" height="${format(clockHeight)}" viewBox="0 0 ${format(width)} ${format(clockHeight)}">`,
    groups,
    '</svg>',
  ].join('');
}
