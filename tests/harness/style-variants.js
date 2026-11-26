// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

// Capture the current style as 00-current and then each CSS variant in
// BASEDOCK_VARIANTS_DIR in name order.
//
// At equal specificity, St prefers the custom sheet loaded earliest
// (st-theme.c). Reload the main stylesheet after each variant so the variant's
// rules can override it.
//
// Use --window to capture translucency over the test window.
// BASEDOCK_VARIANTS_OVERVIEW=1 adds an overview shot for each style with a
// ~overview suffix. tests/style-variants.sh assembles the labeled comparison
// sheet.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {OUT, UUID, hideOverview, once, placeTestWindowBehindDock, report, runAfterStartup, wait, dockContainer} from './lib.js';

const VARIANTS_DIR = GLib.getenv('BASEDOCK_VARIANTS_DIR');
const IN_OVERVIEW = GLib.getenv('BASEDOCK_VARIANTS_OVERVIEW') === '1';
const MARGIN = 24;

function dockArea() {
    const container = dockContainer();
    const dash = container.get_child();
    const {origin, size} = dash._background.get_transformed_extents();
    const m = Main.layoutManager.primaryMonitor;
    const y = Math.max(Math.round(origin.y) - MARGIN, m.y);
    return {
        x: Math.max(Math.round(origin.x) - MARGIN, m.x),
        y,
        width: Math.round(size.width) + 2 * MARGIN,
        height: m.y + m.height - y,
    };
}

async function shootBoth(name) {
    await shoot(name);
    if (!IN_OVERVIEW)
        return;
    const shown = once(Main.overview, 'shown');
    Main.overview.show();
    await shown;
    await wait(500);
    await shoot(`${name}~overview`);
    await hideOverview();
    await wait(500);
}

async function shoot(name) {
    const {x, y, width, height} = dockArea();
    const file = Gio.File.new_for_path(`${OUT}/${name}.png`);
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot_area(x, y, width, height, stream);
    stream.close(null);
}

function listVariants() {
    const dir = Gio.File.new_for_path(VARIANTS_DIR);
    const names = [];
    const children = dir.enumerate_children('standard::name', 0, null);
    let info;
    while ((info = children.next_file(null))) {
        if (info.get_name().endsWith('.css'))
            names.push(info.get_name());
    }
    return names.sort().map(n => dir.get_child(n));
}

async function main() {
    await wait(1000);
    await hideOverview();
    await wait(1500);
    await placeTestWindowBehindDock();
    await shootBoth('00-current');

    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    const extensionSheet = Main.extensionManager.lookup(UUID).stylesheet;
    for (const file of listVariants()) {
        theme.unload_stylesheet(extensionSheet);
        theme.load_stylesheet(file);
        theme.load_stylesheet(extensionSheet);
        await wait(800);
        const name = file.get_basename().replace(/\.css$/, '');
        await shootBoth(name);
        theme.unload_stylesheet(file);
        await wait(300);
        report(`PASS shot ${name}`);
    }
}

runAfterStartup(main);
