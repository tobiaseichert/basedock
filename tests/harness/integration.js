// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

// Run these integration checks with npm test. The harness drives Shell from
// inside the private headless session and uses the maximized GTK window from
// test-window.js.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import {Dock, END_MARGIN} from '../dock.js';
import {dockSizeAt, geometryAt, showAppsSymbolMargin} from '../geometry.js';
import {MinimizeTarget} from '../minimizeTarget.js';
import {OverviewSideRoom} from '../overviewRoom.js';
import {StockDashTakeover} from '../stockDash.js';
import {UUID, VirtualPointer, check, hideOverview, once, report, runAfterStartup, wait, dockContainer} from './lib.js';

const TEST_WINDOW_TITLE = 'basedock test window';

const stockDash = () => Main.overview.dash;
const ourDash = () => dockContainer()?.get_child() ?? null;
const extensionState = () => Main.extensionManager.lookup(UUID)?.state;

// Longer than the dock's 200 ms slide and the shell's window animations.
const settle = () => wait(700);

/**
 * Reuse one virtual pointer. Creating another input device makes Shell
 * re-identify the test window's app, which has no desktop file. Replacing its
 * dock item shifts the neighboring items.
 */
let pointerPromise = null;
const sharedPointer = () => (pointerPromise ??= VirtualPointer.create());

let keyboard = null;

/**
 * Send Super+Left or Super+Right with a virtual keyboard because Mutter
 * exposes no half-screen tiling API. Repeated presses in the opposite
 * direction tile from the center to the other half, then restore the window.
 */
async function superArrow(window, direction) {
    window.activate(global.get_current_time());
    await wait(200);
    keyboard ??= global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const arrow = direction === 'left' ? Clutter.KEY_Left : Clutter.KEY_Right;
    for (const [keyval, state] of [
        [Clutter.KEY_Super_L, Clutter.KeyState.PRESSED],
        [arrow, Clutter.KeyState.PRESSED],
        [arrow, Clutter.KeyState.RELEASED],
        [Clutter.KEY_Super_L, Clutter.KeyState.RELEASED],
    ])
        keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, state);
    await settle();
}

async function testWindow() {
    for (let i = 0; i < 50; i++) {
        const window = global.display.list_all_windows()
            .find(w => w.get_title() === TEST_WINDOW_TITLE);
        if (window)
            return window;
        await wait(100);
    }
    throw new Error('test window did not appear');
}

function dockState() {
    const dash = ourDash();
    if (!dash)
        return 'absent';
    if (!dash.visible)
        return 'hidden';
    if (dash.translation_x === 0 && dash.translation_y === 0 && dash.opacity === 255)
        return 'shown';
    return `animating (translation=${dash.translation_x},${dash.translation_y} opacity=${dash.opacity})`;
}

/**
 * Check dock visibility in the specified overview state. The overview forces
 * the dock visible and would mask desktop visibility failures.
 */
function checkDock(name, expected, {inOverview = false} = {}) {
    const state = dockState();
    check(`${name}: dock ${expected}`,
        state === expected && Main.overview.visible === inOverview,
        `dock is ${state}, overview ${Main.overview.visible ? 'open' : 'closed'}`);
}

async function clickShowApps(expect) {
    ourDash().showAppsButton.emit('clicked', 1);
    await settle();
    const appGrid = stockDash().showAppsButton.checked;
    const state = `overview=${Main.overview.visible} appGrid=${appGrid} ` +
        `ourChecked=${ourDash().showAppsButton.checked}`;
    check(`show apps: ${expect.name}`,
        Main.overview.visible === expect.overview &&
        appGrid === expect.appGrid &&
        ourDash().showAppsButton.checked === expect.appGrid,
        state);
}

/** The visible dock background: top edge and horizontal extent. */
function dockEdge() {
    const {origin, size} = ourDash()._background.get_transformed_extents();
    return {
        y: Math.round(origin.y),
        x1: Math.round(origin.x),
        x2: Math.round(origin.x + size.width),
    };
}

const frameBottom = window => {
    const r = window.get_frame_rect();
    return r.y + r.height;
};

/**
 * Start a Mutter grab at (pressX, pressY), then move a virtual pointer so the
 * window's bottom would reach each target stage y. Call onStep(target) after
 * each move, with the grab still held. Return the grab operation Mutter
 * reported.
 *
 * Use begin_grab_op() because GTK's drag detection ignores the virtual device
 * in this headless session. The remaining movement goes through Mutter's
 * normal grab handling.
 */
async function dragBottomTo(window, op, pressX, pressY, targets, onStep) {
    const pointer = await sharedPointer();
    const startBottom = frameBottom(window);

    let grabOp = null;
    const id = global.display.connect('grab-op-begin', (_d, w, o) => {
        if (w === window)
            grabOp = o;
    });

    try {
        await pointer.moveTo(pressX, pressY);
        await pointer.press();
        const backend = global.stage.context.get_backend();
        window.begin_grab_op(op,
            backend.get_pointer_sprite(global.stage), global.get_current_time(),
            new Graphene.Point({x: pressX, y: pressY}));
        await wait(200);
        for (const target of targets) {
            await pointer.moveTo(pressX, pressY + (target - startBottom));
            await wait(200);
            onStep(target);
        }
    } finally {
        await pointer.release();
        global.display.disconnect(id);
    }
    return grabOp;
}

/** Put `window` horizontally over the dock (or at x=0), bottom at `bottom`. */
async function placeWindow(window, bottom, {overDock = true} = {}) {
    const edge = dockEdge();
    const rect = window.get_frame_rect();
    const x = overDock ? Math.round((edge.x1 + edge.x2 - rect.width) / 2) : 0;
    window.move_frame(true, x, bottom - rect.height);
    await settle();
}

// What mutter keeps reachable at monitor edges, and the dock at its edge
// (src/dockEdge.ts): a quarter of the window's size, 10 to 75 px.
const reachable = size => Math.min(Math.max(Math.floor(size / 4), 10), 75);

async function testEdgeResistance(window) {
    const edge = dockEdge();
    await placeWindow(window, edge.y - 120);

    // Move by the title bar: bottom offsets relative to the dock's top.
    const rect = window.get_frame_rect();
    const pressX = rect.x + Math.round(rect.width / 2);
    const steps = {};
    let i = 0;
    const grabOp = await dragBottomTo(window, Meta.GrabOp.MOVING,
        pressX, rect.y + 12,
        [-40, 10, 25, 60, 10].map(o => edge.y + o),
        target => (steps[`${i++}:${target - edge.y}`] = frameBottom(window) - edge.y));
    await settle();

    const detail = JSON.stringify(steps);
    check('edge resistance: the drag runs as a mutter move grab',
        grabOp === Meta.GrabOp.MOVING, `grabOp=${grabOp}`);
    check('edge resistance: free movement above the dock', steps['0:-40'] === -40, detail);
    check('edge resistance: held at the dock edge 10 px past it', steps['1:10'] === 0, detail);
    check('edge resistance: still held 25 px past it', steps['2:25'] === 0, detail);
    check('edge resistance: passes behind the dock beyond 32 px', steps['3:60'] === 60, detail);
    check('edge resistance: no resistance moving back up from below', steps['4:10'] === 10, detail);

    // Dragged on, fully behind the dock: stops with its top still above it,
    // where the titlebar can be grabbed again.
    await placeWindow(window, edge.y - 120);
    let r = window.get_frame_rect();
    let top;
    await dragBottomTo(window, Meta.GrabOp.MOVING, pressX, r.y + 12,
        [edge.y + r.height + 40], () => (top = window.get_frame_rect().y));
    await settle();
    const expected = edge.y - reachable(r.height);
    check('titlebar: a window dragged behind the dock keeps its top reachable above it',
        top === expected && window.get_frame_rect().y === expected,
        `top=${top} after=${window.get_frame_rect().y} expected=${expected}`);

    // A window that doesn't overlap the dock horizontally isn't affected.
    if (rect.width < edge.x1 - 10) {
        await placeWindow(window, edge.y - 120, {overDock: false});
        r = window.get_frame_rect();
        let beside;
        await dragBottomTo(window, Meta.GrabOp.MOVING,
            r.x + Math.round(r.width / 2), r.y + 12, [edge.y + 10],
            () => (beside = frameBottom(window) - edge.y));
        await settle();
        check('edge resistance: none beside the dock', beside === 10,
            `bottom offset=${beside}`);
        let besideTop;
        await dragBottomTo(window, Meta.GrabOp.MOVING,
            r.x + Math.round(r.width / 2), window.get_frame_rect().y + 12, [edge.y + r.height],
            () => (besideTop = window.get_frame_rect().y));
        await settle();
        check('titlebar: beside the dock, a window goes as low as mutter lets it',
            besideTop > edge.y - reachable(r.height), `top=${besideTop} dock top=${edge.y}`);
    } else {
        report(`FAIL edge resistance: test window too wide (${rect.width}) for the beside-the-dock case`);
    }
}

async function testResizeStop(window) {
    const edge = dockEdge();
    const limit = edge.y;

    // Drag the bottom border: bottom positions relative to the dock's top.
    const resize = async (overDock, startBottom, targetsFromLimit) => {
        await placeWindow(window, startBottom, {overDock});
        const r = window.get_frame_rect();
        const result = [];
        const grabOp = await dragBottomTo(window, Meta.GrabOp.RESIZING_S,
            r.x + Math.round(r.width / 2), r.y + r.height - 2,
            targetsFromLimit.map(o => limit + o),
            () => result.push(frameBottom(window) - limit));
        await settle();
        return {grabOp, result, final: frameBottom(window) - limit};
    };

    const over = await resize(true, limit - 100, [-30, 20, 60]);
    const detail = JSON.stringify(over);
    check('resize stop: the drag runs as a mutter resize grab',
        over.grabOp === Meta.GrabOp.RESIZING_S, `grabOp=${over.grabOp}`);
    check('resize stop: free resizing above the dock', over.result[0] === -30, detail);
    check('resize stop: stops at the dock edge when dragged onto it',
        over.result[1] === 0, detail);
    check('resize stop: stays stopped when dragged further', over.result[2] === 0, detail);
    check('resize stop: the committed size respects it', over.final === 0, detail);

    if (window.get_frame_rect().width < edge.x1 - 10) {
        const beside = await resize(false, limit - 100, [40]);
        check('resize stop: none beside the dock', beside.result[0] === 40,
            JSON.stringify(beside));
    } else {
        report('FAIL resize stop: test window too wide for the beside-the-dock case');
    }

    // Moved flush against the dock (where move resistance leaves it), then
    // resized: stays at the edge.
    const flush = await resize(true, limit, [40]);
    check('resize stop: a window flush with the dock stays at the edge',
        flush.result[0] === 0, JSON.stringify(flush));

    const behind = await resize(true, limit + 10, [40]);
    check('resize stop: none for a window already reaching behind the dock',
        behind.result[0] === 40, JSON.stringify(behind));

    // The constraint is gone after the grab: maximizing fills the screen.
    window.maximize();
    await settle();
    const m = Main.layoutManager.primaryMonitor;
    check('resize stop: maximized window still reaches the screen bottom',
        frameBottom(window) === m.y + m.height,
        `bottom=${frameBottom(window)} monitor bottom=${m.y + m.height}`);
    window.unmaximize();
    await settle();
}

/** The first app tile on the dock (the stock .overview-icon of an AppIcon). */
function firstAppTile() {
    const appIcon = ourDash()._box.get_children()
        .map(item => item.child?._delegate)
        .find(d => d?.app);
    return appIcon?.icon ?? null;
}

const appItemCount = () => ourDash()._box.get_children()
    .filter(item => item.child?._delegate?.app).length;

async function testDragImage() {
    const tile = firstAppTile();
    const [tx, ty] = tile.get_transformed_position();
    const [tw, th] = tile.get_transformed_size();
    const items = appItemCount();

    const pointer = await sharedPointer();
    const x = Math.round(tx + tw / 2), y = Math.round(ty + th / 2);
    // Recorded during the drag: the image is destroyed after the drop.
    let seen = null;
    try {
        await pointer.moveTo(x, y);
        await pointer.press();
        // Past the drag threshold, then up and away from the dock.
        for (let i = 1; i <= 12; i++) {
            await pointer.moveTo(x, y - i * 12);
            const image = Main.uiGroup.get_children()
                .find(a => a.has_style_class_name?.('basedock-drag-tile'));
            if (image && !seen) {
                seen = {
                    hasIcon: image.get_child() instanceof St.Icon,
                    width: Math.round(image.width),
                    height: Math.round(image.height),
                };
            }
        }
    } finally {
        // Dropping on empty space cancels: the image snaps back.
        await pointer.release();
    }
    await wait(1000);

    check('drag image: a dock icon drags with its tile', seen !== null);
    if (seen) {
        check('drag image: the icon sits inside the tile',
            seen.hasIcon, JSON.stringify(seen));
        check('drag image: same size as the on-dock tile',
            seen.width === Math.round(tw) && seen.height === Math.round(th),
            `image=${seen.width}x${seen.height} tile=${tw}x${th}`);
    }
    check('drag image: cancelled drop leaves the dock unchanged',
        appItemCount() === items, `items before=${items} after=${appItemCount()}`);
    check('drag image: removed after the drop',
        !Main.uiGroup.get_children().some(a => a.has_style_class_name?.('basedock-drag-tile')));
}

// Dock app items, excluding ones still shrinking away after a change.
const appItems = () => ourDash()._box.get_children()
    .filter(item => item.child?._delegate?.app && !item.animatingOut);

/**
 * Drag the first icon between the third and fourth. Verify the placeholder,
 * the neighbors' slide and the drop animation using Shell's drag handling.
 */
async function testReorder() {
    const favorites = AppFavorites.getAppFavorites();
    const before = favorites.getFavorites().map(a => a.get_id());
    const items = appItems();
    if (items.length < 4) {
        report(`FAIL reorder: need 4 dock items, have ${items.length}`);
        return;
    }

    const tileCenter = item => {
        const [x, y] = item.child._delegate.icon.get_transformed_position();
        const [w, h] = item.child._delegate.icon.get_transformed_size();
        return [Math.round(x + w / 2), Math.round(y + h / 2)];
    };
    const [sx, sy] = tileCenter(items[0]);
    // Aim at the left quarter of the fourth icon: the stock dash maps x to
    // a slot by proportion (floor(x * n / width)), so slot boundaries sit
    // near the gaps between icons and a drop right on a gap is ambiguous.
    const [x3] = tileCenter(items[2]);
    const [x4] = tileCenter(items[3]);
    const dropX = Math.round(x4 - (x4 - x3) / 4);

    const pointer = await sharedPointer();
    await pointer.moveTo(sx, sy);
    await pointer.press();
    await pointer.moveTo(sx, sy - 40); // start the drag
    for (let i = 1; i <= 8; i++)
        await pointer.moveTo(Math.round(sx + (dropX - sx) * i / 8), sy - 10);
    await wait(300);
    await pointer.release();
    await wait(1200);

    const after = favorites.getFavorites().map(a => a.get_id());
    const expected = [before[1], before[2], before[0], ...before.slice(3)];
    check('reorder: dropped icon lands between the third and fourth',
        JSON.stringify(after) === JSON.stringify(expected),
        `before=${before.slice(0, 4)} after=${after.slice(0, 4)}`);
    check('reorder: drop image and placeholder are gone',
        !Main.uiGroup.get_children().some(a =>
            a.get_children?.().some(c => c.has_style_class_name?.('basedock-drag-tile'))) &&
        ourDash()._box.get_children().every(c =>
            c.child?._delegate?.app || c === ourDash()._separator ||
            c === ourDash()._showAppsIcon));
    check('reorder: every icon visible and at rest',
        appItems().every(item => item.child.opacity === 255 &&
            item.translation_x === 0 && item.scale_x === 1),
        JSON.stringify(appItems().map(i => [i.child.opacity, i.translation_x, i.scale_x])));

    check('reorder: overview state is not left overridden',
        !Object.hasOwn(Main.overview, 'visible') &&
        !Object.hasOwn(Main.overview, 'animationInProgress') &&
        Main.overview.visible === false);

    // Restore the order for the rest of the run.
    favorites.moveFavoriteToPos(before[0], 0);
    await settle();
}

