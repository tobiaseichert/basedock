// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {isVertical, type DockSide} from './side.js';

/** Callbacks the dock implements for a resize drag. */
export interface ResizeTarget {
    /** A drag starts, grabbing the dock at (x, y), stage coordinates. */
    beginResize(x: number, y: number): void;
    /**
     * Total displacement from the drag start in stage pixels.
     * Positive `grow` moves away from the screen edge, negative toward it.
     */
    previewResize(grow: number): void;
    /** The drag ends (or is cancelled) `grow` px away, as in previewResize. */
    commitResize(grow: number): void;
}

/**
 * Attach an actor-owned resize gesture to a divider or the dock's inner
 * border. Drag away from the screen edge to grow and toward it to shrink. The
 * target maps displacement to a size within its limits.
 *
 * Clutter.PanGesture, also used in slider.js, follows pointer and touch drags
 * outside the actor. Recognize the press immediately so resizing starts with
 * the first pixel of movement.
 */
export class ResizeDrag {
    readonly #target: ResizeTarget;
    readonly #side: DockSide;
    readonly #gesture: Clutter.PanGesture;
    #grow = 0;

    constructor(actor: Clutter.Actor, target: ResizeTarget, side: DockSide) {
        this.#target = target;
        this.#side = side;
        const vertical = isVertical(side);
        actor.reactive = true;
        actor.cursor_type = vertical ? Clutter.CursorType.EW_RESIZE : Clutter.CursorType.NS_RESIZE;

        this.#gesture = new Clutter.PanGesture({
            pan_axis: vertical ? Clutter.PanAxis.X : Clutter.PanAxis.Y,
            max_n_points: 1,
            required_button: Clutter.BUTTON_PRIMARY,
        });
        this.#gesture.set_begin_threshold(0);
        this.#gesture.connect('recognize', () => this.#onBegin());
        this.#gesture.connect('pan-update', () => this.#onUpdate());
        // Cancelled (e.g. another grab took over): keep the size reached,
        // so the dock isn't left mid-drag.
        this.#gesture.connect('end', () => this.#onEnd());
        this.#gesture.connect('cancel', () => this.#onEnd());
        actor.add_action(this.#gesture);
    }

    #onBegin() {
        const {x, y} = this.#gesture.get_begin_centroid_abs();
        this.#grow = 0;
        this.#target.beginResize(x, y);
    }

    #onUpdate() {
        const delta = this.#gesture.get_accumulated_delta_abs();
        let grow = -delta.get_y();
        if (this.#side === 'left')
            grow = delta.get_x();
        else if (this.#side === 'right')
            grow = -delta.get_x();
        if (grow !== this.#grow) {
            this.#grow = grow;
            this.#target.previewResize(grow);
        }
    }

    #onEnd() {
        this.#target.commitResize(this.#grow);
    }
}

/**
 * A transparent resize handle around a visible separator line. The stylesheet
 * sets the line to 1px across either orientation. setThickness() adjusts its
 * rendered width for the monitor scale.
 */
export class ResizeHandle {
    readonly actor: St.Bin;
    readonly line: St.Widget;
    readonly #vertical: boolean;

    constructor(target: ResizeTarget, side: DockSide) {
        this.#vertical = isVertical(side);
        const align = this.#vertical
            ? {x_align: Clutter.ActorAlign.CENTER}
            : {y_align: Clutter.ActorAlign.CENTER};
        this.line = new St.Widget({style_class: 'dash-separator', ...align});
        this.actor = new St.Bin({style_class: 'basedock-handle', child: this.line, ...align});
        new ResizeDrag(this.actor, target, side);
    }

    /** Make the line and its grab area `length` long across the dock (the icon size). */
    setLength(length: number) {
        if (this.#vertical) {
            this.line.width = length;
            this.actor.width = length;
        } else {
            this.line.height = length;
            this.actor.height = length;
        }
    }

    /**
     * Draw the line `thickness` stage px thick, along the dock, instead of
     * the stylesheet's 1px. By scaling it about its center: the layout
     * rounds sizes to whole stage px, and the line keeps its place in it.
     */
    setThickness(thickness: number) {
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const scale = thickness / scaleFactor;
        this.line.set_pivot_point(0.5, 0.5);
        if (this.#vertical)
            this.line.scale_y = scale;
        else
            this.line.scale_x = scale;
    }

    /**
     * The line's thickness along the dock as laid out (stage px), from the
     * stylesheet: setThickness() only scales how it's drawn.
     */
    lineThickness(): number {
        return this.#vertical
            ? this.line.get_preferred_height(-1)[1]
            : this.line.get_preferred_width(-1)[1];
    }
}
