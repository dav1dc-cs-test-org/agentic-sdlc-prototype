# [Feature] Turtle Art: a six-button drawing playground for ages 5-7

## Objective

Build a small turtle graphics web app for children aged 5-7. Children move a
visible turtle around a drawing board, turn it, and lift or lower its pen to
make simple artwork. Immediate visual feedback should make direction, distance,
right-angle turns, and drawing versus movement tangible without requiring
typing, reading code, signing in, or adult setup inside the app.

The first screen is the usable playground, not a landing page. This is creative
play, not a scored game, course, or programming-language implementation.

### Scope Baseline

The requester confirmed the age group and exactly six buttons:

1. Pen Up
2. Pen Down
3. Move Forward
4. Move Backwards
5. Turn Left 90 degrees
6. Turn Right 90 degrees

All six commands are in scope. The board, turtle artwork, pen-state feedback,
responsive controls, tests, and local launch documentation complete the feature.
There is no command editor, command history, or additional application control.

### Assumptions for Review

- Movement is one fixed-size step per activation; there is no distance input.
- The pen starts down so the first forward move draws immediately.
- One fixed ink color is enough for this pilot. The turtle remains visually
  distinct from the ink.
- Refreshing the browser starts a new drawing. A dedicated reset button,
  undo, color picker, and export can be separate follow-up features.
- The application is served locally or by an existing static host. This issue
  does not provision public hosting or change GitHub settings.

## Acceptance Criteria

### User Scenarios & Testing

**P1: Draw a first shape.** Given a fresh board, when a child alternates Move
Forward and Turn Right 90 degrees four times, then a square appears, the turtle
returns to its starting position facing up, and no extra segments appear.

**P1: Move without leaving a mark.** Given a fresh board, when a child presses
Pen Up, Move Forward, Pen Down, Move Forward, then only the second movement
draws a line. The visible pen indicator follows both pen commands.

**P2: Explore and recover at an edge.** Given the turtle has reached the top
movement boundary, another forward move leaves it in place. A backward move
brings it back into the board. No dialog interrupts play, and the controls
remain usable.

### Requirements

**REQ-001: Immediate playground.** On load, show one square drawing board,
one recognizable turtle, exactly the six buttons named above, and a short
pen-state indicator. No login, modal, instruction screen, or start button is
required before drawing. No keyboard input beyond optional button activation
is required.

**REQ-002: Initial state and coordinates.** Use a 400-by-400 logical drawing
space with the origin at its top-left, positive x to the right, and positive y
downward. Start the turtle at (200, 200), facing up, with its pen down and no
drawn segments. The coordinate system is an acceptance-test reference, not
required on-screen text for children.

**REQ-003: Forward movement.** Move Forward moves exactly 20 logical units
in the direction the turtle faces, subject to the boundary rule below. It
does not change the turtle's heading or pen state.

**REQ-004: Backward movement.** Move Backwards moves exactly 20 logical units
opposite the direction the turtle faces, subject to the same boundary rule.
It does not turn the turtle around or change the pen state.

**REQ-005: Left turn.** Turn Left 90 degrees rotates the turtle one quarter
turn counterclockwise without changing its position or drawing anything.
The heading cycle is up, left, down, right, up.

**REQ-006: Right turn.** Turn Right 90 degrees rotates the turtle one quarter
turn clockwise without changing its position or drawing anything.
The heading cycle is up, right, down, left, up.

**REQ-007: Pen up.** Pen Up changes subsequent movements to travel without
drawing. It does not move the turtle, erase artwork, or draw a mark. Repeating
Pen Up has no additional effect.

**REQ-008: Pen down.** Pen Down changes subsequent successful movements to
draw. It does not move the turtle or draw a mark by itself. Repeating Pen Down
has no additional effect. Both pen buttons remain available, with the active
mode distinguished visually and programmatically, not by color alone.

