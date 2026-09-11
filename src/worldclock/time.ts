export interface LocalTime {
  hour: number;
  minute: number;
  second: number;
}

/**
 * Resolves the local hour (0-23), minute, and second for a given UTC instant
 * in an arbitrary IANA timezone, using Intl.DateTimeFormat + formatToParts.
 * Throws an Error naming the offending identifier when the timezone is
 * unrecognised, rather than defaulting to UTC or swallowing the error.
 */
export function resolveLocalTime(instant: Date, timeZone: string): LocalTime {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw new Error(`Unrecognised timezone identifier: ${timeZone}`);
  }

  const parts = formatter.formatToParts(instant);
  const hour = findPart(parts, 'hour', timeZone);
  const minute = findPart(parts, 'minute', timeZone);
  const second = findPart(parts, 'second', timeZone);

  return { hour: hour % 24, minute, second };
}

function findPart(parts: Intl.DateTimeFormatPart[], type: 'hour' | 'minute' | 'second', timeZone: string): number {
  const part = parts.find((entry) => entry.type === type);
  if (!part) {
    throw new Error(`Unrecognised timezone identifier: ${timeZone}`);
  }
  return Number.parseInt(part.value, 10);
}
