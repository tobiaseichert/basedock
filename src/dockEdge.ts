// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';

import type {DockSide} from './side.js';

type Rect = {x: number, y: number, width: number, height: number};

/** Geometry used by window move, resize and tiling constraints. */
export interface DockEdgeGeometry {
    /** The screen edge the dock is at. */
    side: DockSide;
    /**
     * The inner edge in stage coordinates. Use the top y coordinate at the
     * bottom, the right x coordinate at the left, and the left x coordinate at
     * the right.
     */
    edge: number;
    /** The bounds along the edge in stage coordinates (x, or y at a side). */
    start: number;
    end: number;
    /** The monitor the dock is on, in stage coordinates. */
    monitor: Rect & {index: number};
    /** The dock background in stage coordinates. */
    bounds: Rect;
}

/*
 * Express constraints in a coordinate frame with the dock at the bottom. For
 * side docks, frame x is screen y and frame y is screen x. Mirror frame y for
 * a left dock so increasing y always moves toward the dock. Convert window
 * rectangles at the boundary with Mutter. Grab operations and resize gravities
 * still refer to physical screen edges.
 */

/** The dock's edge in its frame: the top of a dock at the bottom. */
interface FrameEdge {
    y: number;
    x1: number;
    x2: number;
    monitor: Rect;
}

/** A rectangle on the screen, in the dock's frame. */
function toFrame(rect: Rect, side: DockSide): Rect {
    switch (side) {
        case 'left':
            return {x: rect.y, y: -(rect.x + rect.width), width: rect.height, height: rect.width};
        case 'right':
            return {x: rect.y, y: rect.x, width: rect.height, height: rect.width};
        default:
            return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
    }
}

/** A rectangle in the dock's frame, back on the screen, for mutter. */
function fromFrame(rect: Rect, side: DockSide): Mtk.Rectangle {
    switch (side) {
        case 'left':
            return new Mtk.Rectangle({x: -(rect.y + rect.height), y: rect.x,
            width: rect.height, height: rect.width});
        case 'right':
            return new Mtk.Rectangle({x: rect.y, y: rect.x, width: rect.height, height: rect.width});
        default:
            return new Mtk.Rectangle({x: rect.x, y: rect.y, width: rect.width, height: rect.height});
    }
}

/** The dock's edge and monitor, in the dock's frame. */
function frameEdge(edge: DockEdgeGeometry): FrameEdge {
    return {
        y: edge.side === 'left' ? -edge.edge : edge.edge,
        x1: edge.start,
        x2: edge.end,
        monitor: toFrame(edge.monitor, edge.side),
    };
}

// Match Mutter's monitor-edge resistance threshold
// (PIXEL_DISTANCE_THRESHOLD_TOWARDS_MONITOR in
// src/compositor/edge-resistance.c).
const POINTER_THRESHOLD = 32;

// These gravities hold the far edge fixed while resizing the edge facing the
// dock. See meta_resize_gravity_from_grab_op in Mutter.
const FACING_EDGE_GRAVITIES: Record<DockSide, Set<Meta.Gravity>> = {
    bottom: new Set([Meta.Gravity.NORTH, Meta.Gravity.NORTH_WEST, Meta.Gravity.NORTH_EAST]),
    left: new Set([Meta.Gravity.EAST, Meta.Gravity.NORTH_EAST, Meta.Gravity.SOUTH_EAST]),
    right: new Set([Meta.Gravity.WEST, Meta.Gravity.NORTH_WEST, Meta.Gravity.SOUTH_WEST]),
};

