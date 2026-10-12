## Phase 0 — Establish a Regression Baseline

### TODOs
- [x] Confirm the working tree and record the baseline revision before beginning the planned refactor.
- [x] Run `node test-rules.js` and record its pass/fail output.
- [x] Run `node tools/check-collision.js` and record its pass/fail output.
- [x] Start the service on the protocol test's default port with `PORT=3100 node server.js`; in a separate terminal, run `node test-protocol.js`.
- [x] Run `node tools/check-powerup.js`, `node tools/check-solo.js`, and `node tools/check-coop.js` against the local service and record the baseline.
- [x] For browser-facing changes, confirm an installed supported browser and run the relevant local probe before changing the page.

### Acceptance
- Baseline results are recorded and any pre-existing failures are distinguished from regressions.
- The local server can be stopped cleanly after tests; no test process is left running.

## Phase 1 — Stabilize the Shared Probe Utilities

The browser lifecycle code has already been extracted to `tools/cdp-browser.js`; this phase completes its safety net before larger refactors.

### TODOs
- [x] Review `tools/cdp-browser.js` and `tools/cdp.js` exports and document their internal responsibility boundary in code comments only where needed.
- [x] Add a lightweight automated compatibility check for the old `tools/cdp.js` public exports and the new browser lifecycle exports.
- [x] Exercise browser discovery with `PROBE_BROWSER` set and unset; confirm the candidate order and missing-browser error remain predictable.
- [x] Run `node --check tools/cdp.js` and `node --check tools/cdp-browser.js`.
- [x] Run the applicable browser probe on a machine with a supported browser; confirm browser startup, page readiness, screenshot, and cleanup still work.

### Acceptance
- Existing probe scripts continue requiring `./cdp.js` without edits or missing exports.
- The new module has a focused responsibility and the browser probe passes when a browser is available.

## Phase 2 — Extract the Server's Pure Rules

### Target boundary

Create `server/rules.js` for low-coupling rule/calculation functions, starting with the currently exported `isWin` and `predictY`. Move additional helpers such as paddle-size calculations or visibility calculations only after confirming they are pure and have stable callers.

### TODOs
- [x] Inventory the candidate functions, constants they read, and every call site in `server.js` and test files.
- [x] Add or strengthen characterization tests for win thresholds, tie/lead edge cases, and `predictY` behavior at zero or near-zero horizontal speed and wall reflections.
- [x] Move only the selected pure implementations into `server/rules.js`; keep `server.js` importing and re-exporting the existing public API.
- [x] Confirm the extracted functions do not read or mutate room state and do not introduce a circular dependency.
- [x] Run `node test-rules.js` and `node tools/check-collision.js`.

### Acceptance
- Existing imports and server exports behave as before; characterization results are unchanged.
- The extracted module can be tested without starting an HTTP/WebSocket server.

## Phase 3 — Extract AI Behavior

### Target boundary

Create `server/bot.js` for `makeBot`, `botPerceive`, `botSteer`, `mostUrgentBall`, and AI prediction helpers, with explicit access to the minimum room data and rule helpers required.

### TODOs
- [x] Map AI inputs to room fields and list behavior that depends on hidden, phantom, split, or multiple balls.
- [x] Define a one-way dependency from AI to shared rules/room data; do not let AI import the server entry point.
- [x] Move AI functions without retuning parameters or changing perception/steering behavior.
- [x] Add focused tests for the existing difficulty settings and AI perception edge cases.
- [x] Run `node test-rules.js`, then `node tools/check-solo.js` and `node tools/check-coop.js` against the local server.

### Acceptance
- Solo and cooperative AI behavior remains compatible, including slot/side ownership and perception rules.

## Phase 4 — Extract Ball Physics

### Target boundary

Create `server/physics.js` for ball construction, stepping, paddle bounce, ball-to-ball collision, black-hole interaction, and stuck-ball recovery. Preserve the existing update order exactly.

### TODOs
- [x] Draw the current call order from `stepRoom` through `stepBalls`, substeps, collision handling, unstick logic, and goal events.
- [x] Identify shared constants and room mutations; pass dependencies explicitly or place shared constants in a dependency-light module rather than importing `server.js`.
- [x] Add or confirm characterization cases for paddle hits, wall bounces, multiple balls, phantom scoring exclusion, black-hole behavior, and vertical/stuck-ball recovery.
- [x] Extract physics functions without changing stepping frequency, event ordering, ball IDs, or scoring ownership.
- [x] Run `node tools/check-collision.js`, `node test-rules.js`, and `node test-protocol.js`.
- [x] Run relevant power-up and game-mode checks for interactions that create or alter balls.

### Acceptance
- Collision scan and protocol tests pass; ball identity and scoring behavior remain unchanged.
- Physics has no dependency on HTTP, WebSocket, DOM, or probe code.

## Phase 5 — Separate Power-Ups and Skills

### Target boundary

Create `server/powerups.js` and `server/skills.js` for pickup lifecycle/effects and player-triggered skills, respectively. Keep shared room/effect contracts explicit and keep pause-time deadline semantics centralized.