/**
 * Drag a favorite away and back to its original slot. The drop stays accepted,
 * leaves the order unchanged and animates back to the existing item.
 */
async function testDragBackToOwnSlot() {
    const dash = ourDash();
    const favorites = AppFavorites.getAppFavorites();
    const before = favorites.getFavorites().map(a => a.get_id());
    const items = appItems();
    const center = item => {
        const [x, y] = item.child._delegate.icon.get_transformed_position();
        const [w, h] = item.child._delegate.icon.get_transformed_size();
        return [Math.round(x + w / 2), Math.round(y + h / 2)];
    };
    const [sx, sy] = center(items[1]);
    const [x3] = center(items[3]);

    const results = [];
    const handleDragOver = dash.handleDragOver.bind(dash);
    dash.handleDragOver = (...args) => {
        const result = handleDragOver(...args);
        results.push(result);
        return result;
    };
    const pointer = await sharedPointer();
    await pointer.moveTo(sx, sy);
    await pointer.press();
    await pointer.moveTo(sx, sy - 40); // start the drag
    await pointer.moveTo(x3, sy - 10);
    await wait(300);
    for (let i = 1; i <= 3; i++)
        await pointer.moveTo(Math.round(x3 + (sx - x3) * i / 4), sy - 10);
    // Record feedback as the pointer returns while the old placeholder is
    // still shrinking away.
    const back = results.length;
    await pointer.moveTo(sx, sy - 10);
    await pointer.moveTo(sx + 2, sy - 10);
    await wait(300);
    await pointer.moveTo(sx - 2, sy - 10);
    const overOwnSlot = results.slice(back);
    await pointer.release();
    await wait(1200);
    delete dash.handleDragOver;

    check('drag back: over its own slot the drop is allowed (no "not allowed" pointer)',
        overOwnSlot.length > 0 && overOwnSlot.every(r => r === DND.DragMotionResult.MOVE_DROP),
        `results over own slot: ${overOwnSlot}`);
    check('drag back: dropping on its own slot changes nothing',
        JSON.stringify(favorites.getFavorites().map(a => a.get_id())) === JSON.stringify(before));
    check('drag back: the icon is back, visible and at rest, the drag image gone',
        appItems().every(item => item.child.opacity === 255 &&
            item.translation_x === 0 && item.scale_x === 1) &&
        !Main.uiGroup.get_children().some(a =>
            a.get_children?.().some(c => c.has_style_class_name?.('basedock-drag-tile'))),
        JSON.stringify(appItems().map(i => [i.child.opacity, i.translation_x, i.scale_x])));
}

/**
 * Moving A one step right in [A, B, C] makes stock redisplay reuse A and
 * recreate B. Verify that the drop animation targets the reused item promptly.
 */
async function testOneStepRight() {
    const favorites = AppFavorites.getAppFavorites();
    const before = favorites.getFavorites().map(a => a.get_id());
    const items = appItems();
    const center = item => {
        const [x, y] = item.child._delegate.icon.get_transformed_position();
        const [w, h] = item.child._delegate.icon.get_transformed_size();
        return [Math.round(x + w / 2), Math.round(y + h / 2)];
    };
    const [sx, sy] = center(items[0]);
    // Left quarter of the third icon (see testReorder on slot boundaries).
    const [x2] = center(items[1]);
    const [x3] = center(items[2]);
    const dropX = Math.round(x3 - (x3 - x2) / 4);

    const pointer = await sharedPointer();
    await pointer.moveTo(sx, sy);
    await pointer.press();
    await pointer.moveTo(sx, sy - 40);
    for (let i = 1; i <= 6; i++)
        await pointer.moveTo(Math.round(sx + (dropX - sx) * i / 6), sy - 10);
    await wait(250);
    const placeholderPos = ourDash()._dragPlaceholderPos;
    const t0 = GLib.get_monotonic_time();
    await pointer.release();
    const landing = () => Main.uiGroup.get_children().some(a =>
        a.get_children?.().some(c => c.has_style_class_name?.('basedock-drag-tile')));
    let ms = 0;
    while (landing() && ms < 3000) {
        await wait(20);
        ms = (GLib.get_monotonic_time() - t0) / 1000;
    }
    await wait(400);

    const after = favorites.getFavorites().map(a => a.get_id());
    check('reorder one step right: new order',
        after[0] === before[1] && after[1] === before[0],
        `before=${before.slice(0, 3)} after=${after.slice(0, 3)} ` +
        `placeholderPos=${placeholderPos} drop=${dropX},${sy - 10} from=${sx},${sy}`);
    check('reorder one step right: lands promptly (no stuck icon)',
        ms < 400, `image gone after ${Math.round(ms)} ms`);
    check('reorder one step right: every icon visible and at rest',
        appItems().filter(i => !i.animatingOut).every(item => item.child.opacity === 255 &&
            item.translation_x === 0 && item.scale_x === 1));

    favorites.moveFavoriteToPos(before[0], 0);
    await settle();
}

const runningMarked = () => ourDash()._box.get_children()
    .filter(c => c.child?.has_style_class_name?.('basedock-running'))
    .map(c => c.child._delegate.app.get_id());

/** Wait up to `ms` for `condition()`, checking every `step` ms. */
async function waitFor(condition, ms, step = 100) {
    for (let t = 0; t < ms && !condition(); t += step)
        await wait(step);
    return condition();
}

/**
 * Check that the test window's running app has the basedock-running class.
 * Pinned apps without running windows keep their ordinary tiles.
 */
function testRunningMarks(window) {
    const windowApp = Shell.WindowTracker.get_default().get_window_app(window);
    const marked = runningMarked();
    check('running apps: the running test window app is marked',
        marked.includes(windowApp?.get_id()), `marked=${marked}`);
    check('running apps: pinned apps that are not running are not marked',
        appItems().every(i => i.child._delegate.app.state !== Shell.AppState.STOPPED ||
            !i.child.has_style_class_name('basedock-running')),
        `marked=${marked}`);
}

async function showOverview() {
    const shown = once(Main.overview, 'shown');
    Main.overview.show();
    await shown;
    await settle();
}

async function activateWorkspace(index) {
    global.workspace_manager.get_workspace_by_index(index)
        .activate(global.get_current_time());
    await settle();
}

function checkEnabledLayout(when) {
    const container = dockContainer();
    const dash = ourDash();
    const stock = stockDash();
    const m = Main.layoutManager.primaryMonitor;

    check(`${when}: extension ACTIVE`,
        extensionState() === ExtensionState.ACTIVE, `state=${extensionState()}`);
    check(`${when}: dock is centered at the bottom of the primary monitor`, (() => {
        const [x, y] = container.get_transformed_position();
        return Math.round(y + container.height) === m.y + m.height &&
            Math.round(x) === m.x && container.width === m.width;
    })());
    check(`${when}: no struts (work area reaches the bottom edge)`, (() => {
        const wa = Main.layoutManager.getWorkAreaForMonitor(m.index);
        return wa.y + wa.height === m.y + m.height;
    })());
    check(`${when}: icon size is 48`, dash?.iconSize === 48, `iconSize=${dash?.iconSize}`);
    check(`${when}: stock dash's own contents hidden`,
        !stock._background.visible && !stock._dashContainer.visible);
    check(`${when}: stock dash out of Ctrl+Alt+Tab, the dock in it`,
        !Main.ctrlAltTabManager._items.some(item => item.root === stock) &&
        Main.ctrlAltTabManager._items.some(item => item.root === dash));
    check(`${when}: stock dash is a spacer as tall as the dock can get (112px)`,
        container.height > 0 && stock.height === 112 && container.height <= stock.height,
        `stock=${stock.height} dock=${container.height}`);
    const row = dash._dashContainer.get_children();
    const isHandle = a => a?.has_style_class_name?.('basedock-handle') &&
        a.get_child()?.has_style_class_name('dash-separator');
    check(`${when}: Show Apps, handle, apps, handle, Trash`,
        row.length === 5 &&
        row[0] === dash._showAppsIcon && isHandle(row[1]) &&
        row[2] === dash._box && isHandle(row[3]) &&
        row[4] === dash._trashIcon,
        row.map(a => a.constructor.name).join(','));
    const symbol = dash._showAppsIcon._iconActor?.gicon;
    check(`${when}: Show Apps shows the bundled grid symbol`,
        symbol?.get_file?.()?.get_path()?.endsWith(`/${UUID}/icons/show-apps-symbolic.svg`),
        `${symbol?.get_file?.()?.get_path() ?? symbol}`);
    check(`${when}: stock dash reports our icon size`,
        stock.iconSize === dash.iconSize,
        `stock=${stock.iconSize} ours=${dash.iconSize}`);
}

/**
 * Check that Show Apps takes one tile's footprint and that its symbol is 7/9
 * of an app icon. Show the dock first so Shell allocates its actors.
 */
function checkShowAppsSlot() {
    const dash = ourDash();
    const appSlot = dash._box.get_children().find(c => c.child?._delegate?.app);
    const symbol = dash._showAppsIcon.icon;
    const tile = appSlot?.child._delegate.icon;
    check('Show Apps symbol takes a tile\'s footprint (no tile, same size)',
        tile && Math.round(symbol.width) === Math.round(tile.width) &&
        Math.round(symbol.height) === Math.round(tile.height),
        `symbol=${symbol.width}x${symbol.height} tile=${tile?.width}x${tile?.height}`);
    check('Show Apps symbol: 42px beside 54px app icons at the default size',
        dash.iconSize === 48 && symbol.icon?.icon_size === 42 &&
        tile?.icon?.icon_size === 54,
        `symbol=${symbol.icon?.icon_size} app icon=${tile?.icon?.icon_size} iconSize=${dash.iconSize}`);
}

/**
 * Check that every divider sits the same distance from the drawn icons on both
 * sides. Measure Show Apps from the SVG dots, excluding the transparent
 * margin. At the default size the gap is 19px along either orientation.
 */
function checkDividersCentered(when) {
    const dash = ourDash();
    const vertical = dash.has_style_class_name('basedock-vertical');
    const span = actor => {
        const {origin, size} = actor.get_transformed_extents();
        return vertical
            ? [origin.y, origin.y + size.height]
            : [origin.x, origin.x + size.width];
    };
    const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
    const margin = showAppsSymbolMargin(dash.iconSize) * scaleFactor;
    const [symbolStart, symbolEnd] = span(dash._showAppsIcon.icon.icon);
    const icons = [[symbolStart + margin, symbolEnd - margin],
        ...[...appItems().map(i => i.child.icon.icon), dash._trashIcon.icon.icon].map(span)];
    const lines = [dash._showAppsHandle, dash._separatorHandle, dash._trashHandle]
        .filter(h => h?.actor.visible).map(h => span(h.line));
    const gaps = lines.map(([start, end]) => {
        const before = Math.max(...icons.filter(i => i[1] <= start).map(i => i[1]));
        const after = Math.min(...icons.filter(i => i[0] >= end).map(i => i[0]));
        return [Math.round(start - before), Math.round(after - end)];
    });
    const expected = dash.iconSize === 48 ? 19 : gaps[0]?.[0];
    check(`${when}: dividers centered between their icons, all as far from them`,
        gaps.length >= 2 && gaps.flat().every(gap => gap === expected),
        `divider gaps=${gaps.map(g => g.join('|')).join(', ')} iconSize=${dash.iconSize}`);
}

/**
 * Check that the blur and background bounds match. A blur allocation one
 * layout behind the background leaves a visible fringe.
 */
function checkBlurOverBackground(when) {
    const dash = ourDash();
    const layer = dash.get_children().find(a => a.name === 'basedock-blur');
    const box = actor => {
        const {origin, size} = actor.get_transformed_extents();
        return rectString({
            x: Math.round(origin.x), y: Math.round(origin.y),
            width: Math.round(size.width), height: Math.round(size.height),
        });
    };
    check(`${when}: the blur covers exactly the dock background`,
        layer && box(layer) === box(dash._background),
        `blur=${layer && box(layer)} background=${box(dash._background)}`);
}

/**
 * Check the background and tile radii at the default icon size.
 */
function checkCorners() {
    const dash = ourDash();
    const background = dash._background.get_theme_node();
    const tile = firstAppTile()?.get_theme_node();
    const radius = background.get_border_radius(St.Corner.TOPLEFT);
    const tileRadius = tile?.get_border_radius(St.Corner.TOPLEFT);
    check('dock corners 16px, tile corners 10px, at the default size',
        dash.iconSize === 48 && radius === 16 && tileRadius === 10,
        `background=${radius} tile=${tileRadius} iconSize=${dash.iconSize}`);
}

/**
 * Check the reference spacing of 16px between drawn icons and 15px from the
 * background's inner edge.
 */
function checkIconSpacing() {
    const dash = ourDash();
    const box = actor => {
        const {origin, size} = actor.get_transformed_extents();
        return {start: origin.x, end: origin.x + size.width, across: origin.y};
    };
    // Neighbors in the apps box, not across the divider between favorites
    // and other running apps.
    const children = dash._box.get_children();
    const icons = appItems().map(i => box(i.child.icon.icon));
    const gaps = appItems().slice(1)
        .map((item, i) => [item, i])
        .filter(([item, i]) => children.indexOf(item) === children.indexOf(appItems()[i]) + 1)
        .map(([, i]) => Math.round(icons[i + 1].start - icons[i].end));
    const bg = box(dash._background);
    const node = dash._background.get_theme_node();
    const inner = bg.across + node.get_border_width(St.Side.TOP);
    const inset = Math.round(icons[0].across - inner);
    check('layout: icons 16px apart, 15px inside the background',
        gaps.length > 0 && gaps.every(g => g === 16) && inset === 15,
        `gaps=${gaps} inset=${inset}`);
}

/** Running apps' tiles: a quieter highlight than hover's (stylesheet.css). */
function checkRunningTile() {
    const appIcon = appItems().map(i => i.child)
        .find(c => c.has_style_class_name('basedock-running') && !c.hover);
    const [, start, end] = appIcon?.icon.get_theme_node().get_background_gradient() ?? [];
    check('running tile: white at about 24%',
        start?.alpha === Math.round(0.29 * 255) && end?.alpha === Math.round(0.19 * 255),
        `start=${start?.alpha} end=${end?.alpha}`);
}

function windowDots(indicator) {
    return indicator?.get_children().map(slot => slot.get_first_child()) ?? [];
}

