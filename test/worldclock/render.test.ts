import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeXml, renderClock } from '../../src/worldclock/render.ts';

test('escapeXml escapes ampersand, angle brackets, and quote characters', () => {
  assert.equal(escapeXml('&'), '&amp;');
  assert.equal(escapeXml('<'), '&lt;');
  assert.equal(escapeXml('>'), '&gt;');
  assert.equal(escapeXml('"'), '&quot;');
  assert.equal(escapeXml("'"), '&apos;');
  assert.equal(escapeXml('a & b < c > d "e" \'f\''), 'a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;');
});

test('renderClock returns a group with exactly one face, twelve ticks, three hands, and a label', () => {
  const instant = new Date('2026-01-15T12:34:56Z');
  const svg = renderClock(instant, 'UTC', 0);

  assert.match(svg, /^<g transform="translate\(0,0\)">/);
  assert.match(svg, /<\/g>$/);

  const circleCount = (svg.match(/<circle\b/g) ?? []).length;
  assert.equal(circleCount, 1);

  const lineCount = (svg.match(/<line\b/g) ?? []).length;
  assert.equal(lineCount, 15); // 12 hour ticks + 3 hands

  const textMatch = svg.match(/<text\b[^>]*>([^<]*)<\/text>/);
  assert.ok(textMatch, 'expected a text label element');
  assert.equal(textMatch![1], 'UTC');
});

test('a timezone label containing &, <, and > is escaped in the rendered text element', () => {
  // No real IANA identifier contains these characters, so this test stubs
  // Intl.DateTimeFormat to accept an arbitrary label while still exercising
  // renderClock's real escaping of the (attacker-controlled) timeZone string.
  const instant = new Date('2026-01-15T12:34:56Z');
  const unsafeLabel = 'Region/<Zone>&"Name"';
  const RealDateTimeFormat = Intl.DateTimeFormat;

  class StubDateTimeFormat {
    formatToParts() {
      return [
        { type: 'hour', value: '12' },
        { type: 'minute', value: '34' },
        { type: 'second', value: '56' },
      ] as Intl.DateTimeFormatPart[];
    }
  }
  // @ts-expect-error -- intentionally substituting a minimal stub for the test
  Intl.DateTimeFormat = StubDateTimeFormat;

  let svg: string;
  try {
    svg = renderClock(instant, unsafeLabel, 0);
  } finally {
    Intl.DateTimeFormat = RealDateTimeFormat;
  }

  const textMatch = svg.match(/<text\b[^>]*>([^<]*)<\/text>/);
  assert.ok(textMatch, 'expected a text label element');
  assert.equal(textMatch![1], escapeXml(unsafeLabel));
  assert.ok(!textMatch![1].includes('<'));
  assert.ok(!textMatch![1].includes('>'));
});

test('renderClock is pure: the same instant and timezone always produce the same output', () => {
  const fixed = new Date('2026-06-01T00:00:00Z');
  const a = renderClock(fixed, 'America/Chicago', 100);
  const b = renderClock(new Date(fixed.getTime()), 'America/Chicago', 100);
  assert.equal(a, b);
});
