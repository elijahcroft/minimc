# Mini Minecraft Classroom — Improvement Batch Prompts

Grounded in a full pass over `index.html` (~6274 lines), `server.js` (939), `shared/protocol.js`, `styles.css`, and the existing `plan.txt` perf notes. Every task below is **self-contained**: paste one block into an agent, tell it the file, done. Tasks are tagged with a model tier and a dependency note.

## How to use this
- **`[HAIKU]`** — mechanical, isolated, low-risk. One clear change, obvious verification.
- **`[SONNET]`** — real logic, touches multiple call sites or adds a system, needs judgment.
- **`[SONNET-HIGH / OPUS]`** — architectural; get one of these right before layering more on top.
- Each task ends with **Verify:** — the success criterion (per goal-driven execution). Run `npm test` and `npm run lint` after any batch.
- Ordering within a section is priority order. Do the **Fixes** section first — some are correctness/crash bugs.
- Line numbers are anchors from the audit; confirm before editing (the file changes as tasks land).

---

## 0. FIXES — do these first (verified in audit)

### F1 `[SONNET]` — Server crash: Map mutated during iteration
`server.js:778` and `server.js:794` delete from `mobs` while iterating it:
```js
for (const [id, m] of mobs) if (m.arenaBoss) mobs.delete(id);
for (const [id, m] of mobs) if (m.colossus)  mobs.delete(id);
```
Deleting from a Map mid-iteration corrupts iteration in V8. Snapshot first: `for (const [id, m] of [...mobs]) …`, or collect ids then delete. Audit both `teacher:spawnArenaBoss` and `teacher:spawnArenaColossus` handlers and any other `mobs.delete` inside a `for…of mobs`.
**Verify:** spawn arena boss twice in a row (teacher panel) — no skipped/duplicated mobs, no server throw in logs.

### F2 `[HAIKU]` — WebSocket payload cap (DoS)
`server.js:899` — the `WebSocketServer` has no `maxPayload`. A single large frame can exhaust RAM. Add `maxPayload: 1024 * 64` (64KB) to the `WebSocketServer({ … })` options. 64KB is far above any legitimate message (largest is a join/inventory blob).
**Verify:** normal join + block edits still work; a hand-crafted >64KB frame closes the connection instead of being parsed.

