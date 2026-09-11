import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveLocalTime } from '../../src/worldclock/time.ts';

test('resolves local hour, minute, and second for a UTC instant in a standard timezone', () => {
  const instant = new Date('2026-01-15T12:34:56Z');
  const result = resolveLocalTime(instant, 'UTC');
  assert.deepEqual(result, { hour: 12, minute: 34, second: 56 });
});

test('resolves fractional-offset timezones correctly', () => {
  const instant = new Date('2026-01-15T00:00:00Z');

  // Asia/Kolkata is UTC+05:30
  assert.deepEqual(resolveLocalTime(instant, 'Asia/Kolkata'), { hour: 5, minute: 30, second: 0 });

  // Asia/Kathmandu is UTC+05:45
  assert.deepEqual(resolveLocalTime(instant, 'Asia/Kathmandu'), { hour: 5, minute: 45, second: 0 });

  // Australia/Eucla is UTC+08:45
  assert.deepEqual(resolveLocalTime(instant, 'Australia/Eucla'), { hour: 8, minute: 45, second: 0 });
});

test('resolves correctly across a daylight saving transition', () => {
  // 2026-03-08 is the US DST start (spring forward); before it, New York is UTC-5.
  const beforeTransition = new Date('2026-03-07T12:00:00Z');
  assert.deepEqual(resolveLocalTime(beforeTransition, 'America/New_York'), { hour: 7, minute: 0, second: 0 });
  assert.deepEqual(resolveLocalTime(beforeTransition, 'Europe/London'), { hour: 12, minute: 0, second: 0 });

  // After the US transition, New York is UTC-4 while London (which changes later) is still UTC+0.
  const afterTransition = new Date('2026-03-09T12:00:00Z');
  assert.deepEqual(resolveLocalTime(afterTransition, 'America/New_York'), { hour: 8, minute: 0, second: 0 });
  assert.deepEqual(resolveLocalTime(afterTransition, 'Europe/London'), { hour: 12, minute: 0, second: 0 });
});

test('throws an error naming the offending unrecognised timezone identifier', () => {
  const instant = new Date('2026-01-15T00:00:00Z');
  assert.throws(
    () => resolveLocalTime(instant, 'Not/A_Real_Zone'),
    /Not\/A_Real_Zone/,
  );
});

test('is pure and deterministic for the same inputs', () => {
  const instant = new Date('2026-06-01T18:20:05Z');
  const first = resolveLocalTime(instant, 'Asia/Tokyo');
  const second = resolveLocalTime(instant, 'Asia/Tokyo');
  assert.deepEqual(first, second);
});