/** The running indicator reserves a 4px gap between its slots and the tile. */
function checkRunningDot() {
    const appIcon = appItems().map(i => i.child).find(c => c._dot.visible);
    if (!appIcon) {
        report('FAIL running dot: no running app in the dock');
        return;
    }
    const [, tileY] = appIcon.icon.get_transformed_position();
    const [, dotY] = appIcon._dot.get_transformed_position();
    const gap = Math.round(dotY - tileY - appIcon.icon.height);
    const color = windowDots(appIcon._dot)[0]?.get_theme_node().get_background_color();
    const expected = appIcon.app.get_windows().includes(global.display.focus_window) ? 255 : 166;
    check('running dot: neutral color and 4px below the tile',
        gap === 4 && color?.red === expected && color.green === expected && color.blue === expected,
        `gap=${gap} color=${color?.to_string()}`);
}

function callTestApp(iface, method, parameters) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call('org.basedock.TestWindow', '/org/basedock/TestWindow',
            iface, method, parameters, null,
            Gio.DBusCallFlags.NO_AUTO_START, 5000, null, (connection, result) => {
                try {
                    connection.call_finish(result);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
    });
}

async function openTestAppWindow(title) {
    // Activate the existing GTK fixture on the private session bus to open
    // another window belonging to the same application.
    await callTestApp('org.gtk.Application', 'Activate', new GLib.Variant('(a{sv})', [{}]));
    return waitFor(() => global.display.list_all_windows()
        .find(window => window.get_title() === title), 5000);
}

async function testWindowIndicator(window) {
    const tracker = Shell.WindowTracker.get_default();
    const dot = () => appItems().find(item => item.child?.app === tracker.get_window_app(window))?.child._dot;
    const secondWindow = () => global.display.list_all_windows()
        .find(w => w.get_title() === 'basedock second test window');
    const isDot = () => dot()?.visible && windowDots(dot()).length === 1;
    check('window indicator: a single window has a dot', isDot());

    const second = await openTestAppWindow('basedock second test window');
    try {
        const grouped = second && await waitFor(() =>
            tracker.get_window_app(window) === tracker.get_window_app(second), 5000);
        check('window indicator: both windows belong to the same app', grouped);
        if (!grouped)
            return;
        check('window indicator: opening a second window adds a dot',
            await waitFor(() => windowDots(dot()).length === 2, 5000));
        const centers = dots => dots.map(actor => {
            const {origin, size} = actor.get_transformed_extents();
            return [origin.x + size.width / 2, origin.y + size.height / 2];
        });
        for (const side of ['bottom', 'left', 'right']) {
            settings().set_string('position', side);
            second.minimize();
            await settle();
            window.activate(global.get_current_time());
            await settle();

            const dots = windowDots(dot());
            const start = centers(dots);
            const axis = side === 'bottom' ? 0 : 1;
            const across = 1 - axis;
            const colors = dots.map(actor => actor.get_theme_node().get_background_color().red);
            const [alongScale, acrossScale] = side === 'bottom' ? ['scale_x', 'scale_y'] : ['scale_y', 'scale_x'];
            check(`${side}: the focused window has a white dot and the minimized window a gray line`,
                dots.length === 2 && second.minimized && colors[0] === 255 && colors[1] === 166 &&
                dots[0].scale_x === 1 && dots[0].scale_y === 1 &&
                dots[1][alongScale] === 1 && dots[1][acrossScale] === 0.5 &&
                start[1][axis] > start[0][axis] && Math.abs(start[1][across] - start[0][across]) <= 0.5,
                `dots=${start} colors=${colors} across scales=${dots.map(actor => actor[acrossScale])}`);

            second.unminimize();
            second.activate(global.get_current_time());
            await settle();
            const updated = windowDots(dot());
            const end = centers(updated);
            const updatedColors = updated.map(actor => actor.get_theme_node().get_background_color().red);
            check(`${side}: restoring and focusing a window changes the marks without moving them`,
                global.display.focus_window === second && updated.length === 2 &&
                updated.every(actor => actor.scale_x === 1 && actor.scale_y === 1 &&
                    actor.width === actor.height && actor.width === updated[0].width) &&
                updatedColors[0] === colors[1] && updatedColors[1] === 255 &&
                end.every((center, i) => center.every((value, j) => Math.abs(value - start[i][j]) <= 0.01)),
                `before=${start} after=${end} colors=${updatedColors}`);
        }
    } finally {
        settings().set_string('position', 'bottom');
        second?.delete(global.get_current_time());
        await waitFor(() => !secondWindow(), 5000);
        await settle();
    }
    check('window indicator: closing the second window restores the dot', isDot());
}

async function testWindowIndicatorOverflow(window) {
    const tracker = Shell.WindowTracker.get_default();
    const app = tracker.get_window_app(window);
    const indicator = () => appItems().find(item => item.child?.app === app)?.child._dot;
    const windows = [];
    try {
        for (const title of ['basedock second test window', 'basedock third test window',
            'basedock test window 4', 'basedock test window 5', 'basedock test window 6',
            'basedock test window 7']) {
            const opened = await openTestAppWindow(title);
            if (!opened)
                throw new Error(`could not open ${title}`);
            windows.push(opened);
        }
        for (const side of ['bottom', 'left', 'right']) {
            settings().set_string('position', side);
            await waitFor(() => ourDash()?._side === side && windowDots(indicator()).length === 7, 5000, 20);
            const dash = ourDash();
            const start = dash.iconSize;
            dash.beginResize(0, 0);
            try {
                const samples = [];
                for (const size of [27, 26, 23, 16]) {
                    dash.previewResize(size - start);
                    const resized = await waitFor(() => dash.iconSize === size, 1000, 20);
                    const host = indicator();
                    if (!resized || !host?.visible) {
                        samples.push('missing');
                        continue;
                    }
                    samples.push(host.has_style_class_name('basedock-window-indicator-overflow')
                        ? 'bar' : windowDots(host).length);
                }
                check(`${side}: shrinking keeps the overflow bar once it appears`,
                    samples[0] === 7 && samples.slice(1).every(sample => sample === 'bar'),
                    `indicator at sizes 27, 26, 23 and 16: ${samples.join(', ')}`);
            } finally {
                dash.commitResize(0);
            }
        }
    } finally {
        settings().set_string('position', 'bottom');
        for (const opened of windows)
            opened.delete(global.get_current_time());
        await waitFor(() => app.get_windows().length === 1, 5000);
        await settle();
    }
}

async function testTransientWindowIndicator(window) {
    const tracker = Shell.WindowTracker.get_default();
    const icon = () => appItems().find(item => item.child?.app === tracker.get_window_app(window))?.child;
    const dots = () => windowDots(icon()?._dot);
    const toggleTransient = () => callTestApp('org.gtk.Actions', 'Activate',
        new GLib.Variant('(sava{sv})', ['toggle-transient', [], {}]));
    const second = await openTestAppWindow('basedock second test window');
    let third;
    try {
        third = await openTestAppWindow('basedock third test window');
        const ready = second && third && await waitFor(() => dots().length === 3, 5000);
        check('transient indicator: three eligible windows start with three dots', ready);
        if (!ready)
            return;

        await toggleTransient();
        check('transient indicator: an existing window drops its dot when it skips the taskbar',
            await waitFor(() => third.skip_taskbar && dots().length === 2, 5000),
            `skip=${third.skip_taskbar} dots=${dots().length}`);
        // Reach the dialog through its parent with a real user timestamp.
        for (let i = 0; i < 2 && global.display.focus_window !== third; i++)
            await dragActorBy(icon(), 0, 0);
        const colors = dots().map(dot => dot.get_theme_node().get_background_color().red);
        check('transient indicator: the parent dot is white while its dialog has focus',
            global.display.focus_window === third && colors[0] === 255 && colors[1] === 166,
            `focus=${global.display.focus_window?.get_title()} colors=${colors}`);

        await dragActorBy(icon(), 0, 0);
        check('transient indicator: a click cycles from the parent to the next window',
            global.display.focus_window === second,
            `focus=${global.display.focus_window?.get_title()}`);

        await toggleTransient();
        check('transient indicator: the dot returns when the window rejoins the taskbar',
            await waitFor(() => !third.skip_taskbar && dots().length === 3, 5000),
            `skip=${third.skip_taskbar} dots=${dots().length}`);
    } finally {
        second?.delete(global.get_current_time());
        third?.delete(global.get_current_time());
        await waitFor(() => !global.display.list_all_windows().some(w => w === second || w === third), 5000);
        await settle();
    }
}

/** Use real dock clicks to cycle windows and leave minimized ones parked. */
async function testWindowCycle(window) {
    const tracker = Shell.WindowTracker.get_default();
    const icon = () => appItems().find(item => item.child?.app === tracker.get_window_app(window))?.child;
    const second = await openTestAppWindow('basedock second test window');
    let third;
    try {
        third = await openTestAppWindow('basedock third test window');
        const grouped = second && third && await waitFor(() =>
            [second, third].every(w => tracker.get_window_app(w) === tracker.get_window_app(window)), 5000);
        check('window cycle: the test app owns three windows', grouped);
        if (!grouped)
            return;

        const order = [window, second, third];
        const next = focused => order[(order.indexOf(focused) + 1) % order.length];
        for (const side of ['bottom', 'left', 'right']) {
            settings().set_string('position', side);
            for (const appWindow of order)
                appWindow.unminimize();
            await settle();
            window.activate(global.get_current_time());
            await settle();
            if (global.display.focus_window !== window)
                await dragActorBy(icon(), 0, 0);
            const initial = global.display.focus_window;
            const focused = [];
            for (let i = 0; i < 3; i++) {
                await dragActorBy(icon(), 0, 0);
                focused.push(global.display.focus_window);
            }
            check(`${side}: clicks advance in indicator order and wrap to the start`,
                order.includes(initial) && focused[0] === next(initial) && focused[1] === next(focused[0]) &&
                focused[2] === initial && !second.minimized && !icon()._menu?.isOpen,
                `initial=${initial?.get_title()} focus order=${focused.map(w => w?.get_title()).join(', ')}`);

            await dragActorBy(icon(), 0, 0);
            const minimized = global.display.focus_window;
            minimized?.minimize();
            await settle();
            const before = global.display.focus_window;
            await dragActorBy(icon(), 0, 0);
            const after = global.display.focus_window;
            const visible = order.filter(w => w !== minimized);
            check(`${side}: minimizing a window skips it without changing indicator order`,
                order.includes(minimized) && minimized.minimized && visible.includes(before) &&
                after === visible[(visible.indexOf(before) + 1) % visible.length],
                `minimized=${minimized?.get_title()} before=${before?.get_title()} after=${after?.get_title()}`);

            if (side === 'bottom') {
                before?.minimize();
                await settle();
                await dragActorBy(icon(), 0, 0);
                check('window cycle: clicking with just one visible window leaves both others minimized',
                    global.display.focus_window === after && minimized?.minimized && before?.minimized);

                await rightClick(icon());
                const entry = icon()._menu?._windowSection._getMenuItems()
                    .find(item => item.label.text === minimized?.get_title());
                if (entry)
                    await dragActorBy(entry, 0, 0);
                check('window cycle: Open Windows restores the parked window',
                    entry && !minimized.minimized && global.display.focus_window === minimized);
            }
        }
    } finally {
        settings().set_string('position', 'bottom');
        second?.delete(global.get_current_time());
        third?.delete(global.get_current_time());
        await waitFor(() => !global.display.list_all_windows().some(w => w === second || w === third), 5000);
        await settle();
    }
    window.minimize();
    await settle();
    await dragActorBy(icon(), 0, 0);
    check('window cycle: a single minimized window restores on the first click',
        global.display.focus_window === window && !window.minimized);
}