### TODOs
- [x] Inventory each effect, duration/deadline field, stacking rule, slot-versus-team rule, and clear/reset path.
- [x] Extract power-up spawn, pickup, update, and clear behavior into `server/powerups.js`.
- [x] Extract skill casting, cooldown, and skill-effect cleanup into `server/skills.js`.
- [x] Keep `trackMods` and deadline shifting in one clearly owned module; do not duplicate clock or pause-freeze logic.
- [x] Preserve snapshot field names and event messages consumed by clients.
- [x] Run `node tools/check-powerup.js`, `node test-protocol.js`, `node test-rules.js`, `node tools/check-solo.js`, and `node tools/check-coop.js`.

### Acceptance
- Power-up and skill tests pass, including duration, cooldown, pause, and independent per-slot behavior.
- Existing wire-protocol fields and event semantics do not change.

### Deviation from the written boundary
- Added a third module, `server/effects.js`, alongside `server/powerups.js` and `server/skills.js`. The TODO below requires `trackMods` and deadline shifting to live in **one** clearly owned module, and `shiftDeadlines` must touch both the power-up deadlines (`growUntil`, `nextPowerupAt`, ball timestamps) and the skill deadlines (`skillReadyAt`, winds, holes, `slowUntil`, `chaosUntil`). Neither domain module can own that alone without the other depending on it, and `trackMods` has the same problem: its expiry sweep deliberately clears skill-side state (`winds`, `holes`, `slowUntil`) because `stepBalls` iterates those arrays unconditionally and only ever pushes. `server/effects.js` is therefore the single owner of the effect clock; `powerups.js` and `skills.js` own only "how an effect is produced".

## Phase 6 — Separate Match/Room Lifecycle from Server I/O

### Target boundary

After the smaller domain modules are stable, move room creation and match lifecycle/state-machine behavior into a dedicated server-domain module (for example `server/match.js`). Leave HTTP routes, WebSocket connection management, and message dispatch in the server entry/transport layer.

### TODOs
- [x] Inventory room creation, join/rejoin, start/reset, countdown, pause/resume, scoring, round completion, and cleanup paths.
- [x] Specify the room state shape and the ownership of each mutation before moving lifecycle functions.
- [x] Extract lifecycle functions while preserving timer order, absolute deadlines, reconnect behavior, room-code/token rules, and exported test helpers.
- [x] Keep WebSocket and HTTP objects out of the match module; use explicit inputs/callbacks for transport-facing effects.
- [x] Run the complete server suite: `node test-rules.js`, `node tools/check-collision.js`, `node test-protocol.js`, `node tools/check-powerup.js`, `node tools/check-solo.js`, and `node tools/check-coop.js`.
- [x] Manually exercise one full match, pause/resume, disconnect/rejoin, scoring, and next-round transitions.

### Acceptance
- Transport code delegates to domain functions; domain modules do not open sockets or listen on ports.
- Protocol and mode regressions pass, including pause and reconnection timing.

## Phase 7 — Extract Front-End CSS

### Target boundary

Move the inline stylesheet from `public/index.html` to `public/index.css`; keep the HTML skeleton and DOM IDs/classes unchanged.

### TODOs
- [x] Capture desktop, portrait mobile, and landscape mobile baselines using the existing browser probes/screenshots.
- [x] Move CSS verbatim to `public/index.css` and link it from the page shell; do not reformat or redesign in the same change.
- [x] Check media-query order, `:has()` behavior/fallbacks, `vh`/`dvh`, safe-area insets, z-index, and fixed/absolute positioning.
- [x] Run local page readiness and mobile probes; compare screenshots and key computed layout/visibility states.

### Acceptance
- No missing style/resource requests; desktop and mobile layout and overlay interactions match baseline.


### Result
- `public/index.css` is **byte-identical** to the old inline `<style>` block, so media-query
  order, the `:has()` rules, the `vh` → `dvh` progressive-enhancement pair, the `env(safe-area-inset-*)`
  usages, `z-index`, and fixed/absolute positioning are preserved by construction.
- `probe.js` 70/0, `probe-mobile.js` 115/6 — **the same 6 failures as before the move**
  (stored-baseline drift on `#pingPill` visibility on this machine, present with and without
  the change), `probe-solo.js` 43/0, `probe-coop.js` 52/0, `probe-powerup-fx.js` 32/0.
- `probe-skills.js` reports one failure ("画布没被这圈光搞停 … 0 帧/220ms"). It is **not**
  caused by this change: reverting to the inline `<style>` block makes that probe fail 4
  assertions instead of 1. The canvas-frame counter does not advance in this headless
  environment either way.
## Phase 8 — Split Front-End Behavior Behind an Explicit App Context

### Target boundary

The current page uses one IIFE whose functions share closure state. Do not split chunks into unrelated scripts that rely on implicit globals. Establish an explicit application context/factory and extract audio, input, UI, network/state, and rendering one area at a time. Keep classic scripts initially; defer `type="module"` conversion.

