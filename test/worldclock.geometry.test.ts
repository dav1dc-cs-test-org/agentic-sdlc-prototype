import assert from 'node:assert/strict';
import test from 'node:test';
import { secondHandAngle, minuteHandAngle, hourHandAngle } from '../src/worldclock/geometry.ts';

test('secondHandAngle equals seconds x 6 degrees clockwise from twelve', () => {
  assert.equal(secondHandAngle(0), 0);
  assert.equal(secondHandAngle(15), 90);
  assert.equal(secondHandAngle(30), 180);
  assert.equal(secondHandAngle(45), 270);
});

test('minuteHandAngle equals minutes x 6 + seconds x 0.1 degrees', () => {
  assert.equal(minuteHandAngle(0, 0), 0);
  assert.equal(minuteHandAngle(15, 0), 90);
  assert.equal(minuteHandAngle(30, 30), 183);
  assert.equal(minuteHandAngle(0, 30), 3);
});

test('hourHandAngle equals (hour mod 12) x 30 + minutes x 0.5 degrees', () => {
  assert.equal(hourHandAngle(3, 0), 90);
  assert.equal(hourHandAngle(6, 30), 195);
  assert.equal(hourHandAngle(15, 0), 90);
});

test('local midnight and local noon both place the hour hand at 0 degrees', () => {
  assert.equal(hourHandAngle(0, 0), 0);
  assert.equal(hourHandAngle(12, 0), 0);
});

test('all returned angles are normalised to the range [0, 360)', () => {
  assert.equal(secondHandAngle(60), 0);
  assert.equal(secondHandAngle(-10), 300);
  assert.equal(minuteHandAngle(60, 0), 0);
  assert.equal(minuteHandAngle(-1, 0), 354);
  assert.equal(hourHandAngle(12, 0), 0);
  assert.equal(hourHandAngle(-1, 0), 330);
  assert.ok(secondHandAngle(1000) >= 0 && secondHandAngle(1000) < 360);
  assert.ok(hourHandAngle(-25, -5) >= 0 && hourHandAngle(-25, -5) < 360);
});