// Grab ops this handles: moves, and resizes of the edge facing the dock.
// The UNCONSTRAINED variants explicitly skip mutter's constraints and
// resistance, so they skip ours too.
const MOVE_OPS = new Set([Meta.GrabOp.MOVING, Meta.GrabOp.KEYBOARD_MOVING]);
const RESIZE_OPS: Record<DockSide, Set<Meta.GrabOp>> = {
    bottom: new Set([
        Meta.GrabOp.RESIZING_S,
        Meta.GrabOp.RESIZING_SE,
        Meta.GrabOp.RESIZING_SW,
        Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN,
        Meta.GrabOp.KEYBOARD_RESIZING_S,
        Meta.GrabOp.KEYBOARD_RESIZING_SE,
        Meta.GrabOp.KEYBOARD_RESIZING_SW,
    ]),
    left: new Set([
        Meta.GrabOp.RESIZING_W,
        Meta.GrabOp.RESIZING_NW,
        Meta.GrabOp.RESIZING_SW,
        Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN,
        Meta.GrabOp.KEYBOARD_RESIZING_W,
        Meta.GrabOp.KEYBOARD_RESIZING_NW,
        Meta.GrabOp.KEYBOARD_RESIZING_SW,
    ]),
    right: new Set([
        Meta.GrabOp.RESIZING_E,
        Meta.GrabOp.RESIZING_NE,
        Meta.GrabOp.RESIZING_SE,
        Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN,
        Meta.GrabOp.KEYBOARD_RESIZING_E,
        Meta.GrabOp.KEYBOARD_RESIZING_NE,
        Meta.GrabOp.KEYBOARD_RESIZING_SE,
    ]),
};

const bottomOf = (rect: Rect) => rect.y + rect.height;

/** Whether `rect`, in the dock's frame, overlaps the dock along its edge. */
const overlaps = (rect: Rect, edge: FrameEdge) =>
    rect.x < edge.x2 && rect.x + rect.width > edge.x1;

function intersects(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.width && a.x + a.width > b.x &&
        a.y < b.y + b.height && a.y + a.height > b.y;
}

function fitsClientMinimum(window: Meta.Window, frame: Mtk.Rectangle): boolean {
    const [known, minWidth, minHeight] = window.get_min_size();
    if (!known)
        return true;
    const client = window.frame_rect_to_client_rect(frame);
    return client.width >= minWidth && client.height >= minHeight;
}

/** A window's frame rectangle, in the dock's frame. */
const frameRect = (window: Meta.Window, edge: DockEdgeGeometry) =>
    toFrame(window.get_frame_rect(), edge.side);

/**
 * Use Mutter's titlebar visibility threshold from constrain_titlebar_visible
 * in src/core/constraints.c. Keep a quarter of the given dimension reachable,
 * clamped to 10–75 px. Measuring from the top of the window frame also covers
 * client-drawn header bars.
 */
const reachable = (size: number) => Math.min(Math.max(Math.floor(size / 4), 10), 75);

/**
 * Shift the window away from the dock just far enough to expose its titlebar.
 * Return null if the titlebar is already reachable.
 *
 * At the bottom, keep the required height of the titlebar above the dock
 * unless enough of its width lies beside the dock and on the monitor. At a
 * side, keep the required window width clear unless the titlebar is above or
 * below the dock. reachable() supplies the required width and height.
 */
function reachablePosition(rect: Rect, edge: DockEdgeGeometry): Mtk.Rectangle | null {
    const frame = toFrame(rect, edge.side);
    const fe = frameEdge(edge);
    const top = reachable(frame.height);
    if (frame.y + top <= fe.y)
        return null;
    if (edge.side === 'bottom') {
        const {monitor} = edge;
        const right = Math.min(rect.x + rect.width, monitor.x + monitor.width);
        const left = Math.max(rect.x, monitor.x);
        const covered = Math.max(0, Math.min(right, edge.end) - Math.max(left, edge.start));
        if (right - left - covered >= reachable(rect.width))
            return null;
    } else if (rect.y + reachable(rect.height) <= edge.start || rect.y >= edge.end) {
        return null;
    }
    return fromFrame({...frame, y: fe.y - top}, edge.side);
}

/**
 * Keep the titlebar reachable throughout a move grab. A Mutter external
 * constraint applies the limit before the window can visibly overshoot it.
 */
const TitlebarLimit = GObject.registerClass({
    GTypeName: 'BasedockTitlebarLimit',
    Implements: [Meta.ExternalConstraint],
}, class TitlebarLimit extends GObject.Object {
    /** The visible dock's edge, or null to not constrain. */
    _getEdge: () => DockEdgeGeometry | null = () => null;

    vfunc_constrain(_window: Meta.Window, info: Meta.ExternalConstraintInfo): boolean {
        if (!(info.flags & Meta.ExternalConstraintFlags.MOVE))
            return true;
        const edge = this._getEdge();
        // The grab can overshoot the whole dock in one motion. Use the
        // proposed frame’s monitor so the same grab can leave the primary.
        if (!edge || global.display.get_monitor_index_for_rect(info.new_rect) !== edge.monitor.index)
            return true;

        const rect = reachablePosition(info.new_rect, edge);
        if (rect)
            info.set_rect(rect);
        return true;
    }
});

