// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import type Meta from 'gi://Meta';
import St from 'gi://St';

import {type Geometry, windowDotCapacity} from './geometry.js';

type WindowDot = {slot: St.Widget, dot: St.Widget};

// Match appMenu.js's window filter and share a stable order with click cycling.
export function taskbarWindows(windows: Meta.Window[]) {
    return windows.filter(window => !window.skip_taskbar)
        .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
}

/** A focused dialog that skips the taskbar shares its parent's indicator. */
export function focusedTaskbarWindow() {
    let window: Meta.Window | null = global.display.focus_window;
    while (window?.skip_taskbar)
        window = window.get_transient_for();
    return window;
}

/** Lay out the window dots inside the stock AppIcon indicator actor. */
export class WindowIndicator {
    readonly #host: St.Widget;
    readonly #vertical: boolean;
    readonly #layout: Clutter.BoxLayout;
    readonly #refresh: () => void;
    #tracked = new Set<Meta.Window>();
    readonly #dots = new Map<Meta.Window, WindowDot>();
    #minimizedScale = 1;

    constructor(host: St.Widget, vertical: boolean, refresh: () => void) {
        this.#host = host;
        this.#vertical = vertical;
        this.#refresh = refresh;
        this.#layout = new Clutter.BoxLayout({
            orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
        });
        host.layout_manager = this.#layout;
    }

    /** Fit the row within the tile along the dock. */
    update(appWindows: Meta.Window[], size: number, g: Geometry, scaleFactor: number) {
        // Shell.App's windows-changed signal need not fire when an existing
        // window becomes a transient. Watch excluded windows as well.
        const tracked = new Set(appWindows);
        for (const window of this.#tracked) {
            if (!tracked.has(window))
                window.disconnectObject(this.#host);
        }
        for (const window of tracked) {
            if (!this.#tracked.has(window))
                window.connectObject('notify::skip-taskbar', this.#refresh, this.#host);
        }
        this.#tracked = tracked;
        const windows = taskbarWindows(appWindows);
        const slotSize = g.dotSize;
        const gap = g.dotSpacing;
        const dotRowLength = windows.length * slotSize + (windows.length - 1) * gap;
        const overflow = windows.length > windowDotCapacity(size);
        const length = overflow ? 3 * slotSize : Math.max(slotSize, dotRowLength);
        const vertical = this.#vertical;
        this.#host.set_size((vertical ? slotSize : length) * scaleFactor,
            (vertical ? length : slotSize) * scaleFactor);

        if (overflow)
            this.#host.add_style_class_name('basedock-window-indicator-overflow');
        else
            this.#host.remove_style_class_name('basedock-window-indicator-overflow');

        const shown = overflow ? [] : windows;
        for (const [window, {slot}] of this.#dots) {
            if (!shown.includes(window)) {
                slot.destroy();
                this.#dots.delete(window);
            }
        }

        this.#layout.spacing = gap * scaleFactor;
        this.#minimizedScale = Math.min(slotSize / 2, Math.round(slotSize / 3) + 0.5) / slotSize;
        for (const [index, window] of shown.entries()) {
            let actors = this.#dots.get(window);
            if (!actors) {
                const slot = new St.Widget({layout_manager: new Clutter.BinLayout()});
                const dot = new St.Widget({
                    style_class: 'basedock-window-dot',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                dot.set_pivot_point(0.5, 0.5);
                slot.add_child(dot);
                this.#host.insert_child_at_index(slot, index);
                this.#dots.set(window, actors = {slot, dot});
                window.connectObject('notify::minimized',
                    () => this.#syncDot(window, dot, focusedTaskbarWindow()), dot);
            }
            actors.slot.set_size(slotSize * scaleFactor, slotSize * scaleFactor);
            actors.dot.set_size(slotSize * scaleFactor, slotSize * scaleFactor);
            actors.dot.style = `border-radius: ${Math.ceil(slotSize / 2)}px;`;
        }
        this.syncFocus(focusedTaskbarWindow());
    }

    syncFocus(focused: Meta.Window | null) {
        for (const [window, {dot}] of this.#dots)
            this.#syncDot(window, dot, focused);
    }

    #syncDot(window: Meta.Window, dot: St.Widget, focused: Meta.Window | null) {
        if (window === focused && !window.minimized)
            dot.add_style_class_name('basedock-window-dot-focused');
        else
            dot.remove_style_class_name('basedock-window-dot-focused');

        // Flatten the dot across the dock, leaving its length and center fixed.
        const across = window.minimized ? this.#minimizedScale : 1;
        dot.set_scale(this.#vertical ? across : 1, this.#vertical ? 1 : across);
    }
}
