import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeXml, renderClock } from '../src/worldclock/render.ts';

test('escapeXml escapes ampersand, angle brackets, and quotes', () => {
  assert.equal(escapeXml('&<>"\''), '&amp;&lt;&gt;&quot;&apos;');
  assert.equal(escapeXml('Etc/GMT'), 'Etc/GMT');
});

test('renderClock returns an SVG group with a face, twelve ticks, three hands, and a label', () => {
  const svg = renderClock(new Date('2026-01-01T12:00:00Z'), 'UTC', 0);

  assert.match(svg, /^<g transform="translate\(0\.000, 0\)">/);
  assert.match(svg, /<\/g>$/);
  assert.equal((svg.match(/<circle/g) ?? []).length, 1);
  assert.equal((svg.match(/<line/g) ?? []).length, 12 + 3);
  assert.equal((svg.match(/<text/g) ?? []).length, 1);
  assert.match(svg, />UTC<\/text>/);
});

test('escapeXml prevents an SVG-breaking timezone-like string from escaping the text element', () => {
  const label = 'Weird&Zone<script>alert(1)</script>';
  const escaped = escapeXml(label);

  assert.doesNotMatch(escaped, /[<>]/);
  assert.match(escaped, /&amp;/);
  const embedded = `<text>${escaped}</text>`;
  assert.equal((embedded.match(/<text>|<\/text>/g) ?? []).length, 2);
});

test('renderClock is pure and deterministic for the same instant, timezone, and x', () => {
  const instant = new Date('2026-06-15T09:30:45Z');
  const first = renderClock(instant, 'America/New_York', 50);
  const second = renderClock(instant, 'America/New_York', 50);
  assert.equal(first, second);
});

test('renderClock translates the group by the supplied x offset', () => {
  const svg = renderClock(new Date('2026-01-01T00:00:00Z'), 'UTC', 210);
  assert.match(svg, /^<g transform="translate\(210\.000, 0\)">/);
});

test('renderClock throws for an unrecognised timezone identifier', () => {
  assert.throws(
    () => renderClock(new Date('2026-01-01T00:00:00Z'), 'Not/AZone', 0),
    /Not\/AZone/,
  );
});
