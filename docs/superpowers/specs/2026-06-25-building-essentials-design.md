# Building Essentials — Design

Date: 2026-06-25
Status: Approved (design), pending spec review

## Goal

Make building in the Mini Minecraft classroom game more pleasant and add the
essential blocks players expect. Four changes, all inside the single-file
`index.html`, following existing patterns:

1. Transparent white **ghost block** showing where the next block will land.
2. **Chest** — placeable storage with its own per-block 27-slot inventory.
3. **More forgiving building** — bigger reach + relaxed placement rules.
4. **Doors / trapdoors + Bed** — blocky (full-cube) implementations.

Non-goals: ladders (cut from scope), authentic thin-slab geometry for
doors/beds, per-block metadata in the world map, multiplayer sync of chest
contents beyond what the existing block-edit broadcast already covers.

## Existing architecture (constraints)

- `world: Map<"x,y,z", typeString>` — blocks are plain type strings, **no
  per-block metadata**.
- Chunk mesher (`buildChunkMesh`) emits **full 1×1×1 cube faces only**, one
  merged geometry per block type. No partial/slab geometry.
- `BLOCKS` defines render/material; `MINE` hardness; `DROPS` mined output;
  `isSolid`/`isOpaque` gate collision and face culling.
- Generic slot UI: `buildPlayerGrids`, `slotClick(ref, …)` over `ref.get/set`,
  already reused by inventory + furnace. Furnace uses a single **shared**
  inventory across all furnace blocks.
- `rightClick()` already special-cases `crafting` → open craft grid, `furnace`
  → open furnace. Placement cell = `aimBlock + face normal`.
- `updateAim()` ray-marches to `aimBlock` at maxDist 7 and positions the black
  break-highlight.
- Day/night driven by `clock`: `dayAngle = clock*0.025 + π/2`,
  `daylight = clamp((sin(dayAngle)+0.25)/1.25)`, `isNight = daylight < 0.25`.
- Respawn returns the player to the constant `SPAWN`. `respawn()` at ~line 1241.
- Save/load blob built/consumed around lines 2320-2365 (`hotbar`, counts,
  furnace, etc.).

## 1. Ghost placement block

- Add one mesh next to `highlight`: `BoxGeometry(1, 1, 1)` with
  `MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22,
  depthWrite: false })`. `visible = false` initially.
- In `updateAim()`, after computing `aimBlock`:
  - Compute target cell `t = aimBlock + face normal`.
  - Show ghost at `t + 0.5` **iff**: `aimBlock` exists, held item
    `isBlock(held)`, target cell is empty (or replaceable, see §3), and target
    is not one of the two cells the player occupies.
  - Otherwise hide it.
- ~15 lines. No new persistent state.

## 2. Chest

- New `BLOCKS.chest` (planks-brown body texture; reuse a `chest` pattern or the
  `planks` pattern with a tweaked color). `MINE.chest = {h:2.0, t:'axe', l:0}`.
  Default drop is itself.
- Per-block storage: `chestStore: Map<"x,y,z", Array<27> of {id,n}>`. Helper
  `getChest(key)` lazily creates an empty 27-slot array.
- `rightClick()`: add `if (at === 'chest') { openChest(key) ; return; }`.
- `openChest(key)`: open an inventory screen showing the player
  backpack+hotbar grids (via `buildPlayerGrids`) alongside a 27-slot chest grid
  bound to `chestStore.get(key)` through the generic `slotClick`/`ref` system.
  Reuse the existing inventory DOM panel; add a chest container or repurpose the
  furnace panel layout. Closing returns the cursor item to inventory
  (`dumpCursor` equivalent).
- Breaking a chest: in the mine/break path, if `broken === 'chest'`, spawn each
  stored stack as a drop (`spawnDrop`) and delete the `chestStore` entry.
- Crafting: `RECIPES.push({ out: ['chest', 1], shape: ['ppp','p p','ppp'],
  key: { p: 'planks' } })`.
- Save/load: serialize `chestStore` (array of `[key, slots]`) into the save blob
  and restore on load.

## 3. More forgiving building

- **Reach**: change the `rayBlock(..., 7)` in `updateAim()` to `8`. (7 is
  already generous; this is a small nudge.)
