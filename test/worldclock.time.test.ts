import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveLocalTime } from '../src/worldclock/time.ts';

test('resolves local hour/minute/second for a UTC instant in an IANA timezone', () => {
  const instant = new Date('2024-03-10T07:00:00Z');
  assert.deepEqual(resolveLocalTime(instant, 'Europe/London'), { hour: 7, minute: 0, second: 0 });
});

test('resolves fractional-offset zones correctly', () => {
  const instant = new Date('2024-03-10T07:00:00Z');
  assert.deepEqual(resolveLocalTime(instant, 'Asia/Kolkata'), { hour: 12, minute: 30, second: 0 });
  assert.deepEqual(resolveLocalTime(instant, 'Asia/Kathmandu'), { hour: 12, minute: 45, second: 0 });
  assert.deepEqual(resolveLocalTime(instant, 'Australia/Eucla'), { hour: 15, minute: 45, second: 0 });
});

test('resolves DST transitions correctly for the same instant across zones', () => {
  const instant = new Date('2024-03-10T07:00:00Z');
  assert.deepEqual(resolveLocalTime(instant, 'America/New_York'), { hour: 3, minute: 0, second: 0 });
  assert.deepEqual(resolveLocalTime(instant, 'Europe/London'), { hour: 7, minute: 0, second: 0 });
});

test('an unrecognised timezone identifier throws an error naming it', () => {
  const instant = new Date('2024-03-10T07:00:00Z');
  assert.throws(() => resolveLocalTime(instant, 'Not/AZone'), /Not\/AZone/);
});

test('resolveLocalTime is pure and reflects the explicit instant argument, not the current time', () => {
  const earlier = new Date('2020-01-01T00:00:00Z');
  const later = new Date('2020-01-01T12:00:00Z');
  assert.notDeepEqual(resolveLocalTime(earlier, 'UTC'), resolveLocalTime(later, 'UTC'));
  assert.deepEqual(resolveLocalTime(earlier, 'UTC'), { hour: 0, minute: 0, second: 0 });
});
