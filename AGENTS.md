# Working on baseDOCK

Read the [README](README.md) first for the dock's behavior, development setup,
commands and source map.

## Verification

- Run `npm run check` for every change. It typechecks, lints and runs the
  integration suite in an isolated headless Shell in about three minutes.
  On Fedora Silverblue, run npm scripts inside the `basedock-dev` distrobox
  set up by `scripts/setup-distrobox.sh`.
- When behavior changes, add or update checks in
  [`tests/harness/integration.js`](tests/harness/integration.js). Verify
  direction-dependent behavior at all three dock positions. See `testSides()`.
- For visual changes, inspect the rendered result. Use `npm run capture` for
  animation, `tests/style-variants.sh` for style comparisons, or a harness that
  captures with `Shell.Screenshot`. Use `npm run nested` to open the build in
  a window for interactive review.

## Session safety

- Use the supplied runners for every test or nested GNOME Shell. Set private
  `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` and, where possible,
  `XDG_RUNTIME_DIR` before `dbus-run-session`. D-Bus starts dconf with the
  bus environment, so setting those paths later can send writes to the user's
  real settings. See [`scripts/lib/common.sh`](scripts/lib/common.sh).
- Stop only processes you started, by their recorded PID. Never kill GNOME
  Shell by name or pattern because those matches include the user's session
  and other nested shells.
- Leave the user's GSettings and installed extensions alone. Run
  `npm run deploy` only when explicitly asked. Trash tests may delete only
  their own fixtures in the private XDG data directory. GVfs can include
  Trash from other mounted volumes.

## Code conventions

- **Style.** Follow GNOME Shell's style as enforced by
  [`lint/eslint.config.js`](lint/eslint.config.js).
- **Lifecycle.** Keep imports free of side effects. Create resources in
  `enable()` and undo them in `disable()`, which also runs on screen lock.
  Each owner must clean up its signals, timeouts, laters, grabs and Shell
  patches in `destroy()`. Prefer `connectObject(..., owner)` and
  `disconnectObject(owner)` to raw handler IDs.
- **Shell internals.** For private members or undocumented signals, cast
  through `unknown` and name the upstream source file in a comment, such
  as `js/ui/dash.js`. Use the actual Shell signature when the typings lag
  behind. In Shell 51, `PopupMenu.open()` and `close()` take a parameter
  object such as `{animate, fadeOnly}`. Restore patched stock objects
  exactly on teardown. See [`src/stockDash.ts`](src/stockDash.ts).
- **GObject subclasses.** GObject calls `_init()` from the parent
  constructor before JavaScript installs subclass fields. Use
  `declare`d underscore fields and ordinary methods for state and helpers
  accessed during `_init()`. See [`src/dash.ts`](src/dash.ts).
- **Names.** Prefix GType names with `Basedock`, CSS classes with
  `basedock-`, custom style properties with `-basedock-` and environment
  variables with `BASEDOCK_`. Other extensions share the Shell process.
- **Translations.** Import `gettext as _` from
  `resource:///org/gnome/shell/extensions/extension.js`. Translate
  user-visible text when constructing the UI, including labels, menu items
  and accessible names. Run `npm run pot` after changing translatable
  strings to refresh `po/basedock.pot`.
- **Orientation and geometry.** Read the side at construction. Changing the
  position rebuilds the dock. Handle bottom, left and right in directional
  code. `src/dash.ts` swaps along-dock and across-dock lengths,
  `stylesheet.css` moves the edge gap, and `src/dockEdge.ts` expresses
  window constraints in a frame with the dock at the bottom. Keep the
  stylesheet geometry rules, `src/geometry.ts`, `_applyGeometry()` and
  the fitting calculation in sync.
- **Main loop and motion.** Keep compositor callbacks short. Coalesce
  bursts with `global.compositor.get_laters()`. Run file and D-Bus I/O
  asynchronously and cancel it with a `Gio.Cancellable` in `destroy()`.
  Check cancellation after an `await` before scheduling more work.
  Honor `St.Settings.get().reducedMotion` for movement by fading or
  skipping the animation.
- **Comments.** Explain what stock behavior motivates a workaround and
  name the Shell source where it comes from. Update that explanation
  alongside the workaround.
- **Icons.** Start files in `icons/` with `<svg` so St detects their type.
  Name symbolic icons `*-symbolic.svg` so St can recolor them.

## Documentation

Update the README's layout, commands and reference table when files, scripts
or conventions change.
