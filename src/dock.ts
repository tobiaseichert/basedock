// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import type Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import type Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DockBlur} from './blur.js';
import {BasedockDash, type BasedockDashInstance} from './dash.js';
import {DockEdge, type DockEdgeGeometry} from './dockEdge.js';
import {DockMenu} from './dockMenu.js';
import {DockStyle} from './dockStyle.js';
import {MaximizedWindowTracker} from './maximizedWindows.js';
import {MinimizeTarget} from './minimizeTarget.js';
import {OverviewSideRoom} from './overviewRoom.js';
import {isVertical, type DockSide} from './side.js';
import {StockDashTakeover} from './stockDash.js';

// Cap dock thickness at the stock dash's maximum. The default theme uses a
// 64px icon, 6px tile padding, 12px background padding and a 12px screen-edge
// margin, for 112 logical pixels. On small displays, apply the screen fraction
// used by overviewControls.js to the dimension across the dock. This cap can
// lower the preferred icon size.
const DASH_MAX_HEIGHT = 64 + 2 * 6 + 2 * 12 + 12;
const DASH_MAX_HEIGHT_RATIO = 0.16;

// Reserve this much room at each end of the work area so the dock clears
// screen corners and the top bar. The theme adds 6px of dash padding at each
// end, leaving 24px between the visible background and the work area's ends.
export const END_MARGIN = 18;

// Match DASH_ANIMATION_TIME for show and hide. Shell's ease() honors the
// animation slowdown factor and skips animations when they are disabled.
const HIDE_ANIMATION_TIME = 200;

/** What the dock needs from the extension (src/extension.ts). */
export interface DockOptions {
    /** The extension's settings (schemas/). */
    settings: Gio.Settings;
    /** The screen edge it sits at (the position setting). */
    side: DockSide;
    /** The Show Apps symbol. */
    showAppsGicon: Gio.Icon;
}

/**
 * Pin the actor to one edge, spanning the area's length at its preferred
 * thickness. On the desktop, use the primary monitor's work area to account
 * for panels. Inside the overview, use the parent allocation.
 *
 * A constraint updates position in the same layout pass as size. A height
 * notification repositioned the dock a frame later and caused jitter. The
 * constraint also lets a bottom dock extend upward from the stock dash while
 * the overview holds its height.
 */
const PinToEdge = GObject.registerClass({
    GTypeName: 'BasedockPinToEdge',
}, class PinToEdge extends Clutter.Constraint {
    _side: DockSide = 'bottom';

    override vfunc_update_allocation(actor: Clutter.Actor, box: Clutter.ActorBox) {
        const parent = actor.get_parent();
        const monitor = Main.layoutManager.primaryMonitor;
        if (!parent || !monitor)
            return;
        let {x, y, width, height} = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        if (parent !== Main.layoutManager.uiGroup) {
            const area = parent.get_allocation_box();
            [x, y, width, height] = [0, 0, area.get_width(), area.get_height()];
        }
        if (this._side === 'bottom') {
            const [, actorHeight] = actor.get_preferred_height(width);
            box.set_origin(x, y + height - actorHeight);
            box.set_size(width, actorHeight);
            return;
        }
        const [, actorWidth] = actor.get_preferred_width(height);
        box.set_origin(this._side === 'left' ? x : x + width - actorWidth, y);
        box.set_size(actorWidth, height);
    }
});

/**
 * Host the dash in a full-length strip along one edge of the primary monitor.
 * The strip reserves no work area, and clicks outside the dash pass through to
 * windows. Changing the configured edge rebuilds the dock.
 *
 * On the desktop, hide the dash for a non-minimized, maximized or fullscreen
 * normal window on the active workspace and primary monitor. Show it in the
 * overview. DockEdge handles resistance, resizing and tiling along the visible
 * inner edge.
 *
 * In the overview, the stock dash hosts a bottom dock and reserves its maximum
 * thickness so previews and app grid page dots stay in place as the dock
 * resizes. A side dock stays above the overview. OverviewRoom insets the
 * workspace and app grid symmetrically.
 */