/** Trash: a tile's footprint, and its icon follows the trash's state. */
async function testTrash() {
    const dash = ourDash();
    const trash = dash._trashIcon;
    const tile = appItems()[0]?.child._delegate.icon;
    check('Trash sits on a tile the size of an app tile',
        tile && Math.round(trash.icon.width) === Math.round(tile.width) &&
        Math.round(trash.icon.height) === Math.round(tile.height),
        `trash=${trash.icon.width}x${trash.icon.height} tile=${tile?.width}x${tile?.height}`);

    const data = GLib.get_user_data_dir();
    const tmp = GLib.getenv('BASEDOCK_TMP');
    if (!tmp || data !== `${tmp}/data`)
        throw new Error('Trash fixture requires the headless runner’s data directory');

    const iconName = () => trash.icon.icon?.gicon?.get_names?.()[0];
    const aggregate = Gio.File.new_for_uri('trash:///');
    const count = () => aggregate.query_info('trash::item-count',
        Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint32('trash::item-count');
    const baseline = count();
    const initialIcon = baseline ? 'user-trash-full' : 'user-trash';
    check('Trash reflects the initial aggregate count',
        await waitFor(() => iconName() === initialIcon, 3000), iconName());
    await checkTrashMenu('initial trash', baseline > 0);

    // GVfs includes other volumes in trash:///. Create and remove only
    // the two fixture files in the private XDG data directory.
    const trashDir = `${data}/Trash`;
    const payload = `${trashDir}/files/basedock-trash-test.txt`;
    const metadata = `${trashDir}/info/basedock-trash-test.txt.trashinfo`;
    GLib.mkdir_with_parents(`${trashDir}/files`, 0o700);
    GLib.mkdir_with_parents(`${trashDir}/info`, 0o700);
    try {
        GLib.file_set_contents(payload, 'basedock');
        GLib.file_set_contents(metadata,
            '[Trash Info]\nPath=/tmp/basedock-trash-test.txt\nDeletionDate=2026-01-01T00:00:00\n');
        check('Trash counts the fixture and shows the full icon',
            await waitFor(() => count() === baseline + 1 && iconName() === 'user-trash-full', 5000),
            iconName());
        await checkTrashMenu('full trash', true);
    } finally {
        for (const path of [metadata, payload]) {
            if (GLib.file_test(path, GLib.FileTest.EXISTS))
                Gio.File.new_for_path(path).delete(null);
        }
    }
    check('Removing the fixture restores the initial Trash count and icon',
        await waitFor(() => count() === baseline && iconName() === initialIcon, 5000), iconName());
}

const settings = () => Main.extensionManager.lookup(UUID).stateObj.getSettings();

/**
 * Drag a resize handle by `dy` (negative = up), with a real pointer.
 */
async function dragHandle(handle, dy, onMidway = () => {}) {
    const [hx, hy] = handle.get_transformed_position();
    const x = Math.round(hx + handle.width / 2), y = Math.round(hy + handle.height / 2);
    const pointer = await sharedPointer();
    await pointer.moveTo(x, y);
    await pointer.press();
    for (let i = 1; i <= 4; i++)
        await pointer.moveTo(x, Math.round(y + dy * i / 4));
    onMidway();
    await pointer.release();
    await settle();
}

/** Leave the dock, reverse direction, and release outside it in one drag. */
async function checkResizeOutsideGrip(grip, dy) {
    const dash = ourDash();
    const side = dash._side;
    const start = dash.iconSize;
    const saved = settings().get_int('icon-size');
    const previousGrab = global.stage.get_grab_actor();
    const [gx, gy] = grip.get_transformed_position();
    const x = Math.round(gx + grip.width / 2);
    const y = Math.round(gy + grip.height / 2);
    const monitor = Main.layoutManager.primaryMonitor;
    const outsideX = Math.round(monitor.x + monitor.width * 0.75);
    const pointer = await sharedPointer();
    await pointer.moveTo(x, y);
    await pointer.press();
    try {
        const sizes = [];
        let held = global.stage.get_grab_actor() === grip;
        for (const offset of [0, dy, dy / 2, dy]) {
            await pointer.moveTo(outsideX, y + offset);
            sizes.push(dash.iconSize);
            held &&= global.stage.get_grab_actor() === grip;
        }
        check(`${side}: a resize drag keeps receiving motion outside the dock`,
            held && sizes.join(',') === [start, start - dy, start - dy / 2, start - dy].join(',') &&
                settings().get_int('icon-size') === saved, `held=${held} sizes=${sizes}`);
    } finally {
        await pointer.release();
    }
    check(`${side}: releasing outside the dock saves the size and drops the grab`,
        global.stage.get_grab_actor() === previousGrab && dash.iconSize === start - dy &&
            settings().get_int('icon-size') === dash.iconSize);
    await settle();
}

// App icons are the icon size plus G (src/geometry.ts): they grow into
// their tile's padding, the tile keeps its footprint F.
const iconGrow = size => geometryAt(size).iconGrow;
const tileSize = size => size + geometryAt(size).footprint;

/** Dynamic sizing: the icon-size setting and the dividers as resize handles. */
async function testResize() {
    const dash = ourDash();
    const tileHeight = () => Math.round(appItems()[0].child._delegate.icon.height);

    // No flicker: resizing keeps the existing St.Icons (a recreated one is
    // blank until loaded), and the dock is at the screen's bottom in the
    // very first frame painted at the new size. Installed apps only: the
    // test window's app has no desktop file, and GNOME now and then
    // replaces such a window-backed app, and the dash its item with it,
    // whatever the dock does.
    const installedIcons = () => appItems()
        .filter(i => !i.child.app.is_window_backed())
        .map(i => i.child._delegate.icon.icon);
    const iconsBefore = installedIcons();
    const m = Main.layoutManager.primaryMonitor;
    const container = dockContainer();
    let firstFrameBottom = null;
    const paintId = global.stage.connect('after-paint', () => {
        if (firstFrameBottom === null && ourDash().iconSize === 56) {
            const [, y] = container.get_transformed_position();
            firstFrameBottom = Math.round(y + container.height);
        }
    });
    settings().set_int('icon-size', 56);
    await settle();
    global.stage.disconnect(paintId);
    const iconsAfter = installedIcons();
    check('resize: icons are resized in place, not recreated (no blank frame)',
        iconsAfter.length > 0 && iconsAfter.length === iconsBefore.length &&
        iconsAfter.every((icon, i) => icon === iconsBefore[i] && icon.icon_size === 56 + iconGrow(56)),
        `same=${iconsAfter.map((icon, i) => icon === iconsBefore[i])} ` +
        `sizes=${iconsAfter.map(icon => icon.icon_size)}`);
    check('resize: the dock sits at the screen bottom in the first frame at the new size',
        firstFrameBottom === m.y + m.height,
        `first frame bottom=${firstFrameBottom} screen bottom=${m.y + m.height}`);

    settings().set_int('icon-size', 40);
    await settle();
    check('resize: setting 40 gives 40px icons (free sizes)',
        dash.iconSize === 40 && tileHeight() === tileSize(40),
        `iconSize=${dash.iconSize} tile=${tileHeight()}`);
    check('resize: at 40px both dividers are as tall as the icons',
        [dash._showAppsHandle, dash._trashHandle].every(h =>
            Math.round(h.line.height) === 40 && Math.round(h.actor.height) === 40),
        [dash._showAppsHandle, dash._trashHandle].map(h => h.line.height).join(','));
    // The overview's layout, the app grid's page dots included, doesn't
    // depend on the dock's size (src/dock.ts, #relayout).
    check('resize: at 40px the overview keeps its room for the tallest dock',
        stockDash().height === 112, `spacer=${stockDash().height}`);

    // Never taller than GNOME's own dash at its largest (src/dock.ts:
    // 112px with the default theme), even at the largest icon size.
    settings().set_int('icon-size', 64);
    await settle();
    const tallest = Math.round(dockContainer().height);
    check('resize: never taller than GNOME\'s dash (112px), even at icon-size 64',
        tallest <= 112 && tallest > 112 - 4 && dash.iconSize < 64,
        `height=${tallest} iconSize=${dash.iconSize}`);
    const grip = dash._edgeGrip;
    const [gx, gy] = grip.get_transformed_position();
    const pointerForClick = await sharedPointer();
    await pointerForClick.moveTo(Math.round(gx + grip.width / 2), Math.round(gy + grip.height / 2));
    await pointerForClick.press();
    await pointerForClick.release();
    check('resize: clicking a grip keeps the saved size when the dock is fitted',
        settings().get_int('icon-size') === 64, `saved size=${settings().get_int('icon-size')}`);

    settings().set_int('icon-size', 80);
    await settle();
    check('resize: sizes above 64 are rejected by the setting',
        settings().get_int('icon-size') === 64, `setting=${settings().get_int('icon-size')}`);

    // From 40, so the drag stays below the largest size that fits.
    settings().set_int('icon-size', 40);
    await settle();
    // Dragging changes the icon size by one per pixel, laid out for real,
    // so the dock grows with every pixel (src/dash.ts, previewResize).
    // Every frame shows icons at their size right away (not when their
    // image has loaded).
    const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
    const handle = dash._trashHandle.actor;
    const width = () => dash._background.get_transformed_extents().size.width;
    const frames = [];
    const frameId = global.stage.connect('after-paint', () => frames.push({
        size: dash.iconSize,
        widths: appItems().map(item => Math.round(item.child._delegate.icon.icon.width)),
    }));
    const [hx, hy] = handle.get_transformed_position();
    const px = Math.round(hx + handle.width / 2), py = Math.round(hy + handle.height / 2);
    const pointer = await sharedPointer();
    await pointer.moveTo(px, py);
    await pointer.press();
    const startWidth = width();
    const steps = [];
    for (let d = 1; d <= 12; d++) {
        await pointer.moveTo(px, py - d);
        steps.push({size: dash.iconSize, width: width() - startWidth});
    }
    await pointer.release();
    await settle();
    global.stage.disconnect(frameId);
    const lagging = frames.filter(f => f.widths.some(w => w !== (f.size + iconGrow(f.size)) * scaleFactor));
    check('resize: icons take each new size in the same frame',
        frames.length > 2 && lagging.length === 0, `${frames.length} frames, lagging=${JSON.stringify(lagging.slice(0, 2))}`);
    check('resize: dragging, one icon size per pixel',
        steps.every((step, k) => step.size === 40 + k + 1),
        steps.map(step => step.size).join(' '));
    const growth = steps.map((step, k) => step.width - (k ? steps[k - 1].width : 0));
    check('resize: dragging, the dock grows with every pixel',
        Math.min(...growth) > 0, growth.map(g => g.toFixed(1)).join(' '));
    check('resize: released, it keeps the size the drag reached, saved',
        dash.iconSize === 52 && settings().get_int('icon-size') === 52,
        `iconSize=${dash.iconSize} setting=${settings().get_int('icon-size')}`);

    await dragHandle(dash._trashHandle.actor, 150);
    check('resize: dragging far down stops at the smallest size, 16px',
        dash.iconSize === 16 && settings().get_int('icon-size') === 16,
        `iconSize=${dash.iconSize} setting=${settings().get_int('icon-size')}`);

    await dragHandle(dash._showAppsHandle.actor, -24);
    const resized = dash.iconSize;
    check('resize: the Show Apps divider works too',
        resized > 16 && settings().get_int('icon-size') === resized, `iconSize=${resized}`);

    Main.extensionManager.disableExtension(UUID);
    await settle();
    Main.extensionManager.enableExtension(UUID);
    await settle();
    check('resize: the size is kept across disable/enable',
        ourDash().iconSize === resized, `iconSize=${ourDash().iconSize}, was ${resized}`);

    settings().set_int('icon-size', 48);
    await settle();
}

/**
 * Check that a bottom dock remains interactive while drawn below the window
 * previews in the overview.
 */
function checkOverviewStacking() {
    const container = dockContainer();
    const controls = Main.overview._overview._controls;
    const children = controls.get_children();
    const stock = Main.overview.dash;
    check('overview stacking: the dock is inside the stock dash',
        container?.get_parent() === stock, `parent=${container?.get_parent()}`);
    check('overview stacking: below the window previews (stock dash before workspaces)',
        children.indexOf(stock) < children.indexOf(controls._workspacesDisplay),
        `dash=${children.indexOf(stock)} workspaces=${children.indexOf(controls._workspacesDisplay)}`);
    const m = Main.layoutManager.primaryMonitor;
    const [cx, cy] = container.get_transformed_position();
    check('overview stacking: still at the screen bottom, full width',
        Math.round(cy + container.height) === m.y + m.height &&
        Math.round(cx) === m.x && Math.round(container.width) === m.width,
        `x=${cx} bottom=${cy + container.height} width=${container.width}`);

    const dash = container?.get_child();
    const centerOf = actor => {
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        return [Math.round(x + w / 2), Math.round(y + h / 2)];
    };
    const tile = dash?._box.get_children().find(c => c.child?._delegate?.app)?.child._delegate.icon;
    for (const [name, actor] of [['an app tile', tile], ['Show Apps', dash?._showAppsIcon.icon]]) {
        const [x, y] = centerOf(actor);
        const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        check(`overview stacking: ${name} still gets the pointer`,
            picked && dash.contains(picked), `picked=${picked}`);
    }
}

function checkDisabledState() {
    const stock = stockDash();

    check('disabled: extension INACTIVE',
        extensionState() === ExtensionState.INACTIVE, `state=${extensionState()}`);
    check('disabled: dock removed', dockContainer() === null);
    check('disabled: stock dash visible, with its contents',
        stock.visible && stock._background.visible && stock._dashContainer.visible);
    check('disabled: stock dash back in Ctrl+Alt+Tab',
        Main.ctrlAltTabManager._items.some(item => item.root === stock));
    check('disabled: stock dash has natural height', stock.natural_height_set === false);
    const window = global.display.list_all_windows().find(w => w.get_title() === TEST_WINDOW_TITLE);
    check('disabled: windows minimize as without the dock (no icon geometry)',
        window && !window.get_icon_geometry()[0]);
    check('disabled: stock dash iconSize is plain data again',
        Object.getOwnPropertyDescriptor(stock, 'iconSize')?.get === undefined);
}

/**
 * Verify that the separator between favorites and other running apps also
 * works as a resize handle.
 */
async function testSeparatorHandle() {
    const dash = ourDash();
    const separator = dash._separator;
    check('separator: shown for a running app that is not a favorite',
        !!separator && dash._box.contains(separator));
    if (!separator)
        return;
    check('separator: it is a resize handle, as tall as the icons',
        separator === dash._separatorHandle?.actor &&
        separator.has_style_class_name('basedock-handle') &&
        Math.round(dash._separatorHandle.line.height) === dash.iconSize,
        `${separator.style_class} line=${dash._separatorHandle?.line.height}`);
    await dragHandle(separator, -8);
    check('separator: dragging it resizes the dock',
        dash.iconSize > 48 && settings().get_int('icon-size') === dash.iconSize,
        `iconSize=${dash.iconSize}`);
    check('separator: it follows the new size',
        Math.round(dash._separatorHandle.line.height) === dash.iconSize,
        `line=${dash._separatorHandle.line.height}`);
    settings().set_int('icon-size', 48);
    await settle();
}

/** Window previews in the overview, with their stage extents. */
function previewExtents() {
    const found = [];
    const walk = actor => {
        if (actor.constructor.name === 'WindowPreview' && actor.mapped)
            found.push(actor);
        actor.get_children().forEach(walk);
    };
    walk(Main.layoutManager.overviewGroup);
    return JSON.stringify(found.map(a => {
        const {origin, size} = a.get_transformed_extents();
        return [origin.x, origin.y, size.width, size.height].map(Math.round);
    }));
}

/**
 * Resize within the overview's fixed-height spacer. The previews and app grid
 * should keep their positions during and after the drag.
 */
async function testOverviewResize() {
    await showOverview();
    const dash = ourDash();
    const stock = stockDash();
    const previews = previewExtents();
    const stockHeight = stock.height;
    let during = null;
    await dragHandle(dash._trashHandle.actor, -16, () => (during = previewExtents()));
    check('overview resize: the dock resizes in the overview',
        dash.iconSize > 48, `iconSize=${dash.iconSize}`);
    const tile = firstAppTile();
    const [, tileY] = tile.get_transformed_position();
    const [, bgY] = dash._background.get_transformed_position();
    const node = dash._background.get_theme_node();
    const inset = node.get_padding(St.Side.TOP) + node.get_border_width(St.Side.TOP);
    check('overview resize: the dock background grows with the icons',
        Math.round(tileY - bgY) === inset &&
        Math.round(dash._background.height) === Math.round(tile.height) + 2 * inset,
        `tile top ${tileY - bgY} below background top, background=${dash._background.height} tile=${tile.height}`);
    const m = Main.layoutManager.primaryMonitor;
    const [, cy] = dockContainer().get_transformed_position();
    check('overview resize: the dock stays at the screen bottom',
        Math.round(cy + dockContainer().height) === m.y + m.height);
    check('overview resize: window previews and the spacer stay put while dragging',
        during === previews && stock.height === stockHeight,
        `before=${previews} during=${during} spacer ${stockHeight} → ${stock.height}`);
    check('overview resize: and after the drag',
        previewExtents() === previews, `before=${previews} after=${previewExtents()}`);
    await hideOverview();
    await settle();
    check('overview resize: the spacer keeps its height after the overview',
        stock.height === stockHeight, `spacer=${stock.height}, was ${stockHeight}`);
    settings().set_int('icon-size', 48);
    await settle();
}

/**
 * Check the light palette's dark dividers and white symbol and dots. Enter and
 * leave the overview to verify the switch to dark and back. Restore dark for
 * the remaining checks.
 */
async function testLightDock() {
    const isLight = () => ourDash().has_style_class_name('basedock-light');
    const fade = () => ourDash()._background.get_theme_node().get_transition_duration();
    settings().set_string('style', 'light');
    await settle();
    check('light dock: the Default style makes it light', isLight());
    const line = ourDash()._separatorHandle.line.get_theme_node().get_background_color();
    const symbol = ourDash()._showAppsIcon._iconActor.get_theme_node().get_foreground_color();
    const appIcon = appItems().map(i => i.child).find(c => c._dot.visible);
    const dot = windowDots(appIcon?._dot)[0]?.get_theme_node().get_background_color();
    const expectedDot = appIcon?.app.get_windows().includes(global.display.focus_window) ? 255 : 166;
    check('light dock: dark dividers, white Show Apps symbol and neutral window dots',
        line.red === 0 && line.alpha > 0 && symbol.red === 255 && symbol.green === 255 &&
        dot?.red === expectedDot && dot.green === expectedDot && dot.blue === expectedDot && dot.alpha === 255,
        `line ${line.to_string()} symbol ${symbol.to_string()} dot ${dot?.to_string()}`);

    const shown = once(Main.overview, 'shown');
    Main.overview.show();
    await shown;
    check('light dock: dark in the overview', !isLight());
    check('light dock: the overview fades it with its animation (250 ms)',
        fade() === 250, `${fade()} ms`);
    await hideOverview();
    check('light dock: light again after the overview', await waitFor(isLight, 5000));

    for (const side of ['left', 'right', 'bottom']) {
        settings().set_string('position', side);
        await waitFor(() => ourDash()?._side === side, 2000);
        check(`light dock: moving to ${side} keeps its palette with no fade`,
            ourDash()?._side === side && isLight() && fade() === 0);
    }

    settings().set_string('style', 'dark');
    await settle();
}

/**
 * Check that High Contrast uses the opaque dark fill and solid 2px rim even
 * with light style selected. Check that disabling it restores the normal
 * palette.
 */
async function testHighContrast() {
    const a11y = new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'});
    const dash = ourDash();
    const background = () => dash._background.get_theme_node();
    settings().set_string('style', 'light');
    a11y.set_boolean('high-contrast', true);
    const on = await waitFor(() => dash.has_style_class_name('basedock-high-contrast'), 3000);
    await settle();
    check('high contrast: the dock takes the high-contrast look', on);
    // The rim is a border, not the theme's inset box-shadow, which would
    // draw a second one (stylesheet.css).
    check('high contrast: opaque background, solid 2px rim, no box-shadow',
        background().get_background_color().alpha === 255 &&
        background().get_border_width(St.Side.TOP) === 2 &&
        !background().get_box_shadow(),
        `background ${background().get_background_color().to_string()} ` +
        `border ${background().get_border_width(St.Side.TOP)}`);
    check('high contrast: dark even in the Default style', !dash.has_style_class_name('basedock-light'));

    a11y.reset('high-contrast');
    const off = await waitFor(() => !dash.has_style_class_name('basedock-high-contrast'), 3000);
    await settle();
    check('high contrast: off again, translucent and light as chosen',
        off && background().get_background_color().alpha < 255 &&
        dash.has_style_class_name('basedock-light'),
        `background ${background().get_background_color().to_string()}`);
    settings().set_string('style', 'dark');
    await settle();
}

/**
 * Sample the hide animation with reduced motion. The dock should fade in place
 * during the animation and end offscreen.
 */
async function testReducedMotion(window) {
    const a11y = new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'});
    a11y.set_string('reduced-motion', 'reduce');
    await waitFor(() => St.Settings.get().reducedMotion === St.ReducedMotion.REDUCE, 2000);
    const dash = ourDash();
    const fading = () => dash.translation_y === 0 && dash.opacity > 0 && dash.opacity < 255;

    window.maximize();
    const hiding = await waitFor(fading, 1000, 20);
    await settle();
    checkDock('reduced motion: maximized', 'hidden');
    check('reduced motion: the dock fades out in place', hiding,
        `translation=${dash.translation_y} opacity=${dash.opacity}`);

    window.unmaximize();
    const showing = await waitFor(fading, 1000, 20);
    await settle();
    checkDock('reduced motion: unmaximized', 'shown');
    check('reduced motion: the dock fades in in place', showing,
        `translation=${dash.translation_y} opacity=${dash.opacity}`);

    const sizeSetting = settings();
    const preferred = sizeSetting.get_int('icon-size');
    const start = dash.iconSize;
    const cap = start - 1;
    const target = start - 8;
    sizeSetting.set_int('icon-size', target);
    check('reduced motion: icon resizing applies immediately', dash.iconSize === target,
        `size=${dash.iconSize} wanted=${target}`);
    sizeSetting.set_int('icon-size', preferred);

    // Exercise the failure return from Gio.Settings without changing
    // system-wide dconf policy for the test.
    const realSettings = dash._settings;
    const growLimit = dash._growLimit;
    let attempted = null;
    try {
        dash.setPreferredIconSize(target);
        dash._settings = {
            get_int: () => start,
            set_int: (_key, size) => {
                attempted = size;
                return false;
            },
        };
        dash.setGrowLimit(() => {
            const measurements = dash._dockMeasurements();
            const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
            const thicknessAt = size => dockSizeAt(measurements, size).backgroundThickness;
            return (thicknessAt(cap) - thicknessAt(target)) * scaleFactor;
        });
        dash._applyIconSizeSetting();
        check('resize: a rejected settings write still applies the cap',
            attempted === cap && dash.iconSize === cap,
            `write=${attempted} size=${dash.iconSize} cap=${cap}`);
    } finally {
        dash._settings = realSettings;
        dash.setGrowLimit(growLimit);
        dash.setPreferredIconSize(preferred);
    }

    a11y.reset('reduced-motion');
    await waitFor(() => St.Settings.get().reducedMotion !== St.ReducedMotion.REDUCE, 2000);
}

/**
 * Check that Follow System uses GNOME's appearance setting and that explicit
 * light and dark selections override it. Leave the dock dark for subsequent
 * checks.
 */
async function testDockStyle() {
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const isLight = () => ourDash().has_style_class_name('basedock-light');
    const cases = [
        ['system', 'default', true, 'follows GNOME\'s Default style: light'],
        ['system', 'prefer-dark', false, 'follows GNOME\'s Dark style: dark'],
        ['system', 'prefer-light', true, 'follows prefer-light: light'],
        ['light', 'prefer-dark', true, 'Default (light) whatever GNOME\'s style'],
        ['dark', 'default', false, 'Dark whatever GNOME\'s style'],
    ];
    settings().reset('style');
    check('dock style: follows the system by default',
        settings().get_string('style') === 'system', settings().get_string('style'));
    for (const [style, scheme, light, name] of cases) {
        settings().set_string('style', style);
        iface.set_string('color-scheme', scheme);
        await wait(300);
        check(`dock style: ${name}`, isLight() === light, `style=${style} color-scheme=${scheme}`);
    }
    // GNOME's style switches the wallpaper's light and dark variant too:
    // the dock fades along with the shell's cross-fade to it (1 s).
    settings().set_string('style', 'system');
    iface.set_string('color-scheme', 'prefer-dark');
    await wait(300);
    iface.set_string('color-scheme', 'default');
    await wait(300);
    const fade = ourDash()._background.get_theme_node().get_transition_duration();
    check('dock style: following GNOME\'s style, it fades with the wallpaper (1 s)',
        isLight() && fade === 1000, `light=${isLight()} ${fade} ms`);
    iface.reset('color-scheme');
    settings().set_string('style', 'dark');
    await settle();
}

/**
 * Drag toward a tiled window to check the dock's growth limit. Shrink the dock
 * and grow it back to the same limit. The tiled window keeps its size
 * throughout.
 */
async function checkResizeBesideTile(window, handle) {
    const rect = () => {
        const r = window.get_frame_rect();
        return `${r.x},${r.y} ${r.width}x${r.height}`;
    };
    const tile = rect();
    const start = ourDash().iconSize;
    const steps = [];
    for (const by of [8, -8, 16]) {
        await dragHandle(handle, -by);
        steps.push({size: ourDash().iconSize, rect: rect()});
    }
    const [grown, shrunk, back] = steps;
    check('resize: beside a tiled window, the dock only shrinks and grows back to it; the window keeps its size',
        grown.size === start && shrunk.size < start && back.size === start &&
        steps.every(step => step.rect === tile),
        `got ${steps.map(step => `${step.size}@${step.rect}`).join(' ')}, started at ${start}@${tile}`);

    // The setting can't grow it into the window either; it's written back.
    settings().set_int('icon-size', start + 16);
    await settle();
    check('resize: setting a bigger icon size beside a tiled window keeps the dock at it',
        ourDash().iconSize === start && settings().get_int('icon-size') === start && rect() === tile,
        `iconSize=${ourDash().iconSize} setting=${settings().get_int('icon-size')} window ${rect()} (was ${tile})`);
    settings().set_int('icon-size', start);
    await settle();
}

/**
 * Pin enough apps to force fitting. Check that one more icon-size step would
 * overflow and that the dock background keeps 24px of clearance from the work
 * area's ends.
 */
async function checkFillsScreen(count) {
    const data = GLib.get_user_data_dir();
    const ids = [];
    for (let i = 0; i < 75; i++) {
        const id = `basedock-many-${i}.desktop`;
        GLib.file_set_contents(`${data}/applications/${id}`,
            `[Desktop Entry]\nType=Application\nName=Many ${i}\nExec=true\nIcon=folder\n`);
        ids.push(id);
    }
    // Until GNOME has picked up the new desktop files.
    const appSystem = Shell.AppSystem.get_default();
    await waitFor(() => ids.every(id => appSystem.lookup_app(id)), 10000);
    const favorites = global.settings.get_strv('favorite-apps');
    settings().set_int('icon-size', 48);
    await settle();
    // The dock shrinks to fit by stepping through the sizes between
    // (src/dash.ts, #animateIconSize), not in one jump.
    const shown = new Set();
    const frameId = global.stage.connect('after-paint', () => shown.add(ourDash().iconSize));
    global.settings.set_strv('favorite-apps', ids.slice(0, count));
    await wait(2500);
    global.stage.disconnect(frameId);
    settings().set_int('icon-size', 64);
    await wait(1000);

    const dash = ourDash();
    const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
    const length = Math.round(dash.width);
    const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
    const endMargin = END_MARGIN * scaleFactor;
    const screen = area.width - 2 * endMargin;
    const items = appItems().length + 2; // with Show Apps and the Trash
    // One more pixel of icon size adds 1 to about 4 px per item: the gaps
    // grow with it, in whole pixels (src/geometry.ts).
    const between = [...shown].filter(size => size < 48 && size > ourDash().iconSize);
    check(`fitting: with ${count} apps, the dock steps to a smaller size, not in a jump`,
        between.length >= 3,
        `${between.length} sizes between 48 and ${ourDash().iconSize}`);
    check(`fitting: with ${count} apps, the dock grows until it fills the screen`,
        dash.iconSize < 64 && length <= screen && length + 4 * items > screen,
        `iconSize=${dash.iconSize} length=${length} screen less its corners=${screen} items=${items}`);
    // The room, and the dash's own padding at its ends, between it and
    // the background: 18 + 6 = 24px at scale 1.
    const keep = endMargin + dash.get_theme_node().get_padding(St.Side.LEFT);
    const bg = backgroundBox();
    const corners = [bg.x - area.x, area.x + area.width - (bg.x + bg.width)];
    check(`fitting: with ${count} apps, the dock keeps ${keep}px from the screen's corners`,
        corners.every(gap => gap >= keep), `gaps=${corners}`);

    // Every icon in full view, inside the dock.
    const {origin, size} = dash._background.get_transformed_extents();
    const inside = actor => {
        const e = actor.get_transformed_extents();
        return e.origin.x >= origin.x && e.origin.y >= origin.y &&
            e.origin.x + e.size.width <= origin.x + size.width &&
            e.origin.y + e.size.height <= origin.y + size.height;
    };
    const icons = [...appItems().map(i => i.child.icon), dash._showAppsIcon.icon, dash._trashIcon.icon];
    check(`fitting: with ${count} apps, every icon is fully inside the dock, on the screen`,
        icons.every(inside) && origin.x >= area.x,
        `outside: ${icons.filter(i => !inside(i)).length} of ${icons.length}, dock x=${Math.round(origin.x)}`);

    // Dragging an app over the full dock: the drop placeholder counts, so
    // the dock makes room for it while it grows in, and has it back after.
    const fitted0 = dash._targetIconSize;
    const source = appItems()[0].child;
    dash.handleDragOver(source, dash._box, Math.round(dash._box.width) - 2, 2, 0);
    const withPlaceholder = dash._targetIconSize;
    dash._clearDragPlaceholder();
    const without = dash._targetIconSize;
    await settle();
    check('fitting: dragging an app over the full dock makes room for it, and gives it back',
        withPlaceholder < fitted0 && without === fitted0,
        `${fitted0} → ${withPlaceholder} with the placeholder → ${without}`);

    // Filling the screen, it can still be made smaller.
    const fitted = dash.iconSize;
    await dragHandle(dash._edgeGrip, 8);
    check(`fitting: with ${count} apps, the dock can still be made smaller`,
        dash.iconSize < fitted && settings().get_int('icon-size') === dash.iconSize,
        `${fitted} → ${dash.iconSize}, setting ${settings().get_int('icon-size')}`);

    // Show Apps keeps its proportion to the app icons when they're small.
    const symbol = dash._showAppsIcon.icon.icon.icon_size;
    const appIcon = appItems()[0].child.icon.icon.icon_size;
    check(`fitting: at icon size ${dash.iconSize}, Show Apps is about 7/9 of an app icon`,
        Math.abs(symbol / appIcon - 7 / 9) < 0.1, `symbol=${symbol} app icon=${appIcon}`);
    checkDividersCentered(`fitting: at icon size ${dash.iconSize}`);

    // At a side, the full dock keeps the same room to the top bar (the
    // work area's top) and the screen's bottom corner.
    settings().set_int('icon-size', 48);
    settings().set_string('position', 'left');
    await wait(2500);
    const column = backgroundBox();
    const columnKeep = endMargin + ourDash().get_theme_node().get_padding(St.Side.TOP);
    const ends = [column.y - area.y, area.y + area.height - (column.y + column.height)];
    check(`fitting: with ${count} apps at the left, the dock keeps ${columnKeep}px from the top bar and the corner`,
        ends.every(gap => gap >= columnKeep), `gaps=${ends} iconSize=${ourDash().iconSize}`);
    global.settings.set_strv('favorite-apps', ids.slice(0, 55));
    await settle();
    const crowded = ourDash();
    const scroll = crowded._dashContainer.get_children().find(actor => actor.name === 'basedock-overflow');
    check('overflow: a crowded column scrolls while Show Apps and Trash stay outside it',
        crowded.iconSize === 16 && scroll?.contains(crowded._box) &&
        !scroll.contains(crowded.showAppsButton) && !scroll.contains(crowded._trashIcon));
    const last = appItems().at(-1)?.child;
    last?.grab_key_focus();
    await settle();
    const [lastX, lastY] = last?.get_transformed_position() ?? [0, 0];
    const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE,
        Math.round(lastX + (last?.width ?? 0) / 2), Math.round(lastY + (last?.height ?? 0) / 2));
    check('overflow: focusing the last app scrolls it into reach',
        scroll?.vadjustment.value > 0 && last?.contains(picked),
        `scroll=${scroll?.vadjustment.value} picked=${picked}`);
    global.stage.set_key_focus(null);
    global.settings.set_strv('favorite-apps', favorites);
    await settle();
    check('overflow: the original apps box returns when its items fit',
        crowded._box.get_parent() === crowded._dashContainer);

    settings().set_string('position', 'bottom');
    global.settings.set_strv('favorite-apps', ids);
    await settle();
    const row = ourDash();
    const rowScroll = row._dashContainer.get_children().find(actor => actor.name === 'basedock-overflow');
    appItems().at(-1)?.child.grab_key_focus();
    await settle();
    check('overflow: focusing the last app scrolls a crowded row',
        rowScroll?.hadjustment.value > 0, `scroll=${rowScroll?.hadjustment.value}`);
    global.stage.set_key_focus(null);
    global.settings.set_strv('favorite-apps', favorites);
    settings().set_int('icon-size', 48);
    await wait(2500);
}

