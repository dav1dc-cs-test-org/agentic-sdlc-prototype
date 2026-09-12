export type Heading = 'up' | 'left' | 'down' | 'right';
export type PenState = 'up' | 'down';

export interface Point {
  x: number;
  y: number;
}

export interface Segment {
  from: Point;
  to: Point;
}

export interface TurtleState {
  position: Point;
  heading: Heading;
  pen: PenState;
  segments: Segment[];
}

export type Command = 'penUp' | 'penDown' | 'forward' | 'backward' | 'turnLeft' | 'turnRight';

const STEP = 20;
const MIN_COORD = 20;
const MAX_COORD = 380;

const HEADING_VECTORS: Record<Heading, Point> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const LEFT_TURN: Record<Heading, Heading> = {
  up: 'left',
  left: 'down',
  down: 'right',
  right: 'up',
};

const RIGHT_TURN: Record<Heading, Heading> = {
  up: 'right',
  right: 'down',
  down: 'left',
  left: 'up',
};

function inBounds(point: Point): boolean {
  return (
    point.x >= MIN_COORD && point.x <= MAX_COORD &&
    point.y >= MIN_COORD && point.y <= MAX_COORD
  );
}

function move(state: TurtleState, sign: 1 | -1): TurtleState {
  const vector = HEADING_VECTORS[state.heading];
  const candidate: Point = {
    x: state.position.x + vector.x * STEP * sign,
    y: state.position.y + vector.y * STEP * sign,
  };
  if (!inBounds(candidate)) return state;
  const segments = state.pen === 'down'
    ? [...state.segments, { from: state.position, to: candidate }]
    : state.segments;
  return { ...state, position: candidate, segments };
}

export function createInitialState(): TurtleState {
  return {
    position: { x: 200, y: 200 },
    heading: 'up',
    pen: 'down',
    segments: [],
  };
}

export function applyCommand(state: TurtleState, command: Command): TurtleState {
  switch (command) {
    case 'penUp':
      return state.pen === 'up' ? state : { ...state, pen: 'up' };
    case 'penDown':
      return state.pen === 'down' ? state : { ...state, pen: 'down' };
    case 'forward':
      return move(state, 1);
    case 'backward':
      return move(state, -1);
    case 'turnLeft':
      return { ...state, heading: LEFT_TURN[state.heading] };
    case 'turnRight':
      return { ...state, heading: RIGHT_TURN[state.heading] };
  }
}
