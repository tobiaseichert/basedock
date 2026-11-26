// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

import type Meta from 'gi://Meta';
import type Mtk from 'gi://Mtk';

/**
 * Use each app's dock tile as the Meta.Window icon geometry for Shell's
 * minimize and restore animations (windowManager.js). Shell scales toward or
 * from that rectangle. Without it, Shell uses a top corner of the monitor.
 * Monitor-sized windows and reduced motion use a fade.
 *
 * Update the geometry when Mutter reports a minimize state change, before the
 * queued animation runs (meta_window_minimize in window.c). This reads the
 * current tile position without tracking each dock layout.
 *
 * Save the previous geometry and restore it when the dock releases the target.
 * Preserve any newer geometry supplied by another owner.
 */
export class MinimizeTarget {
    readonly #getTarget: (window: Meta.Window) => Mtk.Rectangle | null;
    /** Every window, watched for minimizing. */
    readonly #windows = new Set<Meta.Window>();
    readonly #targeted = new Map<Meta.Window, {
        previous: Mtk.Rectangle | null;
        applied: Mtk.Rectangle;
    }>();

    /**
     * @param getTarget - The tile's rectangle in stage coordinates, or
     *   null when the tile is unavailable.
     */
    constructor(getTarget: (window: Meta.Window) => Mtk.Rectangle | null) {
        this.#getTarget = getTarget;
        for (const window of global.display.list_all_windows())
            this.#track(window);
        global.display.connectObject('window-created',
            (_display: Meta.Display, window: Meta.Window) => this.#track(window), this);
    }

    #track(window: Meta.Window) {
        this.#windows.add(window);
        window.connectObject(
            'notify::minimized', () => this.#sync(window),
            'unmanaged', () => {
                window.disconnectObject(this);
                this.#windows.delete(window);
                this.#targeted.delete(window);
            },
            this);
    }

    #sync(window: Meta.Window) {
        const rect = this.#getTarget(window);
        if (!rect) {
            this.#restore(window);
            return;
        }

        const [hasGeometry, current] = window.get_icon_geometry();
        const saved = this.#targeted.get(window);
        let previous = hasGeometry ? current : null;
        if (hasGeometry && saved?.applied.equal(current))
            previous = saved.previous;
        window.set_icon_geometry(rect);
        this.#targeted.set(window, {previous, applied: rect});
    }

    #restore(window: Meta.Window) {
        const saved = this.#targeted.get(window);
        if (!saved)
            return;
        this.#targeted.delete(window);
        const [hasGeometry, current] = window.get_icon_geometry();
        if (hasGeometry && saved.applied.equal(current))
            window.set_icon_geometry(saved.previous);
    }

    destroy() {
        global.display.disconnectObject(this);
        for (const window of this.#windows)
            window.disconnectObject(this);
        for (const window of this.#targeted.keys())
            this.#restore(window);
        this.#windows.clear();
    }
}