/**
 * Check that the inner border grip resizes the dock and lies inside the
 * background, clear of tiles and rounded corners.
 */
async function checkEdgeGrip() {
    const dash = ourDash();
    const box = actor => {
        const {origin, size} = actor.get_transformed_extents();
        return {x1: origin.x, y1: origin.y, x2: origin.x + size.width, y2: origin.y + size.height};
    };
    const grip = box(dash._edgeGrip);
    const bg = box(dash._background);
    const tile = box(firstAppTile());
    const radius = dash._background.get_theme_node().get_border_radius(St.Corner.TOPLEFT);
    check('resize: the dock\'s top border is a grip, clear of its corners and the tiles',
        grip.y1 === bg.y1 && grip.y2 <= tile.y1 && grip.x1 === bg.x1 + radius &&
        grip.x2 === bg.x2 - radius && dash._edgeGrip.reactive,
        `grip=${JSON.stringify(grip)} background=${JSON.stringify(bg)}`);

    const start = dash.iconSize;
    await checkResizeOutsideGrip(dash._edgeGrip, -8);
    check('resize: dragging the top border resizes the dock',
        dash.iconSize > start && settings().get_int('icon-size') === dash.iconSize,
        `iconSize=${dash.iconSize}`);
    settings().set_int('icon-size', start);
    await settle();
}

