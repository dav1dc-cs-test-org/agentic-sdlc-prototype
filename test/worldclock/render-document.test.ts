import assert from 'node:assert/strict';
import test from 'node:test';
import { renderClocks } from '../../src/worldclock/render.ts';
import * as worldclock from '../../src/worldclock/index.ts';

test('renderClocks returns one well-formed SVG document containing one clock group per entry, in order', () => {
  const instant = new Date('2026-01-15T12:34:56Z');
  const svg = renderClocks(instant, ['UTC', 'America/Chicago', 'Asia/Kolkata']);

  assert.match(svg, /^<svg\b[^>]*>/);
  assert.match(svg, /<\/svg>$/);

  const groupCount = (svg.match(/<g transform="translate\(/g) ?? []).length;
  assert.equal(groupCount, 3);

  const utcIndex = svg.indexOf('>UTC<');
  const chicagoIndex = svg.indexOf('>America/Chicago<');
  const kolkataIndex = svg.indexOf('>Asia/Kolkata<');
  assert.ok(utcIndex >= 0 && chicagoIndex >= 0 && kolkataIndex >= 0);
  assert.ok(utcIndex < chicagoIndex);
  assert.ok(chicagoIndex < kolkataIndex);
});

test('renderClocks is deterministic: the same instant and timezone list produce byte-identical output', () => {
  const fixed = new Date('2026-06-01T00:00:00Z');
  const zones = ['UTC', 'Europe/London'];
  const a = renderClocks(fixed, zones);
  const b = renderClocks(new Date(fixed.getTime()), [...zones]);
  assert.equal(a, b);
});

test('renderClocks with an empty timezone list returns a valid empty SVG document', () => {
  const instant = new Date('2026-01-15T12:34:56Z');
  const svg = renderClocks(instant, []);

  assert.match(svg, /^<svg\b[^>]*>/);
  assert.match(svg, /<\/svg>$/);
  assert.equal((svg.match(/<g transform="translate\(/g) ?? []).length, 0);
});

test('a duplicated timezone in the list renders one independent, identical clock group per occurrence', () => {
  const instant = new Date('2026-01-15T12:34:56Z');
  const svg = renderClocks(instant, ['UTC', 'UTC']);

  const groupMatches = svg.match(/<g transform="translate\([^)]*\)">.*?<\/g>/gs) ?? [];
  assert.equal(groupMatches.length, 2);

  const stripTranslate = (group: string) => group.replace(/translate\([^)]*\)/, 'translate(X)');
  assert.equal(stripTranslate(groupMatches[0]!), stripTranslate(groupMatches[1]!));
});

test('src/worldclock/index.ts re-exports the public surface from a single import path', () => {
  assert.equal(typeof worldclock.resolveLocalTime, 'function');
  assert.equal(typeof worldclock.secondHandAngle, 'function');
  assert.equal(typeof worldclock.minuteHandAngle, 'function');
  assert.equal(typeof worldclock.hourHandAngle, 'function');
  assert.equal(typeof worldclock.renderClock, 'function');
  assert.equal(typeof worldclock.renderClocks, 'function');
});
