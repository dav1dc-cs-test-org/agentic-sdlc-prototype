import assert from 'node:assert/strict';
import test from 'node:test';
import { hourHandAngle, minuteHandAngle, secondHandAngle } from '../../src/worldclock/geometry.ts';

test('secondHandAngle equals seconds * 6 degrees', () => {
  assert.equal(secondHandAngle(0), 0);
  assert.equal(secondHandAngle(1), 6);
  assert.equal(secondHandAngle(30), 180);
  assert.equal(secondHandAngle(59), 354);
});

test('secondHandAngle normalises boundary and overflowing values to [0, 360)', () => {
  assert.equal(secondHandAngle(60), 0);
  assert.equal(secondHandAngle(61), 6);
});

test('minuteHandAngle equals minutes * 6 + seconds * 0.1 degrees', () => {
  assert.equal(minuteHandAngle(0, 0), 0);
  assert.equal(minuteHandAngle(1, 0), 6);
  assert.equal(minuteHandAngle(30, 0), 180);
  assert.equal(minuteHandAngle(0, 30), 3);
  assert.equal(minuteHandAngle(59, 59), 359.9);
});

test('minuteHandAngle normalises boundary and overflowing values to [0, 360)', () => {
  assert.equal(minuteHandAngle(60, 0), 0);
  assert.equal(minuteHandAngle(59, 60), 0);
});

test('hourHandAngle equals (hour mod 12) * 30 + minutes * 0.5 degrees', () => {
  assert.equal(hourHandAngle(6, 30), 195);
  assert.equal(hourHandAngle(3, 0), 90);
  assert.equal(hourHandAngle(1, 0), 30);
});

test('hourHandAngle places local midnight and local noon at 0 degrees', () => {
  assert.equal(hourHandAngle(0, 0), 0);
  assert.equal(hourHandAngle(12, 0), 0);
});

test('hourHandAngle normalises boundary and overflowing values to [0, 360)', () => {
  assert.equal(hourHandAngle(24, 0), 0);
  assert.equal(hourHandAngle(11, 59), 359.5);
  assert.equal(hourHandAngle(11, 60), 0);
});

test('all angle functions are pure and deterministic for the same inputs', () => {
  assert.equal(secondHandAngle(45), secondHandAngle(45));
  assert.equal(minuteHandAngle(20, 15), minuteHandAngle(20, 15));
  assert.equal(hourHandAngle(9, 45), hourHandAngle(9, 45));
});
