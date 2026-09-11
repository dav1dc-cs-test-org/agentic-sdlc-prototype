export interface LocalTime {
  hour: number;
  minute: number;
  second: number;
}

/**
 * Resolves the local hour (0-23), minute, and second for a given UTC instant
 * in an IANA timezone, using Intl.DateTimeFormat/formatToParts (no vendored
 * timezone database). Pure: takes the instant as an explicit parameter and
 * performs no Date.now(), process.env, or file/network/console I/O.
 */
export function resolveLocalTime(instant: Date, timeZone: string): LocalTime {
  let parts: Intl.DateTimeFormatPart[];
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    parts = formatter.formatToParts(instant);
  } catch {
    throw new Error(`Unrecognised timezone: ${timeZone}`);
  }

  const hour = findPart(parts, 'hour', timeZone);
  const minute = findPart(parts, 'minute', timeZone);
  const second = findPart(parts, 'second', timeZone);

  return { hour, minute, second };
}

function findPart(parts: Intl.DateTimeFormatPart[], type: string, timeZone: string): number {
  const part = parts.find((p) => p.type === type);
  if (!part) {
    throw new Error(`Unrecognised timezone: ${timeZone}`);
  }
  return Number.parseInt(part.value, 10);
}