export class Dock {
    readonly #container: St.Bin;
    readonly #dash: BasedockDashInstance;
    readonly #stock: StockDashTakeover;
    readonly #tracker: MaximizedWindowTracker;
    readonly #dockEdge: DockEdge;
    readonly #blur: DockBlur;
    readonly #style: DockStyle;
    readonly #menu: DockMenu;
    readonly #minimizeTarget: MinimizeTarget;
    readonly #side: DockSide;
    readonly #vertical: boolean;
    /** Room in the overview for a dock at a side; null at the bottom. */
    readonly #overviewRoom: OverviewSideRoom | null;
    #inOverview = Main.overview.visible;
    #hidden = false;
    #actorsDestroyed = false;
    /** Fit tiled windows to the dock once its new layout is done (#relayout). */
    #refitTiles = false;

    constructor({settings, side, showAppsGicon}: DockOptions) {
        this.#side = side;
        this.#vertical = isVertical(side);
        try {
            this.#dash = new BasedockDash(showAppsGicon, side);
            // Shell can tear down chrome before Mutter finishes handling
            // windows at logout. Its constraints may still ask for geometry.
            this.#dash.connect('destroy', () => (this.#actorsDestroyed = true));
            this.#dash.attachSettings(settings);

            this.#container = new St.Bin({
                name: 'basedock-container',
                style_class: 'basedock-container',
                child: this.#dash,
                reactive: false,
            });
            // Center the dash along the strip.
            if (this.#vertical)
                this.#dash.y_align = Clutter.ActorAlign.CENTER;
            else
                this.#dash.x_align = Clutter.ActorAlign.CENTER;
            const pin = new PinToEdge();
            pin._side = side;
            this.#container.add_constraint(pin);

            this.#stock = new StockDashTakeover(() => this.#dash.iconSize);
            this.#overviewRoom = side === 'bottom' ? null : new OverviewSideRoom();
            this.#setUpShowAppsButton();
            this.#style = new DockStyle(settings,
                withWallpaper => this.#syncLight(withWallpaper));
            this.#syncHighContrast();
            this.#syncLight(false, false);

            // Create the blur before placing the dock. Moving the dock into
            // the overview must first clear the blur's clone of that overview.
            this.#blur = new DockBlur(this.#dash._background,
                [this.#container, this.#dash]);
            this.#dash.placeOverBackground(this.#blur.layer);
            this.#placeInOverview(Main.overview.visible && !Main.overview.animationInProgress);

            Main.layoutManager.connectObject(
                'monitors-changed', () => this.#relayout(),
                this.#container);
            // The top bar, or another extension's panel, changes the work area.
            global.display.connectObject(
                'workareas-changed', () => this.#relayout(),
                this.#container);
            this.#relayout();
            // The dash's items and icon size, now that it knows its room.
            this.#dash.fillNow();

            // Show the dock when entering the overview. If a maximized window
            // is waiting on exit, hide it in step with the overview animation.
            Main.overview.connectObject(
                'showing', () => {
                    this.#inOverview = true;
                    this.#updateHidden();
                    this.#syncLight(false);
                },
                // Move below the previews after the transition. During the
                // animation, the workspace wallpaper expands over the dock's
                // area and would cover it.
                'shown', () => this.#placeInOverview(true),
                'hiding', () => {
                    this.#placeInOverview(false);
                    this.#inOverview = false;
                    this.#updateHidden();
                    this.#syncLight(false);
                },
                this.#container);

            // High Contrast (Settings → Accessibility): the shell swaps in its
            // high-contrast theme then (main.js), and the dock follows.
            St.Settings.get().connectObject('notify::high-contrast', () => {
                this.#dash.add_style_class_name('basedock-color-fade');
                this.#syncHighContrast();
                this.#syncLight(false);
            }, this.#container);
            this.#menu = new DockMenu(settings, this.#dash, side, this.#dash.showAppsButton,
                actor => this.#dash.hasOwnMenu(actor));

            this.#tracker = new MaximizedWindowTracker(() => {
                this.#updateHidden();
                this.#dockEdge.refreshTiles();
            });
            this.#updateHidden(false);

            this.#dockEdge = new DockEdge(side, () => this.#edgeGeometry(), () => this.#tileGeometry());
            // Refit tiled windows after automatic size changes and monitor
            // moves. During a manual resize, use tiled windows to cap dock
            // growth.
            this.#container.connectObject('notify::allocation', () => {
                if (!this.#refitTiles)
                    return;
                this.#refitTiles = false;
                this.#dockEdge.refreshTiles();
            }, this.#container);
            this.#dash.setGrowLimit(() => this.#dockEdge.roomBeforeTiles());
            this.#dash.onAutoSized(() => this.#dockEdge.refreshTiles());

            // Minimized windows shrink into their app's tile.
            this.#minimizeTarget = new MinimizeTarget(window => this.#tileOf(window));
        } catch (error) {
            this.destroy();
            throw error;
        }
    }

    /**
     * The tile's stage rectangle with the dash's slide offset removed,
     * so Shell can use the tile's resting position for icon geometry.
     * Return null if the app has no tile or the container is hidden.
     */
    #tileOf(window: Meta.Window): Mtk.Rectangle | null {
        if (this.#actorsDestroyed)
            return null;
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const appIcon = app && this.#dash._appIcons().find(icon => icon.app === app);
        if (!appIcon || !this.#container.visible)
            return null;
        const {origin, size} = appIcon.icon.get_transformed_extents();
        return new Mtk.Rectangle({
            x: Math.round(origin.x - this.#dash.translation_x),
            y: Math.round(origin.y - this.#dash.translation_y),
            width: Math.round(size.width),
            height: Math.round(size.height),
        });
    }

    /**
     * Place the dock in Main.uiGroup as chrome on the desktop, during overview
     * transitions and at all times for a side dock. PinToEdge aligns it with
     * the primary work area. The overview grabs the stage (overview.js), so
     * the dock can receive pointer input there.
     *
     * Once the overview is fully shown, move a bottom dock into the stock
     * dash. ControlsManager draws its workspaces after the dash, so window
     * previews and labels appear above it. The dock remains interactive as a
     * descendant of ControlsManager and keeps its screen position by pinning
     * to the bottom of the stock dash.
     */
    #placeInOverview(inOverview: boolean) {
        const container = this.#container;
        const parent = container.get_parent();
        const stock = this.#stock.dash;
        if (inOverview && !this.#vertical) {
            if (parent === stock)
                return;
            if (parent === Main.layoutManager.uiGroup)
                Main.layoutManager.removeChrome(container);
            else
                parent?.remove_child(container);
            // Remove the overview clone before reparenting. Otherwise it
            // becomes a descendant of its own source and Clutter recurses
            // while drawing it.
            this.#blur.setInsideOverview(true);
            stock.add_child(container);
            stock.show();
        } else {
            if (parent === Main.layoutManager.uiGroup)
                return;
            parent?.remove_child(container);
            // Hidden whenever it doesn't host the dock: it only lays out as
            // a spacer then.
            stock.hide();
            Main.layoutManager.addChrome(container);
            this.#blur.setInsideOverview(false);
        }
    }

    /**
     * Return the inner edge and span for move and resize constraints. Return
     * null while hidden, between the overview's showing and hiding signals, or
     * before geometry is available.
     */
    #edgeGeometry(): DockEdgeGeometry | null {
        if (this.#hidden || this.#inOverview)
            return null;
        return this.#geometry();
    }

    /**
     * Use the desktop dock edge for tiling, even while the overview shows.
     * This keeps tiled windows the same size across overview transitions.
     * Return null when a maximized window hides the desktop dock.
     */
    #tileGeometry(): DockEdgeGeometry | null {
        return this.#tracker.covered ? null : this.#geometry();
    }

    /**
     * Read the background's resting inner edge and span, excluding any slide
     * translation.
     */
    #geometry(): DockEdgeGeometry | null {
        if (this.#actorsDestroyed)
            return null;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this.#container.visible)
            return null;
        const {origin, size} = this.#dash._background.get_transformed_extents();
        const x = origin.x - this.#dash.translation_x;
        const y = origin.y - this.#dash.translation_y;
        const bounds = {x: Math.round(x), y: Math.round(y),
            width: Math.round(size.width), height: Math.round(size.height)};
        const side = this.#side;
        if (side === 'bottom') {
            return {side, edge: Math.round(y), start: Math.round(x),
                end: Math.round(x + size.width), monitor, bounds};
        }
        return {
            side,
            edge: Math.round(side === 'left' ? x + size.width : x),
            start: Math.round(y),
            end: Math.round(y + size.height),
            monitor, bounds,
        };
    }

    /**
     * Use the high-contrast dock style (.basedock-high-contrast,
     * stylesheet.css) while High Contrast is on, like the stock dash in
     * the shell's high-contrast theme: opaque, with a solid rim.
     */
    #syncHighContrast() {
        if (St.Settings.get().high_contrast)
            this.#dash.add_style_class_name('basedock-high-contrast');
        else
            this.#dash.remove_style_class_name('basedock-high-contrast');
    }

    /**
     * Apply the configured light or dark palette. Use dark in the overview and
     * with High Contrast to match GNOME Shell.
     *
     * St reads transition-duration from the incoming style. Update the palette
     * and duration class together so the fade follows the overview transition,
     * a menu change or, with `byWallpaper`, the wallpaper cross-fade.
     */
    #syncLight(byWallpaper: boolean, animate = true) {
        const light = this.#style.light && !this.#inOverview &&
            !St.Settings.get().high_contrast;
        if (light === this.#dash.has_style_class_name('basedock-light'))
            return;
        // A position rebuild starts with the final palette and no St
        // transition. Enable transitions on subsequent color changes.
        if (animate)
            this.#dash.add_style_class_name('basedock-color-fade');
        if (byWallpaper)
            this.#dash.add_style_class_name('basedock-wallpaper-fade');
        else
            this.#dash.remove_style_class_name('basedock-wallpaper-fade');
        if (light)
            this.#dash.add_style_class_name('basedock-light');
        else
            this.#dash.remove_style_class_name('basedock-light');
    }

    /**
     * Apply the desktop hide policy while keeping the dash visible in the
     * overview.
     */
    #updateHidden(animate = true) {
        this.#setHidden(!this.#inOverview && this.#tracker.covered, animate);
    }

    /**
     * Slide and fade the dash across the screen edge while leaving its
     * container in place. With reduced motion, use a fade and move the hidden
     * dash offscreen once the fade finishes.
     */
    #setHidden(hidden: boolean, animate: boolean) {
        if (hidden === this.#hidden)
            return;
        this.#hidden = hidden;

        const dash = this.#dash;
        const container = this.#container;
        const vertical = this.#vertical;
        const motion = St.Settings.get().reducedMotion !== St.ReducedMotion.REDUCE;
        // The translation along the dash's way out, as a property name
        // for ease(), and set directly.
        const key = vertical ? 'translationX' : 'translationY';
        const translate = (offset: number) => {
            if (vertical)
                dash.translation_x = offset;
            else
                dash.translation_y = offset;
        };
        dash.remove_transition(vertical ? 'translation-x' : 'translation-y');
        dash.remove_transition('opacity');

        if (hidden) {
            const [, thickness] = vertical
                ? container.get_preferred_width(-1)
                : container.get_preferred_height(-1);
            if (vertical)
                container.width = thickness;
            else
                container.height = thickness;
            const out = this.#side === 'left' ? -thickness : thickness;

            if (!animate) {
                translate(out);
                dash.opacity = 0;
                dash.hide();
                return;
            }
            dash.ease({
                ...motion ? {[key]: out} : {},
                opacity: 0,
                duration: HIDE_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: (finished: boolean) => {
                    if (!finished)
                        return;
                    translate(out);
                    dash.hide();
                },
            });
        } else {
            dash.show();
            if (vertical)
                container.width = -1;
            else
                container.height = -1;

            if (!animate) {
                translate(0);
                dash.opacity = 255;
                return;
            }
            if (!motion)
                translate(0);
            dash.ease({
                [key]: 0,
                opacity: 255,
                duration: HIDE_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    /**
     * Open the app grid from the desktop or window picker. A second click in
     * the app grid closes the overview and returns directly to the desktop.
     *
     * ControlsManager watches the stock Show Apps toggle. Drive that toggle
     * and mirror its checked state so the dock button stays highlighted
     * whenever the grid is open.
     */
    #setUpShowAppsButton() {
        const ours = this.#dash.showAppsButton;
        const stock = this.#stock.dash.showAppsButton;

        // We manage `checked` ourselves; don't let clicks flip it.
        ours.toggle_mode = false;
        ours.checked = stock.checked;

        ours.connect('clicked', () => {
            if (!Main.overview.visible)
                Main.overview.showApps();
            else if (stock.checked)
                Main.overview.hide();
            else
                stock.checked = true;
        });

        stock.connectObject(
            'notify::checked', () => (ours.checked = stock.checked),
            this.#container);
    }

    /**
     * Update the dash's space and the overview's clearance when monitors or
     * the work area change. Apply the end margins and thickness cap to the
     * primary work area. Refit tiled windows after the container's next
     * allocation.
     */
    #relayout() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        // As thick as the dock can get.
        const maxThickness = Math.min(DASH_MAX_HEIGHT * scaleFactor,
            Math.round((this.#vertical ? monitor.width : monitor.height) * DASH_MAX_HEIGHT_RATIO));
        const endMargins = 2 * END_MARGIN * scaleFactor;
        if (this.#overviewRoom) {
            this.#dash.setMaxSize(maxThickness, area.height - endMargins);
            // At a side, the centered app grid clears the dock; the stock
            // dash takes no room at the bottom.
            this.#stock.setHeight(0);
            this.#overviewRoom.setWidth(maxThickness);
        } else {
            this.#dash.setMaxSize(area.width - endMargins, maxThickness);
            // Reserve the maximum thickness in the stock dash. Its height sets
            // the overview's lower layout boundary (overviewControls.js), so a
            // fixed height keeps previews, the grid and its page dots steady
            // while the dock resizes.
            this.#stock.setHeight(maxThickness);
        }
        // Position and size follow from PinToEdge.
        this.#refitTiles = true;
        this.#container.queue_relayout();
    }

    destroy() {
        this.#actorsDestroyed = true;
        // This also rolls back a failed constructor. Keep the dash mapped
        // until its animations have been stopped by its destroy handler.
        for (const cleanup of [
            () => this.#menu?.destroy(),
            () => this.#style?.destroy(),
            () => this.#blur?.destroy(),
            () => this.#dockEdge?.destroy(),
            () => this.#minimizeTarget?.destroy(),
            () => this.#tracker?.destroy(),
            () => this.#overviewRoom?.destroy(),
            () => this.#stock?.destroy(),
            () => this.#dash?.destroy(),
            () => {
                const parent = this.#container?.get_parent();
                if (parent === Main.layoutManager.uiGroup)
                    Main.layoutManager.removeChrome(this.#container);
                else
                    parent?.remove_child(this.#container);
            },
            () => this.#container?.destroy(),
        ]) {
            try {
                cleanup();
            } catch (error) {
                console.error('baseDOCK: dock cleanup failed', error);
            }
        }
    }
}
