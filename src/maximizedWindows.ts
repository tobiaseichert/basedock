// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Window properties that can change whether a window counts.
const WINDOW_SIGNALS = [
    'notify::maximized-horizontally',
    'notify::maximized-vertically',
    'notify::fullscreen',
    'notify::minimized',
    'notify::on-all-workspaces',
    'workspace-changed',
] as const;

/**
 * Track whether a qualifying window on the active workspace and primary
 * monitor should hide the dock. Watch window state, creation, monitor moves
 * and workspace switches. Coalesce changes into one evaluation before the next
 * redraw.
 */
export class MaximizedWindowTracker {
    readonly #onChange: (covered: boolean) => void;
    readonly #windows = new Set<Meta.Window>();
    #laterId = 0;
    #covered = false;

    /** @param onChange called with the new value whenever `covered` changes */
    constructor(onChange: (covered: boolean) => void) {
        this.#onChange = onChange;

        for (const window of global.display.list_all_windows())
            this.#track(window);

        global.display.connectObject(
            'window-created', (_display: Meta.Display, window: Meta.Window) => {
                this.#track(window);
                this.#queueUpdate();
            },
            'window-entered-monitor', () => this.#queueUpdate(),
            'window-left-monitor', () => this.#queueUpdate(),
            this);
        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this.#queueUpdate(),
            this);
        Main.layoutManager.connectObject(
            'monitors-changed', () => this.#queueUpdate(),
            this);

        this.#covered = this.#compute();
    }

    /**
     * True if a non-minimized normal window on the active workspace and
     * primary monitor is maximized or fullscreen. The initial value is
     * available immediately.
     */
    get covered(): boolean {
        return this.#covered;
    }

    #track(window: Meta.Window) {
        if (this.#windows.has(window))
            return;
        this.#windows.add(window);

        for (const signal of WINDOW_SIGNALS)
            window.connectObject(signal, () => this.#queueUpdate(), this);
        window.connectObject('unmanaged', () => {
            window.disconnectObject(this);
            this.#windows.delete(window);
            this.#queueUpdate();
        }, this);
    }

    /** Recompute `covered` before the next redraw, once however often called. */
    #queueUpdate() {
        if (this.#laterId)
            return;
        const laters = global.compositor.get_laters();
        this.#laterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this.#laterId = 0;
            this.#update();
            return false;
        });
    }

    #update() {
        const covered = this.#compute();
        if (covered === this.#covered)
            return;
        this.#covered = covered;
        this.#onChange(covered);
    }

    /**
     * Whether a normal window on the active workspace and the primary
     * monitor is maximized or fullscreen, ignoring minimized ones.
     */
    #compute(): boolean {
        const workspace = global.workspace_manager.get_active_workspace();
        const monitor = Main.layoutManager.primaryIndex;

        for (const window of this.#windows) {
            if (window.get_window_type() !== Meta.WindowType.NORMAL ||
                window.minimized ||
                window.get_monitor() !== monitor ||
                !window.located_on_workspace(workspace))
                continue;
            if (window.is_maximized() || window.is_fullscreen())
                return true;
        }
        return false;
    }

    destroy() {
        if (this.#laterId) {
            global.compositor.get_laters().remove(this.#laterId);
            this.#laterId = 0;
        }
        for (const window of this.#windows)
            window.disconnectObject(this);
        this.#windows.clear();
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
    }
}
