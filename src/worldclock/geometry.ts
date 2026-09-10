/**
 * Normalises a degree value into the range [0, 360).
 */
function normaliseDegrees(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * The second hand's angle, in degrees clockwise from twelve, for the given
 * second (0-59). Pure: no I/O, no reliance on the current time.
 */
export function secondHandAngle(second: number): number {
  return normaliseDegrees(second * 6);
}

/**
 * The minute hand's angle, in degrees clockwise from twelve, for the given
 * minute (0-59) and second (0-59). Advances smoothly within the minute.
 */
export function minuteHandAngle(minute: number, second: number): number {
  return normaliseDegrees(minute * 6 + second * 0.1);
}

/**
 * The hour hand's angle, in degrees clockwise from twelve, for the given
 * hour (0-23) and minute (0-59). Advances smoothly within the hour.
 */
export function hourHandAngle(hour: number, minute: number): number {
  return normaliseDegrees((hour % 12) * 30 + minute * 0.5);
}