/**
 * Open an unmatched window and check that its temporary window-backed app is
 * delayed. This avoids briefly showing an extra item when Shell later matches
 * the window to an existing app.
 */
async function testUnmatchedApp() {
    const script = GLib.build_filenamev([GLib.get_user_cache_dir(), 'basedock-unmatched.js']);
    GLib.file_set_contents(script, `import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
GLib.set_prgname('basedock-unmatched');
Gtk.init();
new Gtk.Window({title: 'basedock unmatched window', default_width: 300, default_height: 200}).present();
new GLib.MainLoop(null, false).run();
`);
    const count = () => appItems().length;
    const before = count();
    GLib.spawn_async(null, ['gjs', '-m', script],
        ['WAYLAND_DISPLAY=basedock-test-0', `XDG_RUNTIME_DIR=${GLib.getenv('XDG_RUNTIME_DIR')}`,
            `PATH=${GLib.getenv('PATH')}`, `HOME=${GLib.get_home_dir()}`],
        GLib.SpawnFlags.SEARCH_PATH, null);
    const unmatched = () => global.display.list_all_windows()
        .find(w => w.get_title() === 'basedock unmatched window');
    const shown = await waitFor(() => unmatched(), 5000);
    await wait(300);
    const early = count();
    await wait(1500);
    const later = count();
    check('unmatched app: no icon at first, one after a moment',
        shown && early === before && later === before + 1,
        `window=${!!shown} icons ${before} → ${early} (at 300 ms) → ${later}`);
    unmatched()?.delete(global.get_current_time());
    await waitFor(() => !unmatched(), 5000);
    await settle();
    check('unmatched app: its icon goes with its window', count() === before, `${count()} icons`);
}

/** A real right-click at (x, y), stage coordinates. */
async function rightClickAt(x, y) {
    const pointer = await sharedPointer();
    await pointer.moveTo(x, y);
    for (const state of [Clutter.ButtonState.PRESSED, Clutter.ButtonState.RELEASED]) {
        pointer._device.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_SECONDARY, state);
        await wait(80);
    }
    await wait(400);
}

/** The open dock menu (src/dockMenu.ts), or null. */
const openedDockMenu = () => Main.uiGroup.get_children()
    .find(a => a.has_style_class_name?.('basedock-menu') && a.visible)?._delegate ?? null;

/** The dock's menu, opened with a real right-click at (x, y). */
async function openDockMenu(x, y) {
    await rightClickAt(x, y);
    return openedDockMenu();
}

/** Right-click the middle of `actor`. */
async function rightClick(actor) {
    const [x, y] = actor.get_transformed_position();
    await rightClickAt(Math.round(x + actor.width / 2), Math.round(y + actor.height / 2));
}

/**
 * Check that right-clicking Trash opens its own menu and that Empty Trash is
 * enabled only when there is something to empty. Leave the Files operation
 * uninvoked.
 */
async function checkTrashMenu(when, full) {
    const trash = ourDash()._trashIcon;
    await rightClick(trash.button);
    const menu = trash._menu;
    const labels = menu?._getMenuItems().map(i => i.label?.text).filter(Boolean) ?? [];
    check(`Trash menu (${when}): a right-click opens it, not the dock's menu`,
        menu?.isOpen === true && !openedDockMenu(), `open=${menu?.isOpen} labels=${labels}`);
    check(`Trash menu (${when}): Open and Empty Trash`,
        labels.join('|') === 'Open|Empty Trash', labels.join('|'));
    check(`Trash menu (${when}): Empty Trash is ${full ? 'available' : 'unavailable'}`,
        trash._emptyItem?.reactive === full, `reactive=${trash._emptyItem?.reactive}`);
    menu?.close();
    await settle();
}

/** The dock's menu opens from the keyboard too: the Menu key on Show Apps. */
async function testKeyboardMenu() {
    ourDash().showAppsButton.emit('popup-menu');
    await wait(400);
    const menu = Main.uiGroup.get_children()
        .find(a => a.has_style_class_name?.('basedock-menu') && a.visible)?._delegate;
    check('dock menu: opens with the Menu key on Show Apps', menu?.isOpen === true);
    menu?.close();
    await settle();
}

/**
 * Right-click a dock area outside the app items. Verify that its menu opens
 * above the pointer and can set the style.
 */
async function testDockMenu() {
    const handle = ourDash()._showAppsHandle.actor;
    const [x, y] = handle.get_transformed_position();
    const menu = await openDockMenu(Math.round(x + handle.width / 2), Math.round(y + handle.height / 2));
    check('dock menu: a right-click on the dock opens it, above the pointer',
        menu?.isOpen && menu._boxPointer._arrowSide === St.Side.BOTTOM,
        `open=${menu?.isOpen} arrowSide=${menu?._boxPointer._arrowSide}`);
    const item = menu?._getMenuItems().find(i => i.label?.text === 'Default');
    item?.activate(Clutter.get_current_event());
    await settle();
    check('dock menu: choosing Default makes the dock light',
        settings().get_string('style') === 'light' && ourDash().has_style_class_name('basedock-light'),
        `style=${settings().get_string('style')}`);
    settings().set_string('style', 'dark');
    await settle();
}

// A dock at the left or right edge (the position setting).

/** The dock background's box, stage px, rounded. */
function backgroundBox() {
    const {origin, size} = ourDash()._background.get_transformed_extents();
    return {
        x: Math.round(origin.x), y: Math.round(origin.y),
        width: Math.round(size.width), height: Math.round(size.height),
    };
}

/** x of a side dock's inner edge: where windows meet it. */
function innerEdge(side) {
    const bg = backgroundBox();
    return side === 'left' ? bg.x + bg.width : bg.x;
}

/** How far `window` reaches past a side dock's inner edge (negative: short of it). */
function pastEdge(window, side) {
    const r = window.get_frame_rect();
    return side === 'left' ? innerEdge(side) - r.x : r.x + r.width - innerEdge(side);
}

/** Move `window` so it ends `gap` px short of a side dock's inner edge, its top at `top`. */
async function placeBesideSide(window, side, gap, top) {
    const r = window.get_frame_rect();
    const x = side === 'left' ? innerEdge(side) + gap : innerEdge(side) - gap - r.width;
    window.move_frame(true, x, top);
    await settle();
}

/**
 * Start a Mutter grab at (pressX, pressY) and move the virtual pointer through
 * the given [dx, dy] offsets from that point. Call onStep(i) with the grab
 * held after each move and return the operation Mutter reported.
 */
async function dragWindow(window, op, pressX, pressY, offsets, onStep = () => {}) {
    const pointer = await sharedPointer();
    let grabOp = null;
    const id = global.display.connect('grab-op-begin', (_d, w, o) => {
        if (w === window)
            grabOp = o;
    });
    try {
        await pointer.moveTo(pressX, pressY);
        await pointer.press();
        const backend = global.stage.context.get_backend();
        window.begin_grab_op(op,
            backend.get_pointer_sprite(global.stage), global.get_current_time(),
            new Graphene.Point({x: pressX, y: pressY}));
        await wait(200);
        for (const [i, [dx, dy]] of offsets.entries()) {
            await pointer.moveTo(pressX + dx, pressY + dy);
            await wait(200);
            onStep(i);
        }
    } finally {
        await pointer.release();
        global.display.disconnect(id);
    }
    return grabOp;
}

/** Drag `actor` from its middle by (dx, dy), with a real pointer. */
async function dragActorBy(actor, dx, dy) {
    const [ax, ay] = actor.get_transformed_position();
    const [aw, ah] = actor.get_transformed_size();
    const x = Math.round(ax + aw / 2), y = Math.round(ay + ah / 2);
    const pointer = await sharedPointer();
    await pointer.moveTo(x, y);
    await pointer.press();
    for (let i = 1; i <= 4; i++)
        await pointer.moveTo(Math.round(x + dx * i / 4), Math.round(y + dy * i / 4));
    await pointer.release();
    await settle();
}

/** The dock at a side: a column at that edge of the work area, as the bottom one turned. */
async function checkSideLayout(side) {
    const container = dockContainer();
    const dash = ourDash();
    const m = Main.layoutManager.primaryMonitor;
    const wa = Main.layoutManager.getWorkAreaForMonitor(m.index);
    const [cx, cy] = container.get_transformed_position();
    check(`${side}: the dock is a strip at the ${side} edge of the work area`,
        Math.round(cy) === wa.y && Math.round(container.height) === wa.height &&
        (side === 'left'
            ? Math.round(cx) === m.x
            : Math.round(cx + container.width) === m.x + m.width),
        `x=${cx} y=${cy} ${container.width}x${container.height} work area y=${wa.y} h=${wa.height}`);
    const bg = backgroundBox();
    const edgeGap = side === 'left' ? bg.x - m.x : m.x + m.width - (bg.x + bg.width);
    const centerOffset = Math.round(bg.y + bg.height / 2 - (wa.y + wa.height / 2));
    check(`${side}: the background floats 8px from the screen edge, centered along it`,
        edgeGap === 8 && Math.abs(centerOffset) <= 1, `gap=${edgeGap} off center=${centerOffset}`);

    const column = dash._dashContainer.get_children();
    const ys = column.map(a => Math.round(a.get_transformed_position()[1]));
    check(`${side}: a column, top to bottom: Show Apps, handle, apps, handle, Trash`,
        dash._dashContainer.orientation === Clutter.Orientation.VERTICAL &&
        column.length === 5 && column[0] === dash._showAppsIcon && column[2] === dash._box &&
        column[4] === dash._trashIcon && ys.every((y, i) => i === 0 || y > ys[i - 1]),
        `ys=${ys}`);

    // As at the bottom (checkIconSpacing), turned: 16px apart down the
    // column, 15px inside the background across it, on both sides.
    const icons = appItems().map(i => i.child.icon.icon.get_transformed_extents());
    const children = dash._box.get_children();
    const gaps = appItems().slice(1)
        .map((item, i) => [item, i])
        .filter(([item, i]) => children.indexOf(item) === children.indexOf(appItems()[i]) + 1)
        .map(([, i]) => Math.round(icons[i + 1].origin.y - icons[i].origin.y - icons[i].size.height));
    const border = dash._background.get_theme_node().get_border_width(St.Side.LEFT);
    const insetLeft = Math.round(icons[0].origin.x - (bg.x + border));
    const insetRight = Math.round(bg.x + bg.width - border - (icons[0].origin.x + icons[0].size.width));
    check(`${side}: icons 16px apart, 15px inside the background on both sides`,
        gaps.length > 0 && gaps.every(g => g === 16) && insetLeft === 15 && insetRight === 15,
        `gaps=${gaps} insets=${insetLeft},${insetRight}`);

    checkDividersCentered(side);
    checkBlurOverBackground(side);

    const handle = dash._showAppsHandle;
    check(`${side}: the dividers are 1px lines across the column, as wide as the icons`,
        Math.round(handle.line.height) === 1 && Math.round(handle.line.width) === dash.iconSize,
        `line=${handle.line.width}x${handle.line.height}`);

    const appIcon = appItems().map(i => i.child).find(c => c._dot.visible);
    if (appIcon) {
        const [tx, ty] = appIcon.icon.get_transformed_position();
        const [dx, dy] = appIcon._dot.get_transformed_position();
        const gap = Math.round(side === 'left'
            ? tx - (dx + appIcon._dot.width)
            : dx - (tx + appIcon.icon.width));
        const offCenter = Math.round(dy + appIcon._dot.height / 2 - (ty + appIcon.icon.height / 2));
        check(`${side}: running dot 4px from the tile toward the screen edge, centered`,
            gap === 4 && Math.abs(offCenter) <= 1, `gap=${gap} off center=${offCenter}`);
    } else {
        report(`FAIL ${side}: running dot: no running app in the dock`);
    }

    const item = appItems()[0];
    item.showLabel();
    await wait(300);
    const label = item.label;
    const [lx, ly] = label.get_transformed_position();
    const [, iy] = item.get_transformed_position();
    const beside = side === 'left' ? lx >= bg.x + bg.width : lx + label.width <= bg.x;
    const labelOffCenter = Math.round(ly + label.height / 2 - (iy + item.height / 2));
    check(`${side}: an item's tooltip shows beside the dock, centered on it`,
        beside && Math.abs(labelOffCenter) <= 1,
        `label x=${lx} w=${label.width} background x=${bg.x}-${bg.x + bg.width} off center=${labelOffCenter}`);
    item.hideLabel();

    const grip = dash._edgeGrip;
    const [gx] = grip.get_transformed_position();
    const gripAtEdge = side === 'left'
        ? Math.round(gx + grip.width) === bg.x + bg.width
        : Math.round(gx) === bg.x;
    check(`${side}: the edge grip runs along the inner border, a vertical resize cursor`,
        gripAtEdge && grip.height > grip.width &&
        grip.cursor_type === Clutter.CursorType.NS_RESIZE,
        `grip x=${gx} ${grip.width}x${grip.height} background x=${bg.x}-${bg.x + bg.width}`);
}

/** Menus open beside a side dock: its own, the Trash's and an app's. */
async function checkSideMenus(side) {
    const arrow = side === 'left' ? St.Side.LEFT : St.Side.RIGHT;
    const handle = ourDash()._showAppsHandle.actor;
    const [x, y] = handle.get_transformed_position();
    const menu = await openDockMenu(Math.round(x + handle.width / 2), Math.round(y + handle.height / 2));
    const position = menu?._getMenuItems().find(i => i.label?.text === (side === 'left' ? 'Left' : 'Right'));
    check(`${side}: the dock menu opens beside the pointer, its position chosen`,
        menu?.isOpen && menu._boxPointer._arrowSide === arrow &&
        position?._ornament === PopupMenu.Ornament.DOT,
        `open=${menu?.isOpen} arrowSide=${menu?._boxPointer._arrowSide} ornament=${position?._ornament}`);
    menu?.close();
    await settle();

    const trash = ourDash()._trashIcon;
    await rightClick(trash.button);
    check(`${side}: the Trash menu opens beside the dock`,
        trash._menu?.isOpen && trash._menu._boxPointer._arrowSide === arrow,
        `arrowSide=${trash._menu?._boxPointer._arrowSide}`);
    trash._menu?.close();
    await settle();

    const appIcon = appItems()[0].child;
    await rightClick(appIcon);
    check(`${side}: an app's menu opens beside the dock`,
        appIcon._menu?.isOpen && appIcon._menu._boxPointer._arrowSide === arrow,
        `arrowSide=${appIcon._menu?._boxPointer._arrowSide}`);
    appIcon._menu?.close();
    await settle();
}