/**
 * Stop the window at the dock's inner edge during a resize grab. Mutter
 * applies external constraints after its own constraints and before
 * configuring the client.
 */
const ResizeLimit = GObject.registerClass({
    GTypeName: 'BasedockResizeLimit',
    Implements: [Meta.ExternalConstraint],
}, class ResizeLimit extends GObject.Object {
    /** The dock's edge for a window at `rect`, or null to not constrain. */
    _getEdge: (rect: Mtk.Rectangle) => DockEdgeGeometry | null = () => null;

    vfunc_constrain(window: Meta.Window, info: Meta.ExternalConstraintInfo): boolean {
        if (!(info.flags & Meta.ExternalConstraintFlags.RESIZE))
            return true;

        const edge = this._getEdge(info.new_rect);
        if (!edge || !FACING_EDGE_GRAVITIES[edge.side].has(info.resize_gravity))
            return true;
        const rect = endAtEdge(info.new_rect, edge);
        if (rect && fitsClientMinimum(window, rect))
            info.set_rect(rect);
        return true;
    }
});

/**
 * Trim the edge of `rect` facing the dock to the dock's inner edge. Return
 * null if it already ends at or before the edge, or lies entirely behind the
 * dock.
 */
function endAtEdge(rect: Rect, edge: DockEdgeGeometry): Mtk.Rectangle | null {
    const frame = toFrame(rect, edge.side);
    const {y} = frameEdge(edge);
    if (bottomOf(frame) <= y || y <= frame.y)
        return null;
    return fromFrame({...frame, height: y - frame.y}, edge.side);
}

/**
 * Treat vertically maximized windows as tiled, including windows maximized
 * only in height. Fully maximized and fullscreen windows are excluded.
 */
const isTiled = (window: Meta.Window) =>
    window.maximized_vertically && !window.maximized_horizontally && !window.is_fullscreen();

/**
 * Trim overlapping tiles to the dock's visible edge after Mutter computes
 * their normal work-area size (constrain_maximization and constrain_tiling in
 * src/core/constraints.c). Attach this constraint only while tiled because
 * Mutter would otherwise call it for every constraint pass, including ordinary
 * moves.
 */
const TileLimit = GObject.registerClass({
    GTypeName: 'BasedockTileLimit',
    Implements: [Meta.ExternalConstraint],
}, class TileLimit extends GObject.Object {
    /** The visible dock's edge, or null to not constrain. */
    _getEdge: () => DockEdgeGeometry | null = () => null;

    vfunc_constrain(window: Meta.Window, info: Meta.ExternalConstraintInfo): boolean {
        if (!isTiled(window))
            return true;
        const edge = this._getEdge();
        if (!edge || !intersects(info.new_rect, edge.bounds))
            return true;
        const rect = endAtEdge(info.new_rect, edge);
        if (rect && fitsClientMinimum(window, rect))
            info.set_rect(rect);
        return true;
    }
});

/**
 * Apply monitor-like edge resistance when a window moves toward the dock.
 * Hold pointer moves at the edge until the proposed window edge passes it by
 * more than POINTER_THRESHOLD px. Keyboard moves stop on the first crossing
 * step and pass on the next. Mutter provides no extra resistance edges, so
 * correct the window in position-changed before redraw. Pointer motion uses
 * absolute coordinates, so corrections do not accumulate.
 *
 * TitlebarLimit keeps a window reachable if it goes behind the dock.
 * ResizeLimit stops a resize at the edge. The resistance and resize stop apply
 * only when the dock is visible, the window overlaps its span and the grab
 * starts on the accessible side of the edge.
 *
 * TileLimit refits tiled windows after the dock shows, hides, moves or changes
 * size automatically. During a manual dock resize, roomBeforeTiles() caps dock
 * growth at existing tiles.
 */