### TODOs
- [ ] Inventory initialization order, shared state, DOM references, and externally observed probe fields before changing the IIFE.
- [ ] Define the minimal app context passed to each extracted module; avoid duplicate state and circular imports.
- [ ] Extract audio behavior first, preserving trusted gesture listeners and capture-phase registration; verify autoplay unlock and mute controls.
- [ ] Extract input behavior next, preserving keyboard, mouse, touch, pointer, and pause/skill bindings.
- [ ] Extract UI/menu behavior while keeping DOM IDs/classes and session/local storage error handling intact.
- [ ] Extract network and reconnection behavior, preserving `connect()`, connected-state ordering, pending-message flush, and snapshot consumption.
- [ ] Extract rendering/canvas behavior last, preserving device-pixel-ratio sizing, animation timing, and resize/orientation handling.
- [ ] Keep `window.__probe()` available with the same observable fields used by existing probes.
- [ ] Run the local solo/co-op/mobile/cross-play/skills probes as applicable after each extracted area; compare console errors and screenshots.

### Acceptance
- The app loads with no new console or network errors; probes can still inspect the same state.
- Keyboard, touch, audio unlock, room lifecycle, reconnect, and rendering behavior match the baseline on desktop and mobile.

## Phase 9 — Consolidate and Close Out

### TODOs
- [ ] Search for duplicated implementations, stale inline code, unused exports, accidental circular dependencies, and imports from the entry point.
- [x] Confirm the final module dependency direction: shared rules/constants at the base; domain modules above them; transport and UI assembly at the outer layer.
- [x] Run all applicable offline, local-service, browser, and parity checks; document only newly required commands/configuration in the existing project guidance if needed.
- [x] Review the final diff for behavior changes that were not explicitly planned and revert or separately scope them.

### Acceptance
- Server and frontend responsibilities are discoverable from file boundaries, all relevant regression suites pass, and there are no unexplained behavior changes.


### Result (Phases 0-7, 9)
`server.js` 2547 → 1748 lines, with seven dependency-free domain modules under `server/`:

| module | owns |
|---|---|
| `server/rules.js` | `isWin`, `predictY` |
| `server/physics.js` | ball construction, stepping, collisions, black holes, unstick |
| `server/bot.js` | `makeBot`, `botPerceive`, `botSteer`, `mostUrgentBall` |
| `server/powerups.js` | spawn / pickup / effects / per-match reset |
| `server/skills.js` | casting, cooldowns, per-match reset |
| `server/effects.js` | the effect clock: `trackMods`, `shiftDeadlines`, `togglePause` |
| `server/match.js` | room creation, seating, scoring, phase state machine |

Final regression run, all green:
- Offline: `test-rules.js` 392/0, `tools/check-collision.js` 16/0, `test-physics-sequence.js` 3/0,
  `test-cdp-compat.js` pass.
- Live service: `test-protocol.js` 86/0, `tools/check-powerup.js` 18/0, `tools/check-solo.js` 35/0,
  `tools/check-coop.js` 31/0, `test-lifecycle.js` 24/0.
- Browser: `tools/probe.js` 70/0, `probe-solo.js` 43/0, `probe-coop.js` 52/0,
  `probe-powerup-fx.js` 32/0, `probe-mobile.js` 115/6 (same six as before the change).

Known non-regressions in this environment:
- `probe-mobile.js` 6 failures — stored-baseline drift on `#pingPill` visibility; identical
  before and after every change.
- `probe-skills.js` 1 failure ("画布没被这圈光搞停 … 0 帧/220ms") — canvas frame counter does not
  advance in this headless build. Reverting to the inline `<style>` block makes this probe fail
  4 assertions instead of 1, so the CSS move is not the cause.
- `probe-bgm.js` 1-2 failures on the volume-decay assertions — WebAudio ramp timing; the audio
  code was not touched (`public/index.html` has exactly one diff hunk, the `<style>` removal).
- `test-protocol.js` "球确实在移动" flakes occasionally; the test itself documents this
  ("实测偶发过一次（连跑三次，第三次中招）"). 4 of 5 consecutive runs were 86/0.

Consolidation checks that passed: no domain module requires the entry point or another domain
module; every injected dependency is consumed; every method returned by a domain module is
called from `server.js` (48 methods, 0 dead — `verifyPlayer` was the one unused export and was
removed).
## Key Risks and Controls

- **Shared mutable room state:** make ownership and function inputs explicit before extraction; avoid circular imports through the server entry point.
- **Update/event ordering:** preserve `stepRoom` sequencing and physics substep ordering; characterize before moving.
- **Pause and deadlines:** keep the absolute-time and freeze semantics centralized and test resume behavior.
- **Slots versus teams:** cover cooperative mode and per-slot cooldowns in tests.
- **Frontend closure and initialization:** extract one area at a time behind an explicit app context; do not expose all closure variables as globals.
- **Probe contracts:** preserve `window.__probe()`, protocol snapshot fields, DOM selectors, and old `tools/cdp.js` exports until consumers are intentionally migrated.