### F3 `[HAIKU]` — Missing server-side WebSocket error handler
`server.js:899-925` — the connection handler never attaches `ws.on('error', …)`. Add one that logs and lets `ws` close the socket (don't rethrow). Prevents silent/unlogged socket failures.
**Verify:** killing a client mid-message logs a handled error, server stays up.

### F4 `[SONNET]` — Chunk mesh material + texture leak
`index.html:958` and `:1494` — when a chunk group is rebuilt/unloaded, only `m.geometry.dispose()` is called; the `MeshLambertMaterial`/`MeshStandardMaterial` (and any `.map` textures they own) are never disposed. Over a long streaming session this leaks and pressures GC.
Dispose materials alongside geometry on every chunk teardown: for each child mesh, dispose `geometry`, then dispose `material` (handle array materials), and dispose `material.map` **only if** it isn't a shared cached texture. Check whether block textures are shared/cached first — if they are, dispose the material but not the shared texture.
**Verify:** with `?perf=1`, walk ~30s streaming new terrain then back; `renderer.info.memory.geometries` and `.textures` return to a stable baseline instead of climbing monotonically.

### F5 `[SONNET]` — Projectile mesh/geometry leak
`index.html:3418, 3805, 5508` — fireballs, bullets, and arrows do `new THREE.Mesh(new SphereGeometry(...), new MeshBasicMaterial(...))` per shot and only `scene.remove()` on death, never `.dispose()`. Either (a) dispose geometry+material when the projectile is removed, or (b) better: create **one shared geometry + one shared material per projectile type** at module scope and reuse them (projectiles differ only by position/velocity). Prefer (b) — fewer allocations, no GC churn during boss fights.
**Verify:** long dragon fight (spam fireballs) — geometry/material count stays flat in `?perf=1`.

### F6 `[SONNET]` — Bound `blockEdits` growth / rate-limit block spam
`server.js:660` — every `block:set` writes to `blockEdits` and calls `scheduleWorldSave()` with no per-connection rate limit; a malicious/looping client grows the map and thrashes saves. Add a simple token-bucket per socket (e.g. max N block ops/sec, drop excess). Keep it generous enough for legit fast building (e.g. 40/s).
**Verify:** normal building unaffected; a tight `block:set` loop from one client gets throttled, others unaffected.

---

## 1. LEARNING / CLASSROOM (highest classroom leverage)

The teacher system already has: teacher panel, class timer, class quests (mine/build/kill), leaderboard, teleport-all, goto-player, set-mode, spawn bosses. **Missing entirely: moderation and real lesson content.**

### L1 `[SONNET]` — Teacher moderation tools (freeze / mute / announce)
No way to settle a class today. Add teacher-only server handlers + client handling + panel buttons:
- **Freeze / unfreeze** a student (and "freeze all"): server broadcasts `teacher:freeze {target, frozen}`; client disables movement input + shows a "Frozen by teacher" banner while frozen. Teacher is immune.
- **Mute / unmute** a student's chat: server drops `chat` from muted ids and notifies them.
- **Announce**: teacher sends a big centered banner message to all students (distinct from normal chat).
Follow the existing `teacher:*` handler pattern in `server.js` (guard with `ws.isTeacher`) and the client `teacher:*` message map in `index.html` (~line 5317). Add buttons to the teacher panel (`index.html:149+`).
**Verify:** as teacher, freeze a student → they can't move; mute → their chat is suppressed; announce → banner shows for all. Non-teachers can't invoke any of these (server rejects).

### L2 `[SONNET]` — Teacher "kick / return-to-spawn" + student roster actions
The student list (`paintStudentList`, ~`index.html:5155`) shows students with goto/mode buttons. Add per-student **kick** (server closes that socket with a notice) and **send to spawn**. Kick must be `ws.isTeacher`-gated.
**Verify:** teacher kicks a student → that client disconnects with a message; roster updates.
Depends on: L1 pattern.

### L3 `[SONNET]` — Blueprint / build-target lessons (spatial + geometry learning)
Highest-value educational feature. Let the teacher pick a **target structure** students must replicate:
- A small set of hardcoded blueprints (e.g. 5×5 house, staircase, pyramid, a letter/number shape) defined as `{name, cells:[{dx,dy,dz,type}]}`.
- Teacher selects one from the panel → broadcast to students; each student sees a translucent **ghost blueprint** anchored near them (reuse the existing ghost-block material at `index.html` ~ghost mesh).
- Client computes completion % by comparing placed blocks against the blueprint and reports progress (reuse the `quest:progress` plumbing).
- Leaderboard shows blueprint completion.
Great for geometry, counting, symmetry, following instructions.
**Verify:** teacher sets "staircase"; a student sees the ghost outline; placing matching blocks raises their % to 100.
Depends on: existing ghost-block + quest plumbing.

### L4 `[SONNET]` — Per-session teacher report
Server already tracks `kills`, `blocksPlaced`, `questContrib` per player. Add a teacher-panel "Session Report" button that shows a table (name, blocks placed, kills, quest contribution, time connected) and a **Download CSV** action for the teacher's records.
**Verify:** after a few minutes of activity, report shows correct per-student numbers; CSV downloads and opens in a spreadsheet.

### L5 `[HAIKU]` — Educational info cards on ores/blocks
Light-touch learning flavor. When a student mines or hovers an ore (iron, coal, diamond, gold), show a one-line fact toast (reuse `showToast`), e.g. "Diamond is pure carbon — the hardest natural material." Add a small `FACTS` map keyed by block/ore id; fire the toast on first mine of each type per session.
**Verify:** first time mining coal_ore shows the fact toast; second time doesn't spam it.

---

## 2. GAMEPLAY DEPTH

### G1 `[SONNET]` — Armor system
No damage mitigation exists. Add 4 armor items (helmet/chestplate/leggings/boots) in iron + diamond tiers, 4 armor slots in the inventory UI, crafting recipes (reuse `RECIPES` shape system at `index.html:4365`), and damage reduction in `damagePlayer` (`index.html:2383`). Show armor on the HUD (armor bar above hearts) and optionally on the player model.
**Verify:** wearing full iron measurably reduces damage taken from a zombie hit; armor bar renders; recipes craft.

### G2 `[SONNET]` — Falling sand & gravel
Currently `sand`/`gravel` float. When a sand/gravel block loses support (block below removed), convert it to a falling entity that lands on the first solid block below (or reuse a simple per-tick "settle" check on block change). Keep it simple — no need for full physics, just fall-until-supported on the client, and persist the resulting block.
**Verify:** dig under a sand column → it falls and settles; multiplayer sees the result.

### G3 `[SONNET]` — Mob & dropped-item despawn
Server has `despawnDist` for mobs but dropped items persist forever (`index.html` drops), and mob growth can be unbounded client-side. Add: (a) dropped items despawn after ~2 min, (b) confirm server mob cap/despawn is enforced. Reduces clutter and leaks in long classes.
**Verify:** drop items, wait 2 min → they vanish; mob count stays bounded over a long session.

### G4 `[SONNET]` — Simple farming
Add a `wheat`/`crop` block that grows over time (a few stages via block-type swap on a timer, like the door toggle pattern) and drops food when mature; plant on grass/dirt. Reuse `SMELT`/timer patterns. Gives a renewable food loop beyond killing animals.
**Verify:** plant crop → after N seconds it advances stages → harvest yields food.

### G5 `[HAIKU]` — Balance pass + missing drops
Passive mobs mostly drop nothing (cow/sheep/chicken). Add sensible drops (leather/wool stand-in, feathers→arrows, etc.) to the `DROPS`/mob-drop table (`index.html:3645`). Add a `shears`-free wool via sheep drop if simplest. Purely data edits following existing table shape.
**Verify:** killing a cow/chicken now yields items; values match the existing drop-table format.

### G6 `[HAIKU]` — Achievements / milestones toast
Lightweight progression. Fire a one-time toast on milestones: first block mined, first tool crafted, first diamond, first mob killed, reached a planet. Store seen-flags in the existing save blob (`index.html:4819`).
**Verify:** each milestone fires once and survives reload (doesn't re-fire).

---

## 3. UI/UX & QOL

### U1 `[SONNET]` — Settings / pause menu (Esc)
There is **no settings menu** — only URL params (`?shadows=low`, `?perf=1`). Add an Esc pause panel with: mouse sensitivity slider, FOV slider, master SFX volume (procedural audio exists at `index.html:2034`, mute at 2231), invert-Y toggle, shadow quality toggle (wire to existing `SHADOW_QUALITY`), render-scale cap (wire to `MAX_PIXEL_RATIO`/`renderPixelRatio`). Persist to localStorage alongside appearance.
**Verify:** each control changes behavior live and persists across reload; Esc opens/closes it and releases/repods pointer lock cleanly.

### U2 `[HAIKU]` — Delete-world confirmation (footgun)
`index.html:2235` — pressing **P** instantly wipes localStorage and reloads with no confirm. Add a confirm dialog ("Delete your world? This can't be undone.") before wiping.
**Verify:** pressing P prompts; only wipes on explicit confirm.

### U3 `[SONNET]` — Interactive first-run tutorial
Onboarding today is a static controls card on the lock screen (`index.html:22`). Add a dismissible step sequence for first-time players (localStorage-gated): move → look → mine a block → open inventory → craft planks → place a block. Each step highlights the relevant HUD element and advances on completion. Reuse `showToast`/prompt + a small step state machine.
**Verify:** fresh browser gets the guided steps in order; completing each advances; a "skip tutorial" works; doesn't show again after completion.

### U4 `[HAIKU]` — HUD readouts: coordinates + clock
Add a small always-on (or toggchable) HUD line showing X/Y/Z and in-game time (day/night). Data already exists (`controls.getObject().position`, `clock`/`daylight`). Helps navigation and teacher instructions ("meet at 0,64,0").
**Verify:** coordinates update as you move; clock reflects day/night.

### U5 `[HAIKU]` — Hitmarker + damage vignette
Small game-feel wins. Show a brief crosshair "hitmarker" flash when a melee/projectile hits a mob (`hurtMob`, `index.html:3623`), and a red screen-edge vignette when the player takes damage (`damagePlayer`, `index.html:2383`). CSS + a timed class toggle.
**Verify:** hitting a mob flashes the marker; taking damage flashes the vignette.

---

## 4. QOL — inventory & controls

### Q1 `[SONNET]` — Shift-click move + full-inventory sort
Inventory sort (R) only covers the backpack (`index.html:2213`). Add: shift-click a slot to move a whole stack between inventory ↔ chest ↔ furnace (the generic `slotClick`/`ref` system already exists per the design doc), and extend sort to the whole inventory.
**Verify:** shift-click moves stacks correctly across all three panels; sort orders the full inventory without duping/losing items.

### Q2 `[HAIKU]` — Hold-to-place / hold-to-mine cadence + hold-to-eat
Verify continuous actions feel right: holding left mines continuously (crack overlay only updates on stage change per plan.txt item 12), holding right places at a sane repeat rate (not one-per-click), and food uses hold-to-eat with the existing 1.2s cooldown. Fix whichever aren't already continuous.
**Verify:** holding buttons performs repeated actions at a comfortable cadence; no accidental double-place.

### Q3 `[HAIKU]` — Autosave indicator + save-on-visibilitychange
Save happens every ~10s and on `beforeunload`. Add a tiny "Saved" toast/indicator when a save completes, and also save on `visibilitychange` (tab hidden) so students who close tabs don't lose progress.
**Verify:** switching tabs triggers a save; indicator flashes on save.

---

## 5. PERFORMANCE (from plan.txt — hardest last)

These are architectural. Land `?perf=1` instrumentation first, then measure each change. Do **not** batch these blindly with a cheap model.

### P0 `[HAIKU]` — Perf overlay completeness (already partly exists)
`index.html:6126` has a `?perf=1` overlay (FPS, p95, scale, mobs). Extend it with draw calls, triangles, geometries, textures (`renderer.info`), loaded-chunk count, and dirty-queue length so the other perf tasks are measurable.
**Verify:** `?perf=1` shows all listed metrics updating live.

### P1 `[SONNET-HIGH / OPUS]` — Split the frame loop
`index.html:6149` — fixed `FIXED_SIM_DT = 1/90` with up to `MAX_SIM_SLICES=4` means physics/mob-AI/particles/UI/multiplayer-sync can run ~1.5× per rendered frame at 60fps. Separate **fixed-step physics** (run N times) from **once-per-render visual/UI/network work** (run once). This is the biggest stutter source per plan.txt.
**Verify:** with `?perf=1`, per-frame mob/particle/UI work runs once per render; p95 frame time drops; behavior (movement, mobs) unchanged.

### P2 `[SONNET]` — Time-budget chunk generation
`index.html:1541` — `streamChunks()` uses a chunk-count budget but one `genChunk()` can rebuild up to ~5 meshes. Convert to a queue with a **millisecond** budget (stop after ~2–4ms/frame); build the loaded chunk immediately, mark neighbors dirty, spread rebuilds across later frames via `flushDirty()`.
**Verify:** flying into fresh terrain no longer causes multi-frame stalls; `?perf=1` dirty-queue drains smoothly.
Depends on: P0 metrics.

### P3 `[SONNET-HIGH]` — True greedy meshing
`index.html:~1002` merges per-face groups but still emits a quad per visible face. Implement real greedy meshing: merge coplanar adjacent same-type faces into larger quads per direction. Big triangle/draw-call reduction.
**Verify:** `?perf=1` triangle + draw-call counts drop substantially on open terrain; no visual holes/z-fighting; face culling still correct.
Depends on: P0, P2.

### P4 `[SONNET]` — Numeric chunk-local block keys
`index.html:733/823` — world is a `Map<"x,y,z", type>`; mesh builds `split(',').map(Number)` every key every rebuild. Switch to chunk-local numeric encoding (or `{x,y,z,type}` records) so rebuilds skip string parsing. Touches world get/set and the mesher — do after P3 lands.
**Verify:** identical world behavior; mesh rebuild time drops in `?perf=1`; all tests pass.
Depends on: P3.

---

## Suggested dispatch order (by session)

1. **Session A `[HAIKU]` batch** — F2, F3, U2, U4, G5, G6, L5, Q3, P0. Fast, low-risk, independent.
2. **Session B `[SONNET]` fixes** — F1, F4, F5, F6. Correctness + leaks.
3. **Session C `[SONNET]` classroom** — L1, L2, L3, L4. The learning core.
4. **Session D `[SONNET]` gameplay + UX** — G1, G2, G3, G4, U1, U3, U5, Q1, Q2.
5. **Session E `[SONNET-HIGH/OPUS]` perf** — P1, then P2, P3, P4 in order, measuring each.

Run `npm test && npm run lint` at the end of every session. Manual smoke-test in `npm start` for anything touching rendering, multiplayer, or the teacher panel.
