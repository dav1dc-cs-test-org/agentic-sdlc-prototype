import assert from 'node:assert/strict';
import test from 'node:test';
import { hourHandAngle, minuteHandAngle, secondHandAngle } from '../../src/worldclock/geometry.ts';

test('secondHandAngle equals seconds * 6 degrees for representative and boundary values', () => {
  const cases: Array<[number, number]> = [
    [0, 0],
    [1, 6],
    [15, 90],
    [30, 180],
    [45, 270],
    [59, 354],
  ];
  for (const [second, expected] of cases) {
    assert.equal(secondHandAngle(second), expected);
  }
});

test('minuteHandAngle equals minutes * 6 + seconds * 0.1 degrees for representative and boundary values', () => {
  const cases: Array<[number, number, number]> = [
    [0, 0, 0],
    [1, 0, 6],
    [15, 0, 90],
    [30, 0, 180],
    [59, 0, 354],
    [0, 30, 3],
    [30, 30, 183],
  ];
  for (const [minute, second, expected] of cases) {
    assert.equal(minuteHandAngle(minute, second), expected);
  }
});

test('hourHandAngle equals (hour mod 12) * 30 + minute * 0.5 degrees, midway at 6:30', () => {
  const cases: Array<[number, number, number]> = [
    [3, 0, 90],
    [9, 0, 270],
    [6, 30, 195],
  ];
  for (const [hour, minute, expected] of cases) {
    assert.equal(hourHandAngle(hour, minute), expected);
  }
});

test('hourHandAngle is 0 at local midnight and local noon', () => {
  assert.equal(hourHandAngle(0, 0), 0);
  assert.equal(hourHandAngle(12, 0), 0);
});

test('all three functions normalise angles into [0, 360) for inputs that would otherwise be out of range', () => {
  const secondAngle = secondHandAngle(-1);
  assert.ok(secondAngle >= 0 && secondAngle < 360);
  assert.equal(secondAngle, 354);

  const minuteAngle = minuteHandAngle(60, 0);
  assert.ok(minuteAngle >= 0 && minuteAngle < 360);
  assert.equal(minuteAngle, 0);

  const hourAngle = hourHandAngle(24, 0);
  assert.ok(hourAngle >= 0 && hourAngle < 360);
  assert.equal(hourAngle, 0);

  const negativeHourAngle = hourHandAngle(-1, 0);
  assert.ok(negativeHourAngle >= 0 && negativeHourAngle < 360);
  assert.equal(negativeHourAngle, 330);
});
