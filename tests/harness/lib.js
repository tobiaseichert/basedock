// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

// Shared helpers loaded by the staged extension before enable() in the
// headless test shell.
//
// Protocol (read by run-headless.sh from the shell log):
//   BASEDOCK-HARNESS PASS <name>
//   BASEDOCK-HARNESS FAIL <name>: <reason>
//   BASEDOCK-HARNESS DONE
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const UUID = GLib.getenv('BASEDOCK_UUID');
export const OUT = GLib.getenv('BASEDOCK_OUT');

export const wait = ms => new Promise(resolve =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));

export const once = (obj, signal) => new Promise(resolve => {
    const id = obj.connect(signal, () => {
        obj.disconnect(id);
        resolve();
    });
});

/**
 * Find the dock's container in chrome or, for a bottom dock in the overview,
 * inside the stock dash.
 */
export function dockContainer() {
    const find = group => group.get_children().find(a => a.name === 'basedock-container');
    return find(Main.layoutManager.uiGroup) ?? find(Main.overview.dash) ?? null;
}

/**
 * Place the unmaximized test window behind the dock's left end, with 40px of
 * overlap. The window makes the blur and translucency visible in captures.
 */
export async function placeTestWindowBehindDock() {
    const window = global.display.list_all_windows()
        .find(w => w.get_title() === 'basedock test window');
    if (!window)
        return;
    window.unmaximize();
    await wait(600);
    const {origin} = dockContainer().get_child()._background.get_transformed_extents();
    const rect = window.get_frame_rect();
    window.move_frame(true, Math.round(origin.x) - 84,
        Math.round(origin.y) + 40 - rect.height);
    // Long enough for dock item animations (e.g. the test window's
    // window-backed app being re-identified) to finish.
    await wait(1200);
}

export const report = line => console.log(`BASEDOCK-HARNESS ${line}`);

export function check(name, condition, detail = '') {
    if (condition)
        report(`PASS ${name}`);
    else
        report(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
}

export async function hideOverview() {
    if (!Main.overview.visible)
        return;
    const hidden = once(Main.overview, 'hidden');
    Main.overview.hide();
    await hidden;
}

/** Run `main` once the shell has started up; always report DONE. */
export function runAfterStartup(main) {
    const start = () => main()
        .catch(e => report(`FAIL harness crashed: ${e}\n${e.stack}`))
        .finally(() => report('DONE'));

    if (Main.layoutManager._startingUp)
        Main.layoutManager.connect('startup-complete', () => start());
    else
        start();
}

/**
 * Drive Shell input with a virtual pointer. Create it with await
 * VirtualPointer.create() and pass stage coordinates.
 */
export class VirtualPointer {
    static async create() {
        const pointer = new VirtualPointer();
        // Warm up the device at the screen center. The first absolute motions
        // on a headless Shell 51 session can report zero on one axis and
        // trigger a hot corner or another edge barrier.
        const {width, height} = global.stage;
        for (let i = 0; i < 2; i++)
            await pointer.moveTo(Math.round(width / 2), Math.round(height / 2));
        return pointer;
    }

    constructor() {
        const seat = global.stage.context.get_backend().get_default_seat();
        this._device = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    }

    async moveTo(x, y) {
        this._device.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        await wait(80);
    }

    async press() {
        this._device.notify_button(GLib.get_monotonic_time(),
            Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await wait(80);
    }

    async release() {
        this._device.notify_button(GLib.get_monotonic_time(),
            Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await wait(80);
    }
}
