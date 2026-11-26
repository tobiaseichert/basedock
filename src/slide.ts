// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import St from 'gi://St';

/**
 * Animate large position changes along the dock by drawing each child at its
 * previous position, then easing its translation to zero. Skip items animating
 * out. A minimum jump threshold lets small steps from stock animations, such
 * as scaling a placeholder, pass through directly.
 *
 * suspend() keeps recording allocations while suppressing slides until the
 * next stage paint. Use it for changes such as icon resizing.
 */
export class ChildSlider {
    readonly #box: Clutter.Actor;
    readonly #minJump: () => number;
    readonly #duration: number;
    readonly #vertical: boolean;
    /** Each child's last position along the dock. */
    readonly #last = new Map<Clutter.Actor, number>();
    #suspendedId = 0;

    constructor(box: Clutter.Actor, minJump: () => number, duration: number, vertical = false) {
        this.#box = box;
        this.#minJump = minJump;
        this.#duration = duration;
        this.#vertical = vertical;

        box.connectObject('child-added',
            (_box: Clutter.Actor, child: Clutter.Actor) => this.#track(child), this);
        for (const child of box.get_children())
            this.#track(child);
    }

    #track(child: Clutter.Actor) {
        child.connectObject(
            'notify::allocation', () => this.#onAllocation(child),
            'destroy', () => this.#last.delete(child),
            this);
    }

    /**
     * Record `child`'s new layout position, and if it jumped far enough,
     * slide it there from where it was drawn.
     */
    #onAllocation(child: Clutter.Actor) {
        const box = child.get_allocation_box();
        const pos = this.#vertical ? box.y1 : box.x1;
        const last = this.#last.get(child);
        this.#last.set(child, pos);

        // First layout of a new child: nothing to slide from.
        if (last === undefined || pos === last || this.#suspendedId)
            return;
        if ((child as {animatingOut?: boolean}).animatingOut)
            return;
        if (Math.abs(pos - last) < this.#minJump())
            return;
        // Reduced motion (Settings → Accessibility): jump, like the stock
        // dash outside the overview.
        if (St.Settings.get().reducedMotion === St.ReducedMotion.REDUCE)
            return;

        // Where it was drawn (layout position plus any slide in progress),
        // relative to the new layout position.
        const mode = Clutter.AnimationMode.EASE_OUT_QUAD;
        if (this.#vertical) {
            const offset = last + child.translation_y - pos;
            child.remove_transition('translation-y');
            child.translation_y = offset;
            child.ease({translationY: 0, duration: this.#duration, mode});
        } else {
            const offset = last + child.translation_x - pos;
            child.remove_transition('translation-x');
            child.translation_x = offset;
            child.ease({translationX: 0, duration: this.#duration, mode});
        }
    }

    /**
     * Apply the layout changes up to the next frame directly, without
     * sliding. Lasts until the stage has painted once.
     */
    suspend() {
        if (this.#suspendedId)
            return;
        const stage = this.#box.get_stage() ?? global.stage;
        this.#suspendedId = stage.connect('after-paint', () => {
            stage.disconnect(this.#suspendedId);
            this.#suspendedId = 0;
        });
    }

    destroy() {
        if (this.#suspendedId) {
            (this.#box.get_stage() ?? global.stage).disconnect(this.#suspendedId);
            this.#suspendedId = 0;
        }
        this.#box.disconnectObject(this);
        for (const child of this.#last.keys())
            child.disconnectObject(this);
        for (const child of this.#box.get_children())
            child.disconnectObject(this);
        this.#last.clear();
    }
}
