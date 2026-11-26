// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

// Capture stage frames while dock and overview animations run at reduced
// speed. npm run capture builds contact sheets from the frames written to
// BASEDOCK_OUT.
//
// Scenarios, all with the maximized test window from test-window.js:
//   dock-hide      window maximizes → dock slides out
//   dock-show      window unmaximizes → dock slides in
//   exit-picker    window picker → desktop with a maximized window
//   exit-appgrid   app grid → desktop with a maximized window
//   enter-unmax    desktop with an unmaximized window → window picker: the
//                  dock must stay visible throughout (it moves into the
//                  overview, beneath the previews, once it's shown)
//   exit-unmax     window picker → desktop with an unmaximized window
//   preview-label  (single shot) the maximized window's preview hovered in
//                  the picker: its title label must draw over the dock
//   drag-icon      a dock icon dragged up (with its tile) and dropped on
//                  empty space, so it snaps back
//   resize-drag    drag the Trash divider up 16px in steps, then release:
//                  the dock resizes live and must not change on release
//   ws-switch      switch to the next (empty) workspace with the test
//                  window half behind the dock: the blur should follow
//                  the slide live
//   reorder        the first dock icon dragged between the third and fourth
//                  and dropped (slowed down): placeholder, sliding
//                  neighbors, landing
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {OUT, UUID, VirtualPointer, hideOverview, once, report, runAfterStartup, wait, dockContainer} from './lib.js';

const SLOWDOWN = Number(GLib.getenv('BASEDOCK_CAPTURE_SLOWDOWN') || '4');
const MAX_FRAMES = 60;

async function shot(name) {
    const file = Gio.File.new_for_path(`${OUT}/${name}.png`);
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
}

/**
 * Capture until `done` settles or MAX_FRAMES is reached, then take a final
 * screenshot after a short settling delay.
 */
async function capture(tag, action, done) {
    let finished = false;
    done.then(() => (finished = true));
    action();
    let i = 0;
    while (!finished && i < MAX_FRAMES)
        await shot(`${tag}-${String(i++).padStart(2, '0')}`);
    await wait(200);
    await shot(`${tag}-${String(i).padStart(2, '0')}-end`);
    report(`PASS captured ${tag} (${i + 1} frames)`);
}

/** Wait for the scaled 200ms slide duration plus a settling margin. */
const dockAnimation = () => wait(400 * SLOWDOWN);

async function dragIcon() {
    const dash = dockContainer().get_child();
    const appIcon = dash._box.get_children()
        .map(item => item.child?._delegate).find(d => d?.app);
    const [tx, ty] = appIcon.icon.get_transformed_position();
    const [tw, th] = appIcon.icon.get_transformed_size();
    const x = Math.round(tx + tw / 2), y = Math.round(ty + th / 2);

    const pointer = await VirtualPointer.create();
    await pointer.moveTo(x, y);
    await pointer.press();
    for (let i = 1; i <= 10; i++) {
        await pointer.moveTo(x + i * 6, y - i * 14);
        await shot(`drag-icon-${String(i).padStart(2, '0')}`);
    }
    await pointer.release();
    for (let i = 11; i <= 16; i++)
        await shot(`drag-icon-${String(i).padStart(2, '0')}`);
    report('PASS captured drag-icon');
}

async function reorder() {
    const dash = dockContainer().get_child();
    const items = dash._box.get_children().filter(i => i.child?._delegate?.app);
    const center = item => {
        const [x, y] = item.child._delegate.icon.get_transformed_position();
        const [w, h] = item.child._delegate.icon.get_transformed_size();
        return [Math.round(x + w / 2), Math.round(y + h / 2)];
    };
    const [sx, sy] = center(items[0]);
    const dropX = Math.round((center(items[2])[0] + center(items[3])[0]) / 2);

    const pointer = await VirtualPointer.create();
    await pointer.moveTo(sx, sy);
    await pointer.press();
    await pointer.moveTo(sx, sy - 40);
    let n = 0;
    const frame = () => shot(`reorder-${String(n++).padStart(2, '0')}`);
    for (let i = 1; i <= 8; i++) {
        await pointer.moveTo(Math.round(sx + (dropX - sx) * i / 8), sy - 10);
        await frame();
    }
    for (let i = 0; i < 4; i++)
        await frame();
    await pointer.release();
    for (let i = 0; i < 14; i++)
        await frame();
    report(`PASS captured reorder (${n} frames)`);
}