/** Vertical drags resize a side dock from either grip. */
async function checkSideResize(side) {
    const divider = ourDash()._trashHandle.actor;
    await dragActorBy(divider, side === 'left' ? 8 : -8, 0);
    check(`${side}: a horizontal drag leaves the dock size unchanged`,
        ourDash().iconSize === 48 && settings().get_int('icon-size') === 48);
    await dragActorBy(divider, 0, -8);
    check(`${side}: dragging a divider up grows the icons`,
        ourDash().iconSize === 56 && settings().get_int('icon-size') === 56,
        `iconSize=${ourDash().iconSize} setting=${settings().get_int('icon-size')}`);
    await checkResizeOutsideGrip(ourDash()._edgeGrip, 8);
    check(`${side}: dragging the inner border down shrinks the icons`,
        ourDash().iconSize === 48 && settings().get_int('icon-size') === 48,
        `iconSize=${ourDash().iconSize} setting=${settings().get_int('icon-size')}`);
    settings().set_int('icon-size', 48);
    await settle();
}

/** Windows meet a side dock's inner edge as they meet the bottom one's top. */
async function checkSideWindows(window, side) {
    const toward = side === 'left' ? -1 : 1;
    const bg = backgroundBox();
    const top = bg.y + 40;

    // Moving toward the dock: resistance at its edge (as testEdgeResistance).
    await placeBesideSide(window, side, 120, top);
    let r = window.get_frame_rect();
    const pressX = r.x + Math.round(r.width / 2), pressY = r.y + 12;
    const steps = [];
    const pasts = [-40, 10, 25, 60, 10];
    const grabOp = await dragWindow(window, Meta.GrabOp.MOVING, pressX, pressY,
        pasts.map(p => [toward * (120 + p), 0]), () => steps.push(pastEdge(window, side)));
    await settle();
    check(`${side}: edge resistance: free, held 10 and 25px past the edge, passes beyond 32px, free back`,
        grabOp === Meta.GrabOp.MOVING && JSON.stringify(steps) === JSON.stringify([-40, 0, 0, 60, 10]),
        `grabOp=${grabOp} past=${JSON.stringify(steps)}`);

    // Dragged on, fully behind the dock, with its titlebar beside it: it
    // stops with reachable(width) px still clear of the dock. Held by the
    // titlebar's far end, and not dragged all the way: a pointer at the
    // screen's edge would tile the window there (mutter's edge tiling).
    const behind = r => [[toward * (120 + r.width - reachable(r.width) + 60), 0]];
    const farEnd = r => (side === 'left' ? r.x + r.width - 20 : r.x + 20);
    await placeBesideSide(window, side, 120, top);
    r = window.get_frame_rect();
    await dragWindow(window, Meta.GrabOp.MOVING, farEnd(r), r.y + 12, behind(r));
    await settle();
    const past = pastEdge(window, side);
    check(`${side}: titlebar: a window dragged behind the dock keeps ${reachable(r.width)}px clear of it`,
        past === r.width - reachable(r.width) && !window.maximized_vertically,
        `past=${past} width=${r.width} tiled=${window.maximized_vertically}`);

    // Its titlebar above the dock: it may go further.
    const above = bg.y - reachable(r.height) - 20;
    await placeBesideSide(window, side, 120, above);
    r = window.get_frame_rect();
    await dragWindow(window, Meta.GrabOp.MOVING, farEnd(r), r.y + 12, behind(r));
    await settle();
    const pastAbove = pastEdge(window, side);
    check(`${side}: titlebar: above the dock, a window goes further behind it`,
        pastAbove > r.width - reachable(r.width), `past=${pastAbove} width=${r.width}`);

    // Resizing the edge facing the dock stops at it (as testResizeStop).
    await placeBesideSide(window, side, 100, top);
    r = window.get_frame_rect();
    const resizeOp = side === 'left' ? Meta.GrabOp.RESIZING_W : Meta.GrabOp.RESIZING_E;
    const borderX = side === 'left' ? r.x + 2 : r.x + r.width - 2;
    const resized = [];
    const resizeGrab = await dragWindow(window, resizeOp, borderX, r.y + Math.round(r.height / 2),
        [-30, 20, 60].map(p => [toward * (100 + p), 0]), () => resized.push(pastEdge(window, side)));
    await settle();
    check(`${side}: resize stop: free short of the edge, stops at it when dragged onto it`,
        resizeGrab === resizeOp && JSON.stringify(resized) === JSON.stringify([-30, 0, 0]) &&
        pastEdge(window, side) === 0,
        `grabOp=${resizeGrab} past=${JSON.stringify(resized)} final=${pastEdge(window, side)}`);
    window.move_resize_frame(true, r.x, r.y, 400, 240);
    await settle();

    // Hidden by a maximized window: slides out over its screen edge.
    window.maximize();
    await settle();
    const dash = ourDash();
    const out = side === 'left' ? -dockContainer().width : dockContainer().width;
    check(`${side}: a maximized window hides the dock, out over the screen edge`,
        !dash.visible && Math.round(dash.translation_x) === Math.round(out) && dash.translation_y === 0,
        `visible=${dash.visible} translation=${dash.translation_x},${dash.translation_y} expected x=${out}`);
    window.unmaximize();
    await settle();
    checkDock(`${side}: unmaximized`, 'shown');

    // Tiled to the dock's half: starts at the dock; to the other: untouched.
    const other = side === 'left' ? 'right' : 'left';
    const wa = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
    await superArrow(window, side);
    check(`${side}: a window tiled to the ${side} half ends at the dock`,
        window.maximized_vertically && pastEdge(window, side) === 0,
        `tiled=${window.maximized_vertically} past=${pastEdge(window, side)}`);
    await superArrow(window, other);
    r = window.get_frame_rect();
    const reachesEdge = other === 'right'
        ? r.x + r.width === wa.x + wa.width
        : r.x === wa.x;
    check(`${side}: a window tiled to the ${other} half takes its whole half`,
        window.maximized_vertically && reachesEdge && r.width === wa.width / 2,
        `tiled=${window.maximized_vertically} x=${r.x} width=${r.width}`);
    await superArrow(window, other);
    check(`${side}: untiled again`, !window.maximized_vertically);
    await checkMinimizeTarget(side, window);
    window.unminimize();
    window.activate(global.get_current_time());
    await settle();
}

/**
 * Check that the overview reserves the side dock's maximum width and that the
 * dock stays above it as interactive chrome.
 */
async function checkSideOverview(side, bottomDots) {
    await showOverview();
    const container = dockContainer();
    const controls = Main.overview._overview._controls;
    const m = Main.layoutManager.primaryMonitor;
    const box = controls.get_allocation_box();
    const [cx] = controls.get_transformed_position();
    check(`${side}: overview: the dock stays chrome above the overview`,
        container.get_parent() === Main.layoutManager.uiGroup,
        `parent=${container.get_parent()} stock dash height=${stockDash().height}`);
    // The active workspace, as the window picker shows it: as wide as its
    // height allows (workspace.js), which would reach under the dock.
    const workspace = controls._workspacesDisplay._workspacesViews[0]
        ._workspaces[global.workspace_manager.get_active_workspace_index()];
    const ws = workspace.get_transformed_extents();
    const wsOffCenter = Math.round(ws.origin.x + ws.size.width / 2 - (m.x + m.width / 2));
    const bg = backgroundBox();
    const clearance = Math.round(side === 'left'
        ? ws.origin.x - (bg.x + bg.width)
        : bg.x - (ws.origin.x + ws.size.width));
    const [searchX] = controls._searchEntry.get_transformed_position();
    const searchOffCenter = Math.round(searchX + controls._searchEntry.width / 2 - (m.x + m.width / 2));
    check(`${side}: overview: the window picker stays centered on the screen, clear of the dock`,
        Math.round(cx) === m.x && Math.round(box.get_width()) === m.width &&
        Math.abs(wsOffCenter) <= 1 && Math.abs(searchOffCenter) <= 1 && clearance > 0,
        `controls x=${cx} width=${box.get_width()} workspace=${rectString({
            x: Math.round(ws.origin.x), y: Math.round(ws.origin.y),
            width: Math.round(ws.size.width), height: Math.round(ws.size.height),
        })} off center=${wsOffCenter} clearance=${clearance} ` +
        `search off center=${searchOffCenter} dock=${rectString(bg)}`);
    const tile = appItems()[0].child.icon;
    const [tx, ty] = tile.get_transformed_position();
    const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE,
        Math.round(tx + tile.width / 2), Math.round(ty + tile.height / 2));
    check(`${side}: overview: an app tile still gets the pointer`,
        picked && ourDash().contains(picked), `picked=${picked}`);

    // The app grid's pages slide behind the dock to the screen edge, not
    // cut off beside it (src/overviewRoom.ts): its clips reach the edge.
    stockDash().showAppsButton.checked = true;
    await settle();
    const appDisplay = controls._appDisplay;
    checkPageDots(side, bottomDots);
    const [gridX] = appDisplay.get_transformed_position();
    check(`${side}: app grid: centered with 112px free on both sides`,
        Math.round(appDisplay.width) === m.width - 2 * 112 &&
        Math.round(gridX) === m.x + 112,
        `app grid x=${gridX} width=${appDisplay.width}`);
    // Where the grid's clips end at the dock's side, in stage x.
    const clipEdges = () => [appDisplay._scrollView, appDisplay._scrollView.get_parent()].map(actor => {
        const [ax] = actor.get_transformed_position();
        const [clipX, , clipWidth] = actor.get_clip();
        return Math.round(side === 'left' ? ax + clipX : ax + clipX + clipWidth);
    });
    const reaches = clipEdges();
    const screenEdge = side === 'left' ? m.x : m.x + m.width;
    check(`${side}: app grid: pages slide behind the dock to the screen edge`,
        !appDisplay._grid.clip_to_view && reaches.every(x => x === screenEdge),
        `clips reach ${reaches}, screen edge ${screenEdge}, grid clips to view: ${appDisplay._grid.clip_to_view}`);

    // While an icon is dragged in the grid, its drag hints and the next
    // page's icons stay off the dock: the grid clips as without it, and
    // after the drag as with it again. A drag shows and hides the hints
    // with these (appDisplay.js).
    const [pagesX] = appDisplay._scrollView.get_transformed_position();
    const gridEdge = Math.round(side === 'left' ? pagesX : pagesX + appDisplay._scrollView.width);
    appDisplay._appGridLayout.showPageIndicators();
    await wait(400);
    const duringDrag = clipEdges();
    appDisplay._appGridLayout.hidePageIndicators();
    await wait(600);
    const afterDrag = clipEdges();
    check(`${side}: app grid: while dragging in it, clipped at its edge; after, at the screen's`,
        duringDrag.every(x => x === gridEdge) && afterDrag.every(x => x === screenEdge) &&
        !appDisplay._grid.clip_to_view,
        `during=${duringDrag} after=${afterDrag} grid edge=${gridEdge} screen edge=${screenEdge} ` +
        `grid clips to view: ${appDisplay._grid.clip_to_view}`);
    stockDash().showAppsButton.checked = false;
    await settle();
    await hideOverview();
    await settle();
}

/** Drag the first icon down the column, between the third and fourth (as testReorder). */
async function checkSideReorder(side) {
    const favorites = AppFavorites.getAppFavorites();
    const before = favorites.getFavorites().map(a => a.get_id());
    const items = appItems();
    const center = item => {
        const [x, y] = item.child._delegate.icon.get_transformed_position();
        const [w, h] = item.child._delegate.icon.get_transformed_size();
        return [Math.round(x + w / 2), Math.round(y + h / 2)];
    };
    const [sx, sy] = center(items[0]);
    const [, y3] = center(items[2]);
    const [, y4] = center(items[3]);
    const dropY = Math.round(y4 - (y4 - y3) / 4);
    const inward = side === 'left' ? 1 : -1;

    const pointer = await sharedPointer();
    await pointer.moveTo(sx, sy);
    await pointer.press();
    await pointer.moveTo(sx + inward * 40, sy); // start the drag
    for (let i = 1; i <= 8; i++)
        await pointer.moveTo(sx + inward * 10, Math.round(sy + (dropY - sy) * i / 8));
    await wait(300);
    await pointer.release();
    await wait(1200);

    const after = favorites.getFavorites().map(a => a.get_id());
    const expected = [before[1], before[2], before[0], ...before.slice(3)];
    check(`${side}: reorder: an icon dropped down the column lands between the third and fourth`,
        JSON.stringify(after) === JSON.stringify(expected),
        `before=${before.slice(0, 4)} after=${after.slice(0, 4)}`);
    check(`${side}: reorder: every icon visible and at rest`,
        appItems().every(item => item.child.opacity === 255 &&
            item.translation_y === 0 && item.scale_y === 1),
        JSON.stringify(appItems().map(i => [i.child.opacity, i.translation_y, i.scale_y])));
    favorites.moveFavoriteToPos(before[0], 0);
    await settle();
}

/**
 * Snapshot the dock's items, icon size and background for first-frame
 * assertions.
 */
function dockFrame() {
    const dash = ourDash();
    const {origin, size} = dash._background.get_transformed_extents();
    return `${dash._side} ${appItems().length} apps, icon size ${dash.iconSize}, ` +
        `background ${rectString({x: Math.round(origin.x), y: Math.round(origin.y),
            width: Math.round(size.width), height: Math.round(size.height)})}`;
}

/** Run `action`, and resolve with dockFrame() as of the first frame painted after it. */
function firstFrameAfter(action) {
    return new Promise(resolve => {
        const id = global.stage.connect('after-paint', () => {
            global.stage.disconnect(id);
            resolve(dockFrame());
        });
        action();
    });
}

function pageDotsCenter() {
    const dots = Main.overview._overview._controls._appDisplay._pageIndicators;
    const {origin, size} = dots.get_transformed_extents();
    return [origin.x + size.width / 2, origin.y + size.height / 2].map(Math.round);
}

function checkPageDots(side, bottomDots) {
    const actual = pageDotsCenter();
    check(`${side}: app grid page dots stay at the bottom dock position`,
        actual.every((coordinate, i) => Math.abs(coordinate - bottomDots[i]) <= 1),
        `dots=${actual} bottom=${bottomDots}`);
}

/**
 * Move the dock to both sides and back to the bottom. Check that returning to
 * the bottom restores the overview changes made for a side dock.
 */
