/**
 * Pure analog clock hand angle geometry. All angles are degrees clockwise
 * from twelve o'clock, normalised into the range [0, 360).
 */

function normaliseAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Second hand angle: seconds x 6 degrees clockwise from twelve. */
export function secondHandAngle(second: number): number {
  return normaliseAngle(second * 6);
}

/** Minute hand angle: minutes x 6 + seconds x 0.1 degrees. */
export function minuteHandAngle(minute: number, second: number): number {
  return normaliseAngle(minute * 6 + second * 0.1);
}

/** Hour hand angle: (hour mod 12) x 30 + minutes x 0.5 degrees. */
export function hourHandAngle(hour: number, minute: number): number {
  return normaliseAngle((hour % 12) * 30 + minute * 0.5);
}
