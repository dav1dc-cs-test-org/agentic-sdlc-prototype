export interface LocalTime {
  hour: number;
  minute: number;
  second: number;
}

/**
 * Resolves the local hour (0-23), minute, and second for a given UTC instant
 * in the given IANA timezone. Pure: the instant is always the explicit
 * parameter, never Date.now(). Throws an Error naming the offending
 * timezone identifier when it is unrecognised, rather than defaulting to UTC.
 */
export function resolveLocalTime(instant: Date, timeZone: string): LocalTime {
  let parts: Intl.DateTimeFormatPart[];
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    parts = formatter.formatToParts(instant);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unrecognised IANA timezone identifier: "${timeZone}" (${reason})`);
  }

  const byType = (type: Intl.DateTimeFormatPartTypes): number => {
    // formatToParts always includes hour/minute/second parts once the
    // formatter above has been constructed successfully for this options set.
    const part = parts.find((candidate) => candidate.type === type)!;
    return Number.parseInt(part.value, 10);
  };

  const hour = byType('hour') % 24;
  const minute = byType('minute');
  const second = byType('second');

  return { hour, minute, second };
}
