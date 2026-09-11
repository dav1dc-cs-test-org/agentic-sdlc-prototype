import assert from 'node:assert/strict';
import test from 'node:test';
import { renderClocks } from '../src/worldclock/document.ts';

test('renderClocks returns one complete SVG document with one clock group per entry, in order', () => {
  const svg = renderClocks(new Date('2026-01-01T12:00:00Z'), ['UTC', 'America/New_York', 'Asia/Kolkata']);

  assert.match(svg, /^<svg[^>]*>/);
  assert.match(svg, /<\/svg>$/);
  assert.equal((svg.match(/<g transform="translate\(/g) ?? []).length, 3);

  const utcIndex = svg.indexOf('>UTC<');
  const nyIndex = svg.indexOf('>America/New_York<');
  const kolkataIndex = svg.indexOf('>Asia/Kolkata<');
  assert.ok(utcIndex < nyIndex);
  assert.ok(nyIndex < kolkataIndex);

  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="600\.000"/);
});

test('renderClocks returns a valid, well-formed empty SVG document for an empty list', () => {
  const svg = renderClocks(new Date('2026-01-01T12:00:00Z'), []);

  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="0\.000"/);
  assert.match(svg, /<\/svg>$/);
  assert.equal((svg.match(/<g transform="translate\(/g) ?? []).length, 0);
});

test('renderClocks renders a duplicated timezone independently for each occurrence', () => {
  const svg = renderClocks(new Date('2026-01-01T12:00:00Z'), ['UTC', 'UTC']);

  assert.equal((svg.match(/<g transform="translate\(/g) ?? []).length, 2);
  assert.equal((svg.match(/>UTC<\/text>/g) ?? []).length, 2);
});

test('renderClocks produces byte-identical output for the same instant and timezone list', () => {
  const instant = new Date('2026-06-15T09:30:45Z');
  const timeZones = ['UTC', 'Europe/London', 'Asia/Kathmandu'];

  const first = renderClocks(instant, timeZones);
  const second = renderClocks(instant, timeZones);

  assert.equal(first, second);
});

test('renderClocks throws for an unrecognised timezone identifier within the list', () => {
  assert.throws(
    () => renderClocks(new Date('2026-01-01T00:00:00Z'), ['UTC', 'Not/AZone']),
    /Not\/AZone/,
  );
});

test('renderClocks respects custom clockWidth and clockHeight options', () => {
  const svg = renderClocks(new Date('2026-01-01T12:00:00Z'), ['UTC', 'UTC'], { clockWidth: 100, clockHeight: 120 });

  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="200\.000" height="120\.000"/);
  assert.match(svg, /<g transform="translate\(100\.000, 0\)">/);
});