export class DockEdge {
    readonly #side: DockSide;
    readonly #getEdge: () => DockEdgeGeometry | null;
    readonly #getTileEdge: () => DockEdgeGeometry | null;
    readonly #resizeLimit = new ResizeLimit();
    readonly #titlebarLimit = new TitlebarLimit();
    readonly #tileLimit = new TileLimit();
    /** Every window, watched for being tiled. */
    readonly #windows = new Set<Meta.Window>();
    /** The tiled ones, with #tileLimit attached. */
    readonly #tiled = new Set<Meta.Window>();
    #refreshId = 0;
    #window: Meta.Window | null = null;
    #resizing = false;
    // Moves
    #keyboard = false;
    #lastBottom = 0;
    #correcting = false;

    /**
     * @param side the screen edge the dock is at
     * @param getEdge - The current edge, or null to skip move and resize
     *   constraints and resistance.
     * @param getTileEdge - The desktop edge used for tiling, including in
     *   the overview, or null to leave tiles at their stock size.
     */
    constructor(side: DockSide, getEdge: () => DockEdgeGeometry | null,
        getTileEdge: () => DockEdgeGeometry | null) {
        this.#side = side;
        this.#getEdge = getEdge;
        this.#getTileEdge = getTileEdge;
        this.#resizeLimit._getEdge = rect => this.#edgeFor(rect);
        this.#titlebarLimit._getEdge = () => this.#getEdge();
        this.#tileLimit._getEdge = () => this.#getTileEdge();

        for (const window of global.display.list_all_windows())
            this.#track(window);
        global.display.connectObject(
            'grab-op-begin', (_d: Meta.Display, window: Meta.Window, op: Meta.GrabOp) =>
                this.#begin(window, op),
            'grab-op-end', () => this.#end(),
            'window-created', (_d: Meta.Display, window: Meta.Window) => this.#track(window),
            this);
        this.refreshTiles();
    }