**REQ-009: Artwork semantics.** A successful pen-down movement adds exactly
one straight segment between the old and new positions. Use a fixed dark ink
stroke with rounded ends, 4 logical units wide. Existing segments persist;
turns, pen changes, and pen-up movements never modify them. The turtle cursor
is separate from the artwork and does not leave cursor-shaped trails.

**REQ-010: Safe boundaries.** Turtle-center coordinates must stay between
20 and 380 inclusive on both axes. A movement that would leave this range is
a no-op: no movement, line, wraparound, automatic turn, or pen-state change.
The whole turtle remains visible at the boundary, and another valid command
can move it away. For example, 20 consecutive forward presses from the initial
state end at (200, 20) with exactly nine drawn segments.

**REQ-011: One activation, one command.** Each completed click, tap, Enter,
or Space activation of a focused button applies exactly one command. Commands
are processed in activation order. Pointer holding must not start continuous
movement, and a tap must not be processed twice through separate touch and
click handlers. There is no queued animation or automatic drawing loop.

**REQ-012: Visible cause and effect.** The turtle has a discernible head and
orientation and is always drawn above the artwork. Movement and turns update
it immediately; pen changes update the visible Pen Up or Pen Down state in
the same interaction. Use original, self-contained turtle artwork and familiar
direction/pen symbols paired with readable button labels. Do not add tutorial
paragraphs, scoring, or celebratory interruptions.

**REQ-013: Child-friendly access.** Every button has an accessible name matching
its action, a visible keyboard-focus indicator, and a touch target of at least
56 by 56 CSS pixels. Labels may wrap but must not be clipped. All six commands
work with pointer, touch, and keyboard. The drawing surface has an accessible
name, and changes of heading and pen state have a concise nonvisual equivalent.

**REQ-014: Responsive layout without data loss.** At viewport widths of 320,
390, 768, and 1280 CSS pixels, the complete square board and all controls fit
without horizontal page scrolling, overlap, or clipped labels. Vertical page
scrolling is acceptable. The board scales visually without changing the
logical step size, turtle state, or saved segments. Resizing or changing device
orientation preserves the drawing. Controls remain operable at 200% text zoom.

**REQ-015: Predictable reset and privacy.** Refreshing the page restores the
initial state and empty board. Drawings and interactions remain in page memory
only: no cookies, browser persistence, accounts, analytics, uploads, or external
requests beyond loading the application's own static assets.

**REQ-016: Deterministic, responsive behavior.** Replaying the same finite command
sequence from the same initial state produces the same heading, pen state,
position, and ordered drawing segments. A sequence of 500 alternating forward
and backward activations remains responsive and produces exactly 500 segments
when the pen stays down; no movement is lost or duplicated. No controls depend
on an inference service or a network connection after the app's assets load.

### Key Entities

- **Turtle:** logical position, one of four headings, and pen-up/pen-down state.
- **Artwork:** the ordered line segments produced by successful pen-down moves.
- **Command:** one of the six button actions, with no child-supplied code or
  arbitrary executable content.

### Success Criteria

- A child can make the first visible line with one button activation from the
  initial screen; no setup or reading of instructions is necessary.
- The square scenario produces exactly four sides and returns to (200, 200)
  facing up. Four left turns also restore the initial heading without drawing.
- The pen-up scenario ends at (200, 160) with one segment from (200, 180) to
  (200, 160), leaving the first 20-unit movement blank.
- At all four specified viewport widths, every control remains available and
  the turtle and board remain inspectable. Desktop and touch-browser checks
  show the artwork and cursor, not only an empty drawing element.
- The page loads and the scenarios complete without uncaught browser errors
  or third-party network requests. Refreshing produces an empty board.

## Constraints and Non-goals

- Fit the implementation into at most six dependency-ordered tasks and the
  repository's existing file, job, repair, and inference budgets.
- Do not change the controller, cost accounting, migration code, workflows,
  credentials, permissions, state branch, or enforcement policy for this feature.
