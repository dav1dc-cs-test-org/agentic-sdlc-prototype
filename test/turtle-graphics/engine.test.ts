import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyCommand,
  createInitialState,
  type Command,
  type Heading,
  type TurtleState,
} from '../../src/turtle-graphics/engine.ts';

test('createInitialState returns the documented starting state', () => {
  const state = createInitialState();
  assert.deepEqual(state, {
    position: { x: 200, y: 200 },
    heading: 'up',
    pen: 'down',
    segments: [],
  });
});

test('forward and backward are symmetric for all four headings', () => {
  const headings: Heading[] = ['up', 'down', 'left', 'right'];
  for (const heading of headings) {
    const start: TurtleState = { position: { x: 200, y: 200 }, heading, pen: 'down', segments: [] };
    const forward = applyCommand(start, 'forward');
    assert.notEqual(forward.position, start.position);
    const back = applyCommand(forward, 'backward');
    assert.deepEqual(back.position, start.position);
    assert.equal(back.segments.length, 2);
  }
});

test('turnLeft cycles through all four headings without moving or drawing', () => {
  const order: Heading[] = ['up', 'left', 'down', 'right'];
  let state = createInitialState();
  for (let i = 0; i < order.length; i++) {
    assert.equal(state.heading, order[i]);
    const next = applyCommand(state, 'turnLeft');
    assert.deepEqual(next.position, state.position);
    assert.equal(next.segments, state.segments);
    state = next;
  }
  assert.equal(state.heading, 'up');
});

test('turnRight cycles through all four headings without moving or drawing', () => {
  const order: Heading[] = ['up', 'right', 'down', 'left'];
  let state = createInitialState();
  for (let i = 0; i < order.length; i++) {
    assert.equal(state.heading, order[i]);
    const next = applyCommand(state, 'turnRight');
    assert.deepEqual(next.position, state.position);
    assert.equal(next.segments, state.segments);
    state = next;
  }
  assert.equal(state.heading, 'up');
});

test('pen commands are idempotent and return the same object reference on repeat', () => {
  const start = createInitialState();
  const penUp = applyCommand(start, 'penUp');
  assert.notEqual(penUp, start);
  const penUpAgain = applyCommand(penUp, 'penUp');
  assert.strictEqual(penUpAgain, penUp);

  const penDown = applyCommand(penUpAgain, 'penDown');
  assert.notEqual(penDown, penUpAgain);
  const penDownAgain = applyCommand(penDown, 'penDown');
  assert.strictEqual(penDownAgain, penDown);
});

test('applyCommand never mutates its input state', () => {
  const start = createInitialState();
  const snapshot = JSON.parse(JSON.stringify(start));
  applyCommand(start, 'forward');
  applyCommand(start, 'turnRight');
  applyCommand(start, 'penUp');
  assert.deepEqual(start, snapshot);
});

test('a mixed command sequence produces the expected state', () => {
  let state = createInitialState();
  const commands: Command[] = ['forward', 'turnRight', 'forward', 'penUp', 'forward', 'penDown', 'turnLeft', 'backward'];
  for (const command of commands) state = applyCommand(state, command);
  // forward (up): (200,180) draw
  // turnRight -> right
  // forward (right): (220,180) draw
  // penUp
  // forward (right, pen up): (240,180) no draw
  // penDown
  // turnLeft -> up
  // backward (up, pen down): (240,200) draw
  assert.deepEqual(state.position, { x: 240, y: 200 });
  assert.equal(state.heading, 'up');
  assert.equal(state.pen, 'down');
  assert.equal(state.segments.length, 3);
});

test('the four boundary edges reject movement as a same-reference no-op', () => {
  const cases: Array<{ position: { x: number; y: number }; heading: Heading; command: Command }> = [
    { position: { x: 200, y: 20 }, heading: 'up', command: 'forward' },
    { position: { x: 200, y: 380 }, heading: 'down', command: 'forward' },
    { position: { x: 20, y: 200 }, heading: 'left', command: 'forward' },
    { position: { x: 380, y: 200 }, heading: 'right', command: 'forward' },
  ];
  for (const { position, heading, command } of cases) {
    const state: TurtleState = { position, heading, pen: 'down', segments: [] };
    const next = applyCommand(state, command);
    assert.strictEqual(next, state);
  }
});

test('the four corners reject out-of-range moves as same-reference no-ops', () => {
  const corners: Array<{ position: { x: number; y: number }; heading: Heading }> = [
    { position: { x: 20, y: 20 }, heading: 'up' },
    { position: { x: 20, y: 20 }, heading: 'left' },
    { position: { x: 380, y: 20 }, heading: 'up' },
    { position: { x: 380, y: 20 }, heading: 'right' },
    { position: { x: 20, y: 380 }, heading: 'down' },
    { position: { x: 20, y: 380 }, heading: 'left' },
    { position: { x: 380, y: 380 }, heading: 'down' },
    { position: { x: 380, y: 380 }, heading: 'right' },
  ];
  for (const { position, heading } of corners) {
    const state: TurtleState = { position, heading, pen: 'down', segments: [] };
    const next = applyCommand(state, 'forward');
    assert.strictEqual(next, state);
  }
});

test('four forward-and-turn-right cycles draw a square back to the start', () => {
  let state = createInitialState();
  for (let i = 0; i < 4; i++) {
    state = applyCommand(state, 'forward');
    state = applyCommand(state, 'turnRight');
  }
  assert.deepEqual(state.position, { x: 200, y: 200 });
  assert.equal(state.heading, 'up');
  assert.equal(state.segments.length, 4);
});

test('toggling the pen up then down then moving draws exactly one segment', () => {
  let state = createInitialState();
  state = applyCommand(state, 'penUp');
  state = applyCommand(state, 'forward');
  state = applyCommand(state, 'penDown');
  state = applyCommand(state, 'forward');
  assert.equal(state.segments.length, 1);
  assert.deepEqual(state.segments[0], { from: { x: 200, y: 180 }, to: { x: 200, y: 160 } });
});

test('20 consecutive forward presses reach the top boundary with 9 drawn segments', () => {
  let state = createInitialState();
  for (let i = 0; i < 20; i++) state = applyCommand(state, 'forward');
  assert.deepEqual(state.position, { x: 200, y: 20 });
  assert.equal(state.segments.length, 9);
});

test('a 500-command deterministic replay produces deep-equal final states', () => {
  const commands: Command[] = [];
  const pool: Command[] = ['forward', 'backward', 'turnLeft', 'turnRight', 'penUp', 'penDown'];
  let seed = 42;
  for (let i = 0; i < 500; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    commands.push(pool[seed % pool.length] as Command);
  }
  let stateA = createInitialState();
  for (const command of commands) stateA = applyCommand(stateA, command);
  let stateB = createInitialState();
  for (const command of commands) stateB = applyCommand(stateB, command);
  assert.deepEqual(stateA, stateB);
});
