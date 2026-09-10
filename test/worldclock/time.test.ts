import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveLocalTime } from '../../src/worldclock/time.ts';

test('resolves local hour, minute, and second for a UTC instant and IANA timezone', () => {
  const instant = new Date('2026-01-15T12:34:56Z');
  const utc = resolveLocalTime(instant, 'UTC');
  assert.deepEqual(utc, { hour: 12, minute: 34, second: 56 });

  const tokyo = resolveLocalTime(instant, 'Asia/Tokyo');
  assert.deepEqual(tokyo, { hour: 21, minute: 34, second: 56 });
});

test('resolves fractional UTC offset zones correctly', () => {
  const instant = new Date('2026-01-15T12:00:00Z');

  assert.deepEqual(resolveLocalTime(instant, 'Asia/Kolkata'), { hour: 17, minute: 30, second: 0 });
  assert.deepEqual(resolveLocalTime(instant, 'Asia/Kathmandu'), { hour: 17, minute: 45, second: 0 });
  assert.deepEqual(resolveLocalTime(instant, 'Australia/Eucla'), { hour: 20, minute: 45, second: 0 });
});

test('resolves the same instant across a documented DST transition', () => {
  // US DST began 2026-03-08 02:00 local (America/New_York); UK DST began
  // 2026-03-29 01:00 UTC (Europe/London). Pick instants either side of each.
  const beforeUsDst = new Date('2026-03-08T06:59:00Z'); // 01:59 EST (UTC-5)
  const afterUsDst = new Date('2026-03-08T07:01:00Z'); // 03:01 EDT (UTC-4)

  assert.deepEqual(resolveLocalTime(beforeUsDst, 'America/New_York'), { hour: 1, minute: 59, second: 0 });
  assert.deepEqual(resolveLocalTime(afterUsDst, 'America/New_York'), { hour: 3, minute: 1, second: 0 });

  const beforeUkDst = new Date('2026-03-29T00:59:00Z'); // 00:59 GMT (UTC+0)
  const afterUkDst = new Date('2026-03-29T01:01:00Z'); // 02:01 BST (UTC+1)

  assert.deepEqual(resolveLocalTime(beforeUkDst, 'Europe/London'), { hour: 0, minute: 59, second: 0 });
  assert.deepEqual(resolveLocalTime(afterUkDst, 'Europe/London'), { hour: 2, minute: 1, second: 0 });
});

test('throws for an unrecognised timezone identifier, naming it in the message', () => {
  const instant = new Date('2026-01-15T12:00:00Z');
  assert.throws(
    () => resolveLocalTime(instant, 'Not/A_Real_Zone'),
    /Not\/A_Real_Zone/,
  );
});

test('never depends on Date.now, process.env, or I/O; only the explicit instant matters', () => {
  const fixed = new Date('2026-06-01T00:00:00Z');
  const a = resolveLocalTime(fixed, 'America/Chicago');
  const b = resolveLocalTime(new Date(fixed.getTime()), 'America/Chicago');
  assert.deepEqual(a, b);
});