- Do not modify dependency manifests or lockfiles, the TypeScript configuration,
  existing baseline tests, or other protected paths. Do not add, download, or
  vendor a framework, command-language parser, rendering engine, or test library
  to work around those restrictions. Native browser graphics are sufficient
  for this six-command scope.
- No backend, public deployment, external assets, third-party font requests,
  advertising, user-generated sharing, multiplayer, or collection of children's
  personal information. Keep the experience self-contained and English-only.
- No text programming, Logo compatibility, loops, variables, procedures, blocks,
  command recording, replay UI, drawing challenges, badges, or lesson system.
- No extra application buttons, menus, adjustable distances or angles, pen-width
  control, color selection, undo/redo, reset control, save/import, or export.
- No camera, microphone, location, clipboard, or other permission prompts.
- Do not weaken coverage or security gates. Both line and branch coverage must
  meet policy and must not drop from the baseline measured for this new issue.
  Do not copy an old numerical coverage baseline into the new implementation.

## Context

This is a new feature and a fresh end-to-end exercise of the agentic SDLC
pipeline, not a continuation of issue #1 or its existing PR. The template is
[the Agentic Feature form](../.github/ISSUE_TEMPLATE/agentic-feature.yml).
Repository constraints are defined by [the policy](../.github/sdlc/policy.json),
[the build configuration](../tsconfig.json), and
[the validation runner](../src/validate.ts).

### Implementation and Verification Boundaries

- Place new TypeScript behavior under `src/turtle-graphics/`, browser assets
  under `apps/turtle-graphics/`, and new discovered Node tests under `test/`
  with filenames matching `test/**/*.test.ts`. Update the README and relevant
  feature documentation to describe the actual local launch procedure.
- Reuse the existing `npm run build` and Node 24.8+ toolchain. The research plan
  must specify the browser entry point, build output references, and a runnable
  local static-serving command without changing protected configuration.
- Browser modules must not import controller or Node-only modules. Keep turtle
  transitions and drawing data independently testable, using the same logic in
  the application and Node tests. Do not duplicate an engine for the browser,
  omit behavioral code from coverage, or assert only that files exist.
- Run `npm ci --ignore-scripts` and `npm run verify`. Add regression tests for
  all headings, forward/backward symmetry, turns, pen idempotence, mixed command
  sequences, all four boundaries and corners, and drawing/state preservation.
- The current required pipeline validates Node tests, not browser interactions.
  Its research plan must acknowledge that limit and describe desktop and touch
  browser verification of rendering, buttons, resize behavior, accessibility,
  and console/network errors. Use browser automation if available without
  changing protected dependencies; otherwise document explicit human checks
  at PR review. Never report a browser check as passed from Node tests alone.

### Pipeline Pilot Checks

These are checks on the existing pipeline, not features of the children's app:

1. Create a new issue with this final scope. Have an authorized repository
   writer apply `agentic-SDLC` after the text is complete. The human label event
   starts intake; the research plan still requires explicit versioned approval.
2. Confirm a new lifecycle, plan, branch, job sequence, and cost ledger are used;
   do not reuse or edit the old issue's state. The new cost history is complete
   from intake, rather than carrying a legacy-history warning.
3. Let research, decomposition, implementation, scanning, security, testing,
   validation, documentation, and final review follow the normal approved flow.
   Do not force retries or extra inference just to create spending data.
4. When the final PR is ready, inspect its runner minutes, AI credits, number
   of recorded runs, and near-limit/pre-emption counts. Actual work should have
   recorded nonzero duration and inference usage. Compare these with the issue
   status; do not invent costs or present them as dollar charges.
5. A later reconciliation with no new worker run must not charge the same work
   again. The PR must still reference the approved plan and current-commit gate
   evidence. Review the browser-verification evidence or perform the documented
   browser checks before deciding whether to merge.
