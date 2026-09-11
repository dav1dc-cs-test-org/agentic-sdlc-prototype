/**
 * Pure clock-hand angle geometry. All angles are in degrees, measured
 * clockwise from twelve o'clock, and normalised into the range [0, 360).
 */

function normalise(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/** Angle of the second hand: seconds * 6 degrees clockwise from twelve. */
export function secondHandAngle(second: number): number {
  return normalise(second * 6);
}

/**
 * Angle of the minute hand: minutes * 6 + seconds * 0.1 degrees, so it
 * advances smoothly within the minute.
 */
export function minuteHandAngle(minute: number, second: number): number {
  return normalise(minute * 6 + second * 0.1);
}

/**
 * Angle of the hour hand: (hour mod 12) * 30 + minutes * 0.5 degrees, so
 * local midnight and local noon both place the hour hand at 0 degrees.
 */
export function hourHandAngle(hour: number, minute: number): number {
  return normalise((hour % 12) * 30 + minute * 0.5);
}