async function resizeDrag() {
    const dash = dockContainer().get_child();
    const handle = dash._trashHandle.actor;
    const [hx, hy] = handle.get_transformed_position();
    const x = Math.round(hx + handle.width / 2), y = Math.round(hy + handle.height / 2);
    const pointer = await VirtualPointer.create();
    await pointer.moveTo(x, y);
    await pointer.press();
    let n = 0;
    const frame = () => shot(`resize-drag-${String(n++).padStart(2, '0')}`);
    for (let i = 1; i <= 8; i++) {
        await pointer.moveTo(x, y - i * 2);
        await frame();
    }
    await pointer.release();
    for (let i = 0; i < 4; i++)
        await frame();
    report(`PASS captured resize-drag (${n} frames)`);
    Main.extensionManager.lookup(UUID).stateObj.getSettings().set_int('icon-size', 48);
    await wait(1000);
}

async function workspaceSwitch(window) {
    const dash = dockContainer().get_child();
    const [, by] = dash._background.get_transformed_position();
    const rect = window.get_frame_rect();
    // Left part of the dock, the window's bottom 40 px behind it.
    window.move_frame(true, 300, Math.round(by) + 40 - rect.height);
    await wait(1200);

    St.Settings.get().slow_down_factor = SLOWDOWN;
    const ws = global.workspace_manager;
    const next = ws.get_workspace_by_index(ws.get_active_workspace_index() + 1);
    let i = 0;
    const done = wait(250 * SLOWDOWN + 300);
    let finished = false;
    done.then(() => (finished = true));
    next.activate(global.get_current_time());
    while (!finished && i < MAX_FRAMES)
        await shot(`ws-switch-${String(i++).padStart(2, '0')}`);
    St.Settings.get().slow_down_factor = 1;
    report(`PASS captured ws-switch (${i} frames)`);

    ws.get_workspace_by_index(0).activate(global.get_current_time());
    await wait(1000);
}

async function main() {
    await wait(1000);
    await hideOverview();
    await wait(2000); // let the test window map
    const window = global.display.list_all_windows()
        .find(w => w.get_title() === 'basedock test window');
    if (!window)
        throw new Error('test window missing; run with --window');

    window.unmaximize();
    await wait(1000);
    await shot('00-desktop-unmaximized');

    await resizeDrag();
    await workspaceSwitch(window);

    await dragIcon();
    await wait(1000);

    St.Settings.get().slow_down_factor = SLOWDOWN;
    await reorder();
    St.Settings.get().slow_down_factor = 1;
    await wait(1000);

    St.Settings.get().slow_down_factor = SLOWDOWN;

    await capture('dock-hide', () => window.maximize(), dockAnimation());
    await capture('dock-show', () => window.unmaximize(), dockAnimation());

    window.maximize();
    await wait(400 * SLOWDOWN);

    let shown = once(Main.overview, 'shown');
    Main.overview.show();
    await shown;
    await capture('exit-picker', () => Main.overview.hide(),
        once(Main.overview, 'hidden'));

    shown = once(Main.overview, 'shown');
    Main.overview.showApps();
    await shown;
    await wait(300 * SLOWDOWN); // app grid finishes after 'shown'
    await capture('exit-appgrid', () => Main.overview.hide(),
        once(Main.overview, 'hidden'));

    window.unmaximize();
    await wait(400 * SLOWDOWN);
    await capture('enter-unmax', () => Main.overview.show(),
        once(Main.overview, 'shown'));
    await capture('exit-unmax', () => Main.overview.hide(),
        once(Main.overview, 'hidden'));
    St.Settings.get().slow_down_factor = 1;

    window.maximize();
    await wait(1000);
    shown = once(Main.overview, 'shown');
    Main.overview.show();
    await shown;
    await wait(500);
    // Hover the window preview: its label sits at the preview's bottom.
    const pointer = await VirtualPointer.create();
    const m = Main.layoutManager.primaryMonitor;
    await pointer.moveTo(m.x + Math.round(m.width / 2), m.y + Math.round(m.height / 2));
    await wait(800);
    await shot('preview-label');
    report('PASS captured preview-label');
    await hideOverview();
}

runAfterStartup(main);