async function testSides(window) {
    const controls = Main.overview._overview._controls;
    const style = controls.style;
    const appGridStyle = controls._appDisplay.style;
    window.move_resize_frame(true, 600, 300, 400, 240);
    await settle();
    await showOverview();
    stockDash().showAppsButton.checked = true;
    await settle();
    const bottomDots = pageDotsCenter();
    await hideOverview();
    await settle();
    for (const side of ['left', 'right']) {
        const dash = ourDash();
        const firstFrame = firstFrameAfter(() => settings().set_string('position', side));
        await settle();
        check(`${side}: a new position builds a new dock there`,
            ourDash() !== dash && ourDash().has_style_class_name(`basedock-${side}`),
            `${ourDash()?.style_class}`);
        const first = await firstFrame;
        check(`${side}: the new dock's first frame is already the final dock (no flicker)`,
            first === dockFrame(), `first frame: ${first}; settled: ${dockFrame()}`);
        checkDock(`${side}: placed`, 'shown');
        await checkSideLayout(side);
        await checkSideMenus(side);
        await checkSideResize(side);
        await checkSideWindows(window, side);
        await checkSideOverview(side, bottomDots);
        await checkSideReorder(side);
    }

    settings().set_string('position', 'bottom');
    await settle();
    const container = dockContainer();
    const m = Main.layoutManager.primaryMonitor;
    const [, cy] = container.get_transformed_position();
    check('bottom again: the dock is back at the bottom, a row',
        Math.round(cy + container.height) === m.y + m.height && container.width === m.width &&
        ourDash()._dashContainer.orientation === Clutter.Orientation.HORIZONTAL,
        `bottom=${cy + container.height} width=${container.width}`);
    check('bottom again: the overview\'s controls are as before',
        controls.style === style && controls.clip_to_allocation && !controls.has_clip &&
        !Object.hasOwn(controls.layout_manager, '_updateWorkAreaBox') &&
        !Object.hasOwn(controls.layout_manager, '_computeWorkspacesBoxForState') &&
        controls.layout_manager._workAreaBox.x1 === 0 && controls.margin_left === 0 &&
        controls.margin_right === 0 &&
        controls._appDisplay._grid.clip_to_view && controls._appDisplay.margin_left === 0 &&
        controls._appDisplay.margin_right === 0 && controls._appDisplay.style === appGridStyle &&
        [controls._appDisplay._scrollView, controls._appDisplay._scrollView.get_parent()]
            .every(actor => actor.clip_to_allocation && !actor.has_clip),
        `style=${controls.style} clip=${controls.clip_to_allocation}/${controls.has_clip} ` +
        `work area x=${controls.layout_manager._workAreaBox.x1} ` +
        `margins=${controls.margin_left},${controls.margin_right}`);
}

const rectString = r => `${r.x},${r.y} ${r.width}x${r.height}`;

function testRestoration(window) {
    const stock = stockDash();
    const originalSize = stock.iconSize;
    const originalHeight = stock.height;
    const entries = Main.ctrlAltTabManager._items;
    const entry = entries.find(item => item.root === stock);
    const index = entries.indexOf(entry);
    const adjust = () => {};
    try {
        stock._adjustIconSize = adjust;
        stock.height = 72;
        stock._background.hide();
        new StockDashTakeover(() => 48).destroy();
        check('restore: stock size, height, visibility, sizing method and Ctrl+Alt+Tab entry',
            stock.iconSize === originalSize && stock.height === 72 &&
            !stock._background.visible && stock._adjustIconSize === adjust &&
            index >= 0 && entries[index] === entry);
    } finally {
        delete stock._adjustIconSize;
        stock.height = -1;
        stock._background.show();
    }
    check('restore: stock dash returns to its original height after removing the fixture',
        stock.height === originalHeight);

    const controls = Main.overview._overview._controls;
    const layout = controls.layout_manager;
    const compute = layout._computeWorkspacesBoxForState;
    const {_scrollView: scroll, _grid: grid} = controls._appDisplay;
    const originalClipToView = grid.clip_to_view;
    const clip = [1, 2, 100, 120];
    try {
        layout._computeWorkspacesBoxForState = compute.bind(layout);
        const ownCompute = layout._computeWorkspacesBoxForState;
        scroll.set_clip(...clip);
        grid.clip_to_view = false;
        new OverviewSideRoom().destroy();
        check('restore: overview keeps its prior method, explicit clip, and viewport clipping',
            layout._computeWorkspacesBoxForState === ownCompute && scroll.has_clip &&
            scroll.get_clip().every((value, i) => value === clip[i]) && !grid.clip_to_view);
    } finally {
        delete layout._computeWorkspacesBoxForState;
        scroll.remove_clip();
        grid.clip_to_view = originalClipToView;
    }

    const prior = new Mtk.Rectangle({x: 10, y: 20, width: 30, height: 40});
    const tile = new Mtk.Rectangle({x: 80, y: 90, width: 48, height: 48});
    try {
        window.set_icon_geometry(prior);
        const tracker = new MinimizeTarget(() => tile);
        window.notify('minimized');
        const [set, current] = window.get_icon_geometry();
        tracker.destroy();
        const [restored, geometry] = window.get_icon_geometry();
        check('restore: minimize target restores earlier icon geometry',
            set && current.equal(tile) && restored && geometry.equal(prior));

        const replaced = new MinimizeTarget(() => tile);
        window.notify('minimized');
        window.set_icon_geometry(prior);
        replaced.destroy();
        const [retained, newer] = window.get_icon_geometry();
        check('restore: minimize target preserves geometry supplied after ours',
            retained && newer.equal(prior));
    } finally {
        window.set_icon_geometry(null);
    }
}

/**
 * Read the window's icon geometry as it minimizes. Shell should animate toward
 * the app tile's resting position, even if the dock is moving.
 */
async function checkMinimizeTarget(name, window) {
    const tile = appItems().map(i => i.child).find(c => c.app.get_windows().includes(window))?.icon;
    const dash = ourDash();
    window.minimize();
    const [set, geometry] = window.get_icon_geometry();
    let expected = null;
    if (tile) {
        const {origin, size} = tile.get_transformed_extents();
        expected = {
            x: Math.round(origin.x - dash.translation_x), y: Math.round(origin.y - dash.translation_y),
            width: Math.round(size.width), height: Math.round(size.height),
        };
    }
    check(`${name}: a minimized window shrinks into its app's tile`,
        set && expected && rectString(geometry) === rectString(expected),
        `geometry=${set ? rectString(geometry) : 'none'} tile=${expected ? rectString(expected) : 'none'}`);
    await settle();
}

async function checkInterruptedDrag() {
    const dash = ourDash();
    const source = appItems()[0].child;
    Main.overview.beginItemDrag(source);
    const monitor = dash._dragMonitor;
    check('drag teardown: starting the drag registers its monitor', DND.dragMonitors.includes(monitor));
    try {
        settings().set_string('position', 'left');
        await settle();
        check('drag teardown: rebuilding unregisters the old monitor',
            ourDash() !== dash && !DND.dragMonitors.includes(monitor));
    } finally {
        Main.overview.endItemDrag(source);
        settings().set_string('position', 'bottom');
        await settle();
    }
}

function checkFailedPlacement() {
    const stock = stockDash();
    const actorOrder = Main.ctrlAltTabManager._items.map(item => item.root);
    const originalAddChrome = Main.layoutManager.addChrome;
    const descriptor = Object.getOwnPropertyDescriptor(Main.layoutManager, 'addChrome');
    const failure = new Error('baseDOCK test placement failure');
    Main.layoutManager.addChrome = function(actor, ...args) {
        if (actor.name === 'basedock-container')
            throw failure;
        originalAddChrome.call(this, actor, ...args);
    };
    try {
        let failed = false;
        try {
            new Dock({settings: settings(), side: 'left',
                showAppsGicon: new Gio.ThemedIcon({name: 'view-app-grid-symbolic'})});
        } catch (error) {
            if (error !== failure)
                throw error;
            failed = true;
        }
        check('failed enable: partial placement leaves no dock and restores the stock Dash',
            failed && !dockContainer() && stock.visible && stock._background.visible &&
            !stock.has_style_class_name('basedock-host') &&
            !Object.getOwnPropertyDescriptor(stock, 'iconSize')?.get &&
            Main.ctrlAltTabManager._items.length === actorOrder.length &&
            Main.ctrlAltTabManager._items.every((item, index) => item.root === actorOrder[index]));
    } finally {
        if (descriptor)
            Object.defineProperty(Main.layoutManager, 'addChrome', descriptor);
        else
            delete Main.layoutManager.addChrome;
    }
}

async function testSecondaryMonitor(window) {
    const primary = Main.layoutManager.primaryMonitor;
    const secondary = Main.layoutManager.monitors.find(monitor => monitor.x > primary.x);
    if (!secondary)
        throw new Error('The cross-monitor check requires a secondary monitor to the right');

    window.unmaximize();
    settings().set_string('position', 'right');
    await settle();
    const dock = backgroundBox();
    window.move_to_monitor(secondary.index);
    window.move_frame(true, secondary.x + 200, dock.y + 20);
    await settle();

    const start = window.get_frame_rect();
    const grab = await dragWindow(window, Meta.GrabOp.MOVING,
        start.x + 90, start.y + 15, [[10, 0]]);
    const end = window.get_frame_rect();
    check('monitor isolation: a right dock does not pull a window off the monitor to its right',
        grab === Meta.GrabOp.MOVING && start.x >= secondary.x && end.x === start.x + 10,
        `start=${start.x} end=${end.x} secondary edge=${secondary.x}`);

    await superArrow(window, 'left');
    const config = settings();
    config.set_int('icon-size', 56);
    await settle();
    check('monitor isolation: a tile on the secondary monitor does not cap dock growth',
        window.get_monitor() === secondary.index && window.maximized_vertically &&
        ourDash().iconSize === 56 && config.get_int('icon-size') === 56,
        `monitor=${window.get_monitor()} tiled=${window.maximized_vertically} size=${ourDash().iconSize} saved=${config.get_int('icon-size')}`);
}

async function main() {
    const window = await testWindow();
    await wait(500);
    await hideOverview();
    if (GLib.getenv('BASEDOCK_SECOND_MONITOR')) {
        await testSecondaryMonitor(window);
        return;
    }
    // Up front, so the app re-identification it causes is over (see
    // sharedPointer).
    await sharedPointer();
    await settle();

    // The checks of colors below are for the dark dock; testDockStyle and
    // testLightDock cover the others and return to it.
    settings().set_string('style', 'dark');
    await settle();

    // Starts maximized (test-window.js).
    check('test window is maximized', window.is_maximized());
    checkDock('maximized window', 'hidden');
    checkEnabledLayout('enabled');

    window.unmaximize();
    await settle();
    checkDock('unmaximized', 'shown');
    checkShowAppsSlot();
    checkDividersCentered('default size');
    checkBlurOverBackground('default size');
    checkCorners();
    checkIconSpacing();
    checkRunningDot();
    checkRunningTile();
    await testKeyboardMenu();
    await testDockMenu();
    await testTrash();
    await testResize();
    await checkEdgeGrip();
    await checkFillsScreen(28);
    await testSeparatorHandle();
    await testOverviewResize();
    await testDockStyle();
    await testLightDock();
    await testHighContrast();

    testRunningMarks(window);
    await testUnmatchedApp();

    // Out of the way of the dock for the drag test.
    window.move_frame(true, 0, 60);
    await settle();
    await testDragImage();
    await testReorder();
    await testDragBackToOwnSlot();
    await testOneStepRight();

    // Show Apps behaves as a toggle that returns to the desktop.
    await clickShowApps({name: 'desktop → app grid', overview: true, appGrid: true});
    await clickShowApps({name: 'app grid → desktop', overview: false, appGrid: false});
    await showOverview();
    await clickShowApps({name: 'window picker → app grid', overview: true, appGrid: true});
    await clickShowApps({name: 'app grid → desktop (from picker)', overview: false, appGrid: false});

    window.maximize();
    await settle();
    checkDock('maximized again', 'hidden');

    await showOverview();
    checkDock('overview with a maximized window', 'shown', {inOverview: true});
    checkOverviewStacking();
    await hideOverview();
    await settle();
    checkDock('back from overview to the maximized window', 'hidden');
    check('overview stacking: back on the desktop, the dock is chrome above windows',
        dockContainer()?.get_parent() === Main.layoutManager.uiGroup);

    // Dynamic workspaces: there's always an empty workspace after ours.
    await activateWorkspace(1);
    checkDock('switched to an empty workspace', 'shown');
    await activateWorkspace(0);
    checkDock('switched back to the maximized window', 'hidden');

    // The dock is hidden by the maximized window as it's minimized: the
    // window still shrinks to the tile's place, as the dock comes back.
    await checkMinimizeTarget('maximized, the dock hidden', window);
    checkDock('maximized window minimized', 'shown');
    window.unminimize();
    window.activate(global.get_current_time());
    await settle();
    checkDock('maximized window restored', 'hidden');

    window.unmaximize();
    await settle();
    window.make_fullscreen();
    await settle();
    checkDock('fullscreen window', 'hidden');
    window.unmake_fullscreen();
    await settle();
    checkDock('left fullscreen', 'shown');
    await testReducedMotion(window);

    // Tiled windows end at the dock's top, which stays shown.
    for (const half of ['left', 'right']) {
        await superArrow(window, half);
        const edge = dockEdge();
        checkDock(`window tiled to the ${half} half`, 'shown');
        check(`tiled to the ${half} half: the window ends at the dock's top`,
            window.maximized_vertically && frameBottom(window) === edge.y,
            `tiled=${window.maximized_vertically} bottom=${frameBottom(window)} dock top=${edge.y}`);
        if (half === 'left')
            await checkResizeBesideTile(window, ourDash()._trashHandle.actor);
    }
    await superArrow(window, 'right');
    check('untiled again', !window.maximized_vertically);

    await testEdgeResistance(window);
    await testResizeStop(window);

    // The dock at the left and the right edge, then back at the bottom.
    await testSides(window);
    await testWindowIndicator(window);
    await testWindowIndicatorOverflow(window);
    await testTransientWindowIndicator(window);
    await testWindowCycle(window);
    await checkInterruptedDrag();

    // Try teardown while Shell still owns the open popup's grab.
    const openTrash = ourDash()._trashIcon;
    await rightClick(openTrash.button);
    check('Trash teardown: menu is open before disable', openTrash._menu?.isOpen === true);
    Main.extensionManager.disableExtension(UUID);
    await settle();
    checkDisabledState();
    checkFailedPlacement();
    Main.extensionManager.enableExtension(UUID);
    await settle();

    // Disable while the dock is hidden, then re-enable: comes back hidden.
    window.maximize();
    await settle();
    Main.extensionManager.disableExtension(UUID);
    await settle();
    checkDisabledState();
    testRestoration(window);

    Main.extensionManager.enableExtension(UUID);
    await settle();
    checkDock('re-enabled with a maximized window', 'hidden');
    checkEnabledLayout('re-enabled');
    window.unmaximize();
    await settle();
    checkDock('re-enabled, unmaximized', 'shown');

    // Once more: from the second re-enable on, the first app's tile used
    // to keep the size of its initial 64px icon (src/iconGrow.ts).
    Main.extensionManager.disableExtension(UUID);
    await settle();
    Main.extensionManager.enableExtension(UUID);
    await settle();
    const tiles = appItems().map(i => `${i.child.icon.width}x${i.child.icon.height}`);
    check('re-enabled twice: every app tile has the same size',
        tiles.length > 1 && tiles.every(t => t === tiles[0]), tiles.join(' '));

    // The runner shuts down Shell with the tile constraint still attached.
    await superArrow(window, 'left');
    check('shutdown: a window is tiled when Shell exits', window.maximized_vertically);
    report('PASS finished scenario');
}

runAfterStartup(main);