- **Relaxed placement** in `rightClick()`:
  - Replace the "same column as player" rejection (current lines ~1923-1924)
    with a check against only the two cells the player's body actually occupies
    (feet cell and head cell at the player's x/z).
  - Allow placing into `water` (and any non-solid replaceable cell): if the
    target cell currently holds `water`, overwrite it instead of rejecting.
  - The ghost block (§1) uses the same predicate so preview and action agree.

## 4. Doors / trapdoors + Bed (blocky, Option A)

No mesher or metadata changes — state encoded via paired block types and a
small respawn variable.

### Door
- Two block types: `door` (solid, opaque, textured as a closed door) and
  `door_open` (non-solid, `alpha` transparent, textured as an open door).
  NOTE: `isSolid` only excludes `water`/`torch`, so alpha blocks like glass are
  still solid. `door_open` and `trapdoor_open` must therefore be added to the
  `isSolid` exclusion list explicitly (e.g. an `OPEN_TYPES` set checked there).
- `rightClick()` on `door`/`door_open`: swap the block type in place
  (`world.set`), `markDirty`, and `broadcastBlockEdit`. No inventory cost.
- Mining either type drops a single `door` item. Placing always places `door`
  (closed).
- `MINE` entries for both; `DROPS.door_open = 'door'`.
- Crafting: `{ out: ['door', 1], shape: ['pp','pp','pp'], key: { p:'planks' } }`.

### Trapdoor
- Same pattern as the door: `trapdoor` (solid) ↔ `trapdoor_open` (non-solid,
  alpha). Right-click toggles. Drops `trapdoor`. Crafting from planks
  (e.g. `['ppp']` 3 planks). Shares the toggle code path with the door (a small
  `TOGGLE = { door:'door_open', door_open:'door', trapdoor:'trapdoor_open',
  trapdoor_open:'trapdoor' }` map).

### Bed
- One full-cube `bed` block (red/white texture). `MINE.bed = {h:0.4, t:null,
  l:0}`, drops itself. Crafting (e.g. wool stand-in: 3 planks row + 3 of an
  existing soft block — pick from available blocks; finalize in the plan).
- `rightClick()` on `bed`:
  - If `isNight`: advance `clock` to the next dawn so `daylight` rises (solve
    `dayAngle = clock*0.025 + π/2` to the next value where `sin(dayAngle)`
    crosses into day), and set the respawn point to the bed.
  - If daytime: show a brief "you can only sleep at night" HUD/chat message
    (reuse existing chat/notice mechanism), do nothing else.
- Respawn: introduce `let respawnPoint = SPAWN.clone()`; sleeping in a bed sets
  it to the bed's position + 1 (standing on top). `respawn()` copies
  `respawnPoint` instead of the constant `SPAWN`. Breaking the bed you spawned
  at resets `respawnPoint` to `SPAWN`.

## Testing / verification

- Unit tests live in `test/` against `shared/` modules; the new logic is in
  `index.html` (browser THREE.js), not easily unit-testable. Verification is
  manual via `npm start` and loading the game:
  1. Ghost block appears only when holding a placeable block, at the correct
     cell, and disappears when aiming at nothing or holding a tool/food.
  2. Place a chest, store items, close, reopen → items persist; break chest →
     items drop; reload save → chest + contents restored.
  3. Reach feels slightly longer; can place a block next to (not inside) self;
     can place a block where water was.
  4. Door/trapdoor toggle open (walkable) and closed (blocks you) on
     right-click; mining drops one door/trapdoor.
  5. Bed at night skips to dawn and sets respawn; dying returns you to the bed;
     bed in daytime shows the notice.
- Run `npm run lint` clean.

## Risks / open questions (resolve in the plan)

- Exact crafting recipes for trapdoor and bed (which existing blocks stand in
  for wool). Default to planks-based recipes if no soft block fits.
  (Resolved: `isSolid` does NOT exclude alpha types — add `door_open` /
  `trapdoor_open` to an explicit non-solid set. See §4.)
- Chest UI: reuse furnace panel layout vs. a dedicated chest panel — decide
  during implementation based on DOM reuse cost.