    /**
     * Use #tileLimit as the owner of the tiling signals. Ending a grab
     * disconnects signals owned by this instance, while tiling still needs to
     * be tracked.
     */
    #track(window: Meta.Window) {
        this.#windows.add(window);
        const sync = () => this.#syncTiled(window);
        window.connectObject(
            'notify::maximized-vertically', sync,
            'notify::maximized-horizontally', sync,
            'notify::fullscreen', sync,
            'unmanaged', () => {
                window.disconnectObject(this.#tileLimit);
                this.#windows.delete(window);
                this.#tiled.delete(window);
            },
            this.#tileLimit);
        this.#syncTiled(window);
    }

    /**
     * Attach #tileLimit while the window is tiled. Mutter can deliver the
     * state change after allocating the tile, so request a refit when the
     * constraint is first attached.
     */
    #syncTiled(window: Meta.Window) {
        const tiled = isTiled(window);
        if (tiled === this.#tiled.has(window))
            return;
        if (tiled) {
            this.#tiled.add(window);
            window.add_external_constraint(this.#tileLimit);
            this.refreshTiles();
        } else {
            this.#tiled.delete(window);
            window.remove_external_constraint(this.#tileLimit);
        }
    }

    /**
     * Fit tiled windows to the dock's edge again, before the next redraw.
     * Call when the dock shows, hides, moves or changes size by itself.
     * Calls before the redraw are coalesced into one refit.
     */
    refreshTiles() {
        if (this.#refreshId)
            return;
        this.#refreshId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this.#refreshId = 0;
            this.#reconstrainTiles();
            return false;
        });
    }

    /**
     * Return how far the dock's inner edge can grow in stage pixels before
     * meeting a non-minimized tile on the active workspace. Return Infinity
     * when geometry is unavailable or no tile overlaps the dock's span.
     */
    roomBeforeTiles(): number {
        const edge = this.#getTileEdge();
        if (!edge)
            return Infinity;
        const fe = frameEdge(edge);
        const workspace = global.workspace_manager.get_active_workspace();
        let room = Infinity;
        for (const window of this.#tiled) {
            const rect = frameRect(window, edge);
            if (window.minimized || !window.located_on_workspace(workspace) ||
                !overlaps(rect, fe))
                continue;
            room = Math.min(room, Math.max(0, fe.y - bottomOf(rect)));
        }
        return room;
    }

    /**
     * Move each tile to its current position to rerun Mutter's constraints.
     * Mutter starts each pass from the full tile, so TileLimit can trim it to
     * the new edge. Once the constraint is removed, the same operation
     * restores the full tile.
     */
    #reconstrainTiles() {
        for (const window of this.#tiled) {
            const {x, y} = window.get_frame_rect();
            window.move_frame(false, x, y);
        }
    }

    /**
     * For a move grab, attach titlebar protection and listen for crossings of
     * the dock edge. For a resize of the edge facing the dock, attach
     * ResizeLimit if the window starts at or before that edge.
     */
    #begin(window: Meta.Window, op: Meta.GrabOp) {
        this.#end();

        const edge = this.#getEdge();
        const side = this.#side;
        const rect = toFrame(window.get_frame_rect(), side);

        if (MOVE_OPS.has(op)) {
            this.#window = window;
            this.#keyboard = op === Meta.GrabOp.KEYBOARD_MOVING;
            this.#lastBottom = bottomOf(rect);
            window.connectObject(
                'position-changed', () => this.#onMoved(), this);
            window.add_external_constraint(this.#titlebarLimit);
        } else if (RESIZE_OPS[side].has(op)) {
            // Only windows that start at or above the edge get stopped by it.
            if (edge && bottomOf(rect) > frameEdge(edge).y)
                return;
            this.#window = window;
            this.#resizing = true;
            window.add_external_constraint(this.#resizeLimit);
        }
    }

    /** The grab ends: remove what #begin() attached to the window. */
    #end() {
        const window = this.#window;
        if (!window)
            return;
        if (this.#resizing) {
            window.remove_external_constraint(this.#resizeLimit);
        } else {
            window.remove_external_constraint(this.#titlebarLimit);
            window.disconnectObject(this);
        }
        this.#window = null;
        this.#resizing = false;
    }

    /**
     * The dock's edge for a window being resized to `rect`; null if the
     * dock is hidden or the window doesn't overlap it along its edge.
     */
    #edgeFor(rect: Mtk.Rectangle): DockEdgeGeometry | null {
        const edge = this.#getEdge();
        return edge && intersects(rect, edge.bounds) ? edge : null;
    }

    /**
     * Edge resistance for the window being moved (see DockEdge): if this
     * step takes it across the dock's edge, and it's not yet pushed far
     * enough past it, move it back so it rests on the edge.
     */
    #onMoved() {
        const window = this.#window;
        if (!window || this.#correcting)
            return;

        const edge = this.#getEdge();
        if (!edge)
            return;
        const fe = frameEdge(edge);
        const rect = frameRect(window, edge);
        const bottom = bottomOf(rect);
        const lastBottom = this.#lastBottom;
        this.#lastBottom = bottom;
        if (!intersects(window.get_frame_rect(), edge.bounds))
            return;

        const past = bottom - fe.y;
        const hold = this.#keyboard
            // Crossing in this step, from strictly above.
            ? lastBottom < fe.y && past > 0
            // From at or above the edge, and not yet pushed far enough.
            : lastBottom <= fe.y && past > 0 && past <= POINTER_THRESHOLD;
        if (!hold)
            return;

        this.#correcting = true;
        try {
            const {x, y} = fromFrame({...rect, y: fe.y - rect.height}, edge.side);
            window.move_frame(true, x, y);
        } finally {
            this.#correcting = false;
        }
        this.#lastBottom = fe.y;
    }

    /** Stop watching windows, and give tiled windows their full tile again. */
    destroy() {
        this.#end();
        global.display.disconnectObject(this);
        if (this.#refreshId) {
            global.compositor.get_laters().remove(this.#refreshId);
            this.#refreshId = 0;
        }
        for (const window of this.#windows)
            window.disconnectObject(this.#tileLimit);
        // Tiled windows take their full tile again.
        for (const window of this.#tiled)
            window.remove_external_constraint(this.#tileLimit);
        this.#reconstrainTiles();
        this.#windows.clear();
        this.#tiled.clear();
    }
}
