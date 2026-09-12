import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync('apps/turtle-graphics/index.html', 'utf8');
const script = readFileSync('apps/turtle-graphics/app.js', 'utf8');

const BUTTON_LABELS = [
  'Pen Up',
  'Pen Down',
  'Move Forward',
  'Move Backwards',
  'Turn Left 90 degrees',
  'Turn Right 90 degrees',
];

test('the page renders exactly one board, one turtle glyph, and an aria-live pen indicator', () => {
  const boardMatches = html.match(/<(svg|canvas)\b[^>]*\bid="board"/g) ?? [];
  assert.equal(boardMatches.length, 1, 'exactly one board element (svg or canvas) with id="board"');
  const turtleMatches = html.match(/id="turtle"/g) ?? [];
  assert.equal(turtleMatches.length, 1, 'exactly one turtle glyph element');
  const indicatorMatches = html.match(/id="pen-indicator"[^>]*aria-live="polite"/g) ?? [];
  assert.equal(indicatorMatches.length, 1, 'exactly one aria-live="polite" pen indicator');
});

test('exactly six labelled buttons are present with a data-command wiring hook', () => {
  const buttonTags = html.match(/<button\b[^>]*data-command="[a-zA-Z]+"[^>]*>[^<]*<\/button>/g) ?? [];
  assert.equal(buttonTags.length, 6, 'exactly six command buttons');
  for (const label of BUTTON_LABELS) {
    assert.ok(
      buttonTags.some(tag => tag.includes(`>${label}<`)),
      `missing button labelled "${label}"`,
    );
  }
  const commands = buttonTags.map(tag => tag.match(/data-command="([a-zA-Z]+)"/)![1]);
  assert.deepEqual(
    [...commands].sort(),
    ['backward', 'forward', 'penDown', 'penUp', 'turnLeft', 'turnRight'].sort(),
    'each button maps to a distinct engine command',
  );
});

test('buttons are sized at least 56x56 CSS px and have a visible focus-visible outline', () => {
  const buttonRule = html.match(/\bbutton\s*\{([^}]*)\}/);
  assert.ok(buttonRule, 'a button style rule must exist');
  const body = buttonRule![1] ?? '';
  const minWidth = Number(body.match(/min-width:\s*(\d+)px/)?.[1] ?? 0);
  const minHeight = Number(body.match(/min-height:\s*(\d+)px/)?.[1] ?? 0);
  assert.ok(minWidth >= 56, `button min-width must be at least 56px, got ${minWidth}`);
  assert.ok(minHeight >= 56, `button min-height must be at least 56px, got ${minHeight}`);

  const focusRule = html.match(/button:focus-visible\s*\{([^}]*)\}/);
  assert.ok(focusRule, 'a button:focus-visible rule must exist');
  const outline = (focusRule![1] ?? '').match(/outline:\s*([^;]+);/)?.[1] ?? '';
  assert.doesNotMatch(outline.trim(), /^none$/i, 'the focus-visible outline must not be "none"');
  assert.match(outline, /\d/, 'the focus-visible outline must declare a nonzero width');
});

test('the layout is fluid so it can fit narrow and wide viewports without fixed overflow-causing widths', () => {
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1"\s*\/>/);
  // The board and control regions must scale with the viewport (percentage
  // width capped by max-width) rather than using a fixed pixel width, so
  // they can shrink below 400px on narrow viewports like 320px.
  const boardWrapperRule = html.match(/#board-wrapper\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(boardWrapperRule, /width:\s*100%/, 'board wrapper must use a fluid width');
  assert.match(boardWrapperRule, /max-width:\s*400px/, 'board wrapper must cap its width');
  const boardRule = html.match(/#board\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(boardRule, /width:\s*100%/, 'board must use a fluid width');
  const controlsRule = html.match(/#controls\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(controlsRule, /width:\s*100%/, 'controls must use a fluid width');
  assert.match(
    controlsRule,
    /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(\d+px,\s*100%\),\s*1fr\)\)/,
    'controls must reflow to fewer columns instead of overflowing at narrow widths or high zoom',
  );
});

test('no eval, Function, or dynamic innerHTML assignment appears in the UI code', () => {
  assert.doesNotMatch(script, /\beval\s*\(/);
  assert.doesNotMatch(script, /\bnew\s+Function\s*\(/);
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
  assert.doesNotMatch(html, /\bon[a-z]+\s*=\s*"/i, 'no inline event-handler attributes');
});

test('no external script, font, or analytics resources are referenced', () => {
  const srcRefs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map(m => m[1] ?? '');
  for (const ref of srcRefs) {
    assert.ok(
      ref.startsWith('./') || ref.startsWith('../') || (!ref.includes('://') && !ref.startsWith('//')),
      `reference "${ref}" must be a same-origin relative asset`,
    );
  }
  assert.doesNotMatch(script, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/, 'no external network calls beyond the inert SVG namespace URI');
  assert.doesNotMatch(script, /\bfetch\s*\(|XMLHttpRequest/);
});

test('every button wires exactly one click handler and no touchstart handler', () => {
  const listenerCalls = [...script.matchAll(/addEventListener\('([a-z]+)'/g)].map(m => m[1]);
  assert.deepEqual(listenerCalls, ['click'], 'only a single click listener attachment site should exist');
  assert.doesNotMatch(script, /touchstart/, 'no separate touchstart handler that could double-fire with click');
});

test('every command triggers a full re-render of segments, turtle position, and the pen indicator', () => {
  const renderBody = script.match(/function render\(\)\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(renderBody, /renderSegments\(\)/);
  assert.match(renderBody, /renderTurtle\(\)/);
  assert.match(renderBody, /renderPenIndicator\(\)/);
  // The turtle glyph must be re-appended last so it renders above artwork.
  const appendIndex = renderBody.indexOf('appendChild(turtleGlyph)');
  const segmentsIndex = renderBody.indexOf('renderSegments()');
  assert.ok(appendIndex > segmentsIndex, 'the turtle glyph must be moved above the artwork after segments render');

  const handlerBody = script.match(/function handleCommand\(command\)\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(handlerBody, /applyCommand\(state, command\)/);
  assert.match(handlerBody, /render\(\)/);
});

test('the pen indicator text differs for each pen state so state is not conveyed by color alone', () => {
  const penLabelBlock = script.match(/const PEN_LABEL = \{([^}]*)\}/)?.[1] ?? '';
  const up = penLabelBlock.match(/up:\s*'([^']*)'/)?.[1];
  const down = penLabelBlock.match(/down:\s*'([^']*)'/)?.[1];
  assert.ok(up && down && up !== down, 'pen up/down states must have distinct textual labels');
});
