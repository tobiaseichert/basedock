// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import type {AppIcon} from 'resource:///org/gnome/shell/ui/appDisplay.js';
import {Dash, DashItemContainer} from 'resource:///org/gnome/shell/ui/dash.js';
import type {BaseIcon} from 'resource:///org/gnome/shell/ui/iconGrid.js';

import {
    appSlotLength, DEFAULT_ICON_SIZE, dockGrowthCap, fitDock, geometryAt, MAX_ICON_SIZE,
    MIN_ICON_SIZE, showAppsDividerShift, showAppsPadding, showAppsSymbolMargin,
    type DockMeasurements, type Geometry,
} from './geometry.js';
import {followIconGrow, iconGrowOf, resizeIcon, setUpGrowingIcon} from './iconGrow.js';
import {ResizeDrag, ResizeHandle, type ResizeTarget} from './resize.js';
import {isVertical, orientationOf, stSide, type DockSide} from './side.js';
import {ChildSlider} from './slide.js';
import {TrashIcon} from './trash.js';

// Use the stock dash's DASH_ANIMATION_TIME for item slides and drop
// animations.
const REORDER_ANIMATION_TIME = 200;

// If redisplay never reflects the drop, animate into the app's existing slot
// after this delay.
const LANDING_TIMEOUT_MS = 400;

// GNOME briefly represents an unmatched window as a window-backed app. Delay
// its dock item so a window that GNOME identifies shortly after opening does
// not cause an item to appear and disappear. Measure the delay per window
// because GNOME can replace the stand-in while matching the same window.
const UNMATCHED_APP_DELAY_MS = 1000;

// Style class that highlights the tile of a running app.
const RUNNING_CLASS = 'basedock-running';

// Match DASH_ITEM_LABEL_SHOW_TIME in dash.js when fading in tooltips.
const LABEL_SHOW_TIME = 150;

/** Tracks a dropped icon until it reaches its destination (acceptDrop). */
interface Landing {
    app: Shell.App;
    /** Reparents the drag image so it is no longer a direct child of Main.uiGroup. */
    layer: Clutter.Actor;
    image: Clutter.Actor;
    /** The drop placeholder, kept until the redisplay that reflects the drop. */
    placeholder: DashItemContainer | null;
    /** Set once the favorites have changed, i.e. the drop is applied. */
    applied: boolean;
    /** The target item's icon, hidden until the image arrives. */
    appIcon: AppIcon | null;
    /** Whether the target item was newly created for the drop. */
    recreated: boolean;
    timeline: Clutter.Timeline | null;
    timeoutId: number;
}

/** A dash item's button: an AppIcon, or Show Apps' toggle button. */
type IconButton = St.Widget & {_delegate: {icon: BaseIcon}};
const iconOf = (item: DashItemContainer) => (item.child as IconButton)._delegate.icon;

const easeOutQuad = (t: number) => 1 - (1 - t) * (1 - t);

/**
 * Center the tooltip beside a vertical dock, toward the center of the screen.
 * DashItemContainer.showLabel() in dash.js puts it above the item, where it
 * would cover its neighbor. Reuse the stock fade and apply the theme's tooltip
 * gap (-y-offset) horizontally.
 */
function showLabelBeside(item: DashItemContainer, side: DockSide) {
    const label = item.label;
    if (!item._labelText || !label)
        return;
    label.set_text(item._labelText);
    label.opacity = 0;
    label.show();

    const [stageX, stageY] = item.get_transformed_position();
    const [itemWidth, itemHeight] = item.allocation.get_size();
    const gap = label.get_theme_node().get_length('-y-offset');
    const x = side === 'left'
        ? stageX + itemWidth + gap
        : stageX - label.width - gap;
    const y = Math.min(Math.max(stageY + Math.floor((itemHeight - label.height) / 2), 0),
        global.stage.height - label.height);
    label.set_position(Math.round(x), y);
    label.ease({
        opacity: 255,
        duration: LABEL_SHOW_TIME,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
}

/**
 * Place the resize grip inside the background's inner edge, clear of the
 * rounded corners. LayoutManager.trackChrome() in js/ui/layout.js gives the
 * dock pointer input over its tracked area, so keeping the grip inside
 * preserves access to windows around it. The background is allocated before
 * the grip in the same pass.
 */
const EdgeGripPlacement = GObject.registerClass({
    GTypeName: 'BasedockEdgeGripPlacement',
}, class EdgeGripPlacement extends Clutter.Constraint {
    /** The dock background, its side and the grip's thickness; set by BasedockDash. */
    _background: St.Widget | null = null;
    _side: DockSide = 'bottom';
    _thickness: () => number = () => 0;

    override vfunc_update_allocation(_actor: Clutter.Actor, box: Clutter.ActorBox) {
        const background = this._background;
        if (!background)
            return;
        const bg = background.get_allocation_box();
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const radius = background.get_theme_node().get_border_radius(St.Corner.TOPLEFT);
        const thickness = this._thickness() * scaleFactor;
        const length = (isVertical(this._side) ? bg.get_height() : bg.get_width()) - 2 * radius;
        switch (this._side) {
            case 'left':
            box.init_rect(bg.x2 - thickness, bg.y1 + radius, thickness, Math.max(0, length));
                break;
            case 'right':
            box.init_rect(bg.x1, bg.y1 + radius, thickness, Math.max(0, length));
                break;
            default:
            box.init_rect(bg.x1 + radius, bg.y1, Math.max(0, length), thickness);
        }
    }
});

// St.Viewport uses the child's minimum size to determine its scroll bounds.
// DashIconsLayout in dash.js reports zero minimum width so the stock dash can
// shrink.
const OverflowRowLayout = GObject.registerClass({
    GTypeName: 'BasedockOverflowRowLayout',
}, class OverflowRowLayout extends Clutter.BinLayout {
    override vfunc_get_preferred_width(container: Clutter.Actor, forHeight: number): [number, number] {
        const [, natural] = super.vfunc_get_preferred_width(container, forHeight);
        return [natural, natural];
    }
});

/**
 * Extend the stock Dash (js/ui/dash.js) with a resizable row or column. Show
 * Apps and Trash flank the app list, and the dividers and inner edge serve as
 * resize handles. Running apps get highlighted tiles. Item moves and accepted
 * drops animate on the desktop as well as in the overview.
 *
 * Keep the widget name `dash` so GNOME's theme still applies. The `basedock`
 * class scopes the extension's stylesheet overrides.
 */
export const BasedockDash = GObject.registerClass({
    // GType names are shared across the shell process. Prefix the name to
    // avoid collisions with other extensions.
    GTypeName: 'BasedockDash',
}, class BasedockDash extends Dash implements ResizeTarget {
    // GObject calls _init() from the parent constructor before JavaScript
    // installs private fields or methods. Use declared fields and ordinary
    // methods for anything accessed during initialization.
    /** The screen edge the dock is at, and whether that makes it a column. */
    declare _side: DockSide;
    declare _vertical: boolean;
    declare _slider: ChildSlider;
    declare _showAppsHandle: ResizeHandle;
    declare _trashHandle: ResizeHandle;
    /** The stock separator between favorites and other running apps, as a handle. */
    declare _separatorHandle: ResizeHandle | null;
    declare _showAppsGicon: Gio.Icon;
    declare _preferredIconSize: number;
    declare _settings: Gio.Settings | null;
    declare _trashIcon: InstanceType<typeof TrashIcon>;
    /**
     * Creation time in milliseconds for windows opened after the dock was
     * created.
     */
    declare _windowsSince: WeakMap<Meta.Window, number>;
    declare _unmatchedTimeoutId: number;
    /** Pending fit scheduled after layout and before the next frame. */
    declare _refitLaterId: number;
    /** A child laid over the background (placeOverBackground), or null. */
    declare _overBackground: Clutter.Actor | null;
    /** Along the background's inner border: drag to resize (EdgeGripPlacement). */
    declare _edgeGrip: St.Widget;
    /** How far the dock may grow (stage px), e.g. before a tiled window. */
    declare _growLimit: () => number;
    /**
     * Current icon size or the destination of an in-progress size animation.
     */
    declare _targetIconSize: number;
    declare _sizeTimeline: Clutter.Timeline | null;
    /** Called once the dock has changed size by itself (onAutoSized). */
    declare _autoSized: () => void;
    /**
     * The active resize drag, including its starting size, allowed range and
     * pending size for the next frame. Null when idle.
     */
    declare _drag: {start: number, min: number, max: number, size: number, laterId: number} | null;

    #landing: Landing | null = null;
    #overflowView: St.ScrollView | null = null;

    /**
     * @param showAppsGicon replacement for the stock Show Apps grid. A file
     *   ending in -symbolic.svg takes its color from CSS.
     * @param side screen edge this dock occupies
     */
    override _init(showAppsGicon?: Gio.Icon, side: DockSide = 'bottom') {
        this._side = side;
        this._vertical = isVertical(side);
        this._preferredIconSize = DEFAULT_ICON_SIZE;
        this._settings = null;
        this._windowsSince = new WeakMap();
        this._unmatchedTimeoutId = 0;
        this._growLimit = () => Infinity;
        this._targetIconSize = 0;
        this._sizeTimeline = null;
        this._autoSized = () => {};
        this._drag = null;
        this._separatorHandle = null;
        this._showAppsGicon = showAppsGicon ??
            new Gio.ThemedIcon({name: 'view-app-grid-symbolic'});
        super._init();
        // Dash._redisplay() in dash.js assumes that one app moves at a time.
        // During removal animations, a bulk favorites update can otherwise
        // place the separator past the last child.
        const setChildIndex = this._box.set_child_at_index.bind(this._box);
        this._box.set_child_at_index = (child, index) => {
            if (child !== this._separator || index < this._box.get_n_children()) {
                setChildIndex(child, index);
                return;
            }
            const favorites = AppFavorites.getAppFavorites();
            const firstRunning = this._appItems().find(item =>
                !favorites.isFavorite((item.child as unknown as AppIcon).app.get_id()));
            if (firstRunning)
                this._box.set_child_below_sibling(child, firstRunning);
            else
                setChildIndex(child, -1);
        };
        this.add_style_class_name('basedock');
        // The stock dash uses offscreen rendering to fade as one image
        // (dash.js). St's soft shadow extends beyond the reported paint
        // bounds, so the offscreen buffer clips its outer edge. Use offscreen
        // rendering only during fades.
        this.offscreen_redirect = Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY;
        if (this._vertical)
            this._turnVertical();
        this._setUpShowApps();
        this._setUpTrash();
        this._setUpEdgeGrip();

        // Style running tiles with a class because St's :active state tracks a
        // press.
        global.display.connectObject('window-created', (_display: Meta.Display, window: Meta.Window) =>
            this._windowsSince.set(window, GLib.get_monotonic_time() / 1000), this);
        Shell.AppSystem.get_default().connectObject(
            'app-state-changed', () => this._syncRunning(), this);

        // Icons are resized to fixed actor sizes (see resizeIcon), which
        // depend on the scale factor.
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this._resizeIcons(), this);
        // A new monitor scale changes the dividers' thickness (_styleHandle).
        Main.layoutManager.connectObject('monitors-changed', () => this._applyGeometry(), this);

        // Fitting depends on theme lengths such as padding and borders. They
        // become available during layout and can change with the theme, so fit
        // again after allocation. Schedule one fit per frame to keep any
        // resulting resize out of the layout pass that requested it.
        this._refitLaterId = 0;
        this._overBackground = null;
        this.connect('notify::allocation', () => {
            if (this._refitLaterId)
                return;
            this._refitLaterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                this._refitLaterId = 0;
                this._adjustIconSize();
                return GLib.SOURCE_REMOVE;
            });
        });

        // Animate neighbors when the item list changes or the drop placeholder
        // moves. The stock dash animates item changes only in the overview.
        this._slider = new ChildSlider(this._box,
            () => this.#slotLength() / 2, REORDER_ANIMATION_TIME, this._vertical);
        this.connect('destroy', () => {
            // The inherited drag monitor is global (dash.js and dnd.js).
            const dash = this as unknown as {
                _dragMonitor?: Parameters<typeof DND.removeDragMonitor>[0],
            };
            if (dash._dragMonitor) {
                DND.removeDragMonitor(dash._dragMonitor);
                delete dash._dragMonitor;
            }
            if (this._drag?.laterId)
                global.compositor.get_laters().remove(this._drag.laterId);
            this._drag = null;
            if (this._refitLaterId)
                global.compositor.get_laters().remove(this._refitLaterId);
            this._sizeTimeline?.stop();
            if (this._unmatchedTimeoutId)
                GLib.source_remove(this._unmatchedTimeoutId);
            Shell.AppSystem.get_default().disconnectObject(this);
            global.display.disconnectObject(this);
            St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
            Main.layoutManager.disconnectObject(this);
            this._slider.destroy();
            this.#finishLanding();
        });
    }

    /**
     * Turn the stock dash's horizontal boxes, item alignment and background
     * sizer into a column (dash.js). Side-specific CSS moves the screen-edge
     * gap. _turnItem() and _createAppItem() handle each item's alignment,
     * tooltip and menu.
     */
    _turnVertical() {
        this.add_style_class_name('basedock-vertical');
        this.add_style_class_name(`basedock-${this._side}`);
        const container = this._dashContainer;
        container.orientation = orientationOf(this._side);
        container.x_align = Clutter.ActorAlign.FILL;
        container.x_expand = true;
        container.y_align = Clutter.ActorAlign.CENTER;
        container.y_expand = false;
        (this._box.layout_manager as Clutter.BoxLayout).orientation = orientationOf(this._side);
        this._box.x_expand = true;
        this._box.y_expand = false;

        const sizer = this._background.get_first_child();
        sizer?.clear_constraints();
        sizer?.add_constraint(new Clutter.BindConstraint({
            source: this._showAppsIcon.icon,
            coordinate: Clutter.BindCoordinate.WIDTH,
        }));
        sizer?.add_constraint(new Clutter.BindConstraint({
            source: container,
            coordinate: Clutter.BindCoordinate.HEIGHT,
        }));
    }

    /**
     * In a column, give the item the dock's full width and move its tooltip
     * beside it. The tile stays centered while the click target extends to the
     * screen edge, as it does in a row.
     */
    _turnItem(item: DashItemContainer) {
        if (!this._vertical)
            return;
        item.x_align = Clutter.ActorAlign.FILL;
        item.showLabel = () => showLabelBeside(item, this._side);
    }

    /**
     * Move Show Apps and its divider before the apps box. Its symbol and
     * padding occupy one tile's footprint, and drag-and-drop coordinates
     * remain relative to the apps box (dash.js).
     */
    _setUpShowApps() {
        const showApps = this._showAppsIcon;
        const container = this._dashContainer;
        container.set_child_at_index(showApps, 0);
        this._turnItem(showApps);

        // The divider is a resize handle (src/resize.ts); its line has the
        // stock separator's class, so it's styled alike.
        this._showAppsHandle = new ResizeHandle(this, this._side);
        this._showAppsHandle.setLength(this.iconSize);
        container.insert_child_above(this._showAppsHandle.actor, showApps);
        this._onIconSizeChanged(() => this._showAppsHandle.setLength(this.iconSize));

        // The symbol has no tile; it takes the tile's padding instead, so
        // it's as big as the tiles (see setUpGrowingIcon, showAppsPadding).
        // ShowAppsIcon keeps _iconActor for its drag-to-unpin hover state.
        setUpGrowingIcon(showApps.icon, () => this._showAppsGicon, 'show-apps-icon',
            icon => (showApps._iconActor = icon),
            size => geometryAt(size).footprint - 2 * showAppsPadding(size));
    }

    /**
     * Apply the icon-size-dependent gaps and radii from src/geometry.ts as
     * inline styles. Reapply them after an icon-size or monitor-scale change
     * and style new items as they are created. Swap the along-dock and
     * across-dock lengths in a column.
     */
    _applyGeometry() {
        const g = geometryAt(this.iconSize);
        this._background.style =
            `padding: ${this.#acrossAlong(g.backgroundPadding, g.endPadding)}; ` +
            `border-radius: ${g.backgroundRadius}px;`;
        this._showAppsIcon.icon.style = `padding: ${showAppsPadding(this.iconSize)}px;`;
        for (const handle of [this._showAppsHandle, this._trashHandle, this._separatorHandle])
            this._styleHandle(handle, g);
        this._styleShowAppsDivider(g);
        this._styleTile(this._trashIcon.button, this._trashIcon.icon, g);
        for (const appIcon of this._appIcons())
            this._styleAppIcon(appIcon, g);
    }

    /** A CSS `padding`/`margin` value: `across` the dock, and `along` it. */
    #acrossAlong(across: number, along: number): string {
        return this._vertical ? `${along}px ${across}px` : `${across}px ${along}px`;
    }

    /**
     * Center the divider between the drawn Show Apps symbol and the first app
     * icon. On the app side, the distance includes the divider padding, item
     * margin and tile padding. On the Show Apps side, it includes the symbol's
     * padding and transparent margin.
     *
     * BaseIcon stays square (iconGrid.js), so adjust the space next to the
     * divider. Subtract any excess from the divider's padding on the Show
     * Apps side, or add a margin to fill a shortfall. Clear the stock margin
     * because it would add an extra gap. Show Apps precedes the divider,
     * including in right-to-left rows.
     */
    _styleShowAppsDivider(g: Geometry) {
        const shift = showAppsDividerShift(this.iconSize, g);
        let [before, after] = ['left', 'right'];
        if (this._vertical)
            [before, after] = ['top', 'bottom'];
        else if (this.get_text_direction() === Clutter.TextDirection.RTL)
            [before, after] = ['right', 'left'];
        this._showAppsHandle.actor.style =
            `padding: ${this.#acrossAlong(0, this.#handlePadding(g))}; ` +
            `padding-${before}: ${g.handlePadding - Math.max(0, shift)}px;`;
        this._showAppsIcon.child.style =
            `margin-${before}: 0; margin-${after}: ${Math.max(0, -shift)}px;`;
    }

    /**
     * Add the Show Apps symbol's transparent margin to the divider's grab
     * padding on app and Trash sides. This gives dividers the same visual
     * separation from the drawn icons.
     */
    #handlePadding(g: Geometry): number {
        return g.handlePadding + showAppsSymbolMargin(this.iconSize, g);
    }

    /**
     * Apply the grab padding and rendered line thickness when a divider
     * exists.
     */
    _styleHandle(handle: ResizeHandle | null | undefined, g: Geometry) {
        if (!handle)
            return;
        handle.actor.style = `padding: ${this.#acrossAlong(0, this.#handlePadding(g))};`;
        handle.setThickness(this.#lineThickness());
    }

    /**
     * Round the stylesheet's 1px divider to the nearest whole physical pixel,
     * with a minimum of one. A fractional physical width can cover different
     * numbers of pixel centers depending on where each divider lands. Rounding
     * makes their visible widths match while keeping the layout width at 1px.
     *
     * Convert the physical width back to stage pixels using the primary
     * monitor scale divided by St's scale factor. In GNOME's logical layout
     * mode, St's factor stays at 1 for fractional scales.
     */
    #lineThickness(): number {
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const monitorScale = global.display.get_monitor_scale(Main.layoutManager.primaryIndex);
        const pixels = Math.max(1, Math.round(monitorScale));
        return pixels * scaleFactor / monitorScale;
    }

    /**
     * Style a tile (an app's or the Trash's) at geometry `g`: the margins
     * of `button` along the dock, and the padding and corners of `tile`.
     */
    _styleTile(button: St.Widget, tile: St.Widget, g: Geometry) {
        button.style = `margin: ${this.#acrossAlong(0, g.itemMargin)};`;
        tile.style = `padding: ${g.tilePadding}px; border-radius: ${g.tileRadius}px;`;
    }

    /**
     * Style the running dot at g.dotGap from the tile toward the screen edge.
     * In a row, AppIcon anchors it to the icon container's bottom
     * (appDisplay.js), P plus the background border below the tile. Offset it
     * upward with _updateDotStyle().
     *
     * In a column, anchor it to the container's screen-edge side and translate
     * it toward the tile. AppIcon provides only a vertical offset. Compensate
     * for Clutter swapping START and END in right-to-left layouts so the dot
     * stays on the physical screen-edge side.
     */
    _styleAppIcon(appIcon: AppIcon, g: Geometry) {
        this._styleTile(appIcon, appIcon.icon, g);
        // The background's border (stylesheet.css: only with High
        // Contrast), once it's styled.
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const border = this._background.get_stage()
            ? this._background.get_theme_node().get_border_width(stSide(this._side)) / scaleFactor
            : 0;
        const offset = g.dotGap - (g.backgroundPadding + border - g.dotSize);
        const dot = appIcon._dot;
        const size = `width: ${g.dotSize}px; height: ${g.dotSize}px; ` +
            `border-radius: ${Math.ceil(g.dotSize / 2)}px;`;
        if (!this._vertical) {
            dot.style = `${size} offset-y: ${offset}px;`;
            return;
        }
        dot.style = `${size} offset-y: 0;`;
        const rtl = dot.get_text_direction() === Clutter.TextDirection.RTL;
        dot.x_align = (this._side === 'left') !== rtl
            ? Clutter.ActorAlign.START : Clutter.ActorAlign.END;
        dot.y_align = Clutter.ActorAlign.CENTER;
        dot.translation_x = (this._side === 'left' ? -offset : offset) * scaleFactor;
    }

    /**
     * Add a resize grip along the inner edge. Add it last so the pointer picks
     * it above nearby items.
     */
    _setUpEdgeGrip() {
        this._edgeGrip = new St.Widget({name: 'basedock-edge-grip'});
        const placement = new EdgeGripPlacement();
        placement._background = this._background;
        placement._side = this._side;
        // Half the background's padding: clear of the icons' tiles.
        placement._thickness = () =>
            Math.max(1, Math.round(geometryAt(this.iconSize).backgroundPadding / 2));
        this._edgeGrip.add_constraint(placement);
        new ResizeDrag(this._edgeGrip, this, this._side);
        this.add_child(this._edgeGrip);
    }

    /**
     * Add Trash and its divider after the apps. Set up its size, tooltip and
     * menu explicitly because the stock Dash only manages app items.
     */
    _setUpTrash() {
        const container = this._dashContainer;
        this._trashHandle = new ResizeHandle(this, this._side);
        this._trashHandle.setLength(this.iconSize);
        this._trashIcon = new TrashIcon();
        this._trashIcon.setMenuSide(stSide(this._side));
        this._turnItem(this._trashIcon);
        container.add_child(this._trashHandle.actor);
        container.add_child(this._trashIcon);
        this._trashIcon.icon.setIconSize(this.iconSize);
        this._trashIcon.show(false); // DashItemContainers start at scale 0
        this._hookUpLabel(this._trashIcon);
        // Its menu hides the tooltip, as an app's does (_createAppItem in
        // dash.js; _itemMenuStateChanged isn't in the typings).
        const dash = this as unknown as {_itemMenuStateChanged(item: unknown, opened: boolean): void};
        const connect = this._trashIcon.connect.bind(this._trashIcon) as unknown as
            (signal: string, callback: (icon: unknown, opened: boolean) => void) => number;
        connect('menu-state-changed', (_icon, opened) =>
            dash._itemMenuStateChanged(this._trashIcon, opened));

        // The icon itself is resized by _resizeIcons().
        this._onIconSizeChanged(() => this._trashHandle.setLength(this.iconSize));
    }

    /**
     * Call `callback` whenever the icon size changes. 'icon-size-changed'
     * is the Dash's own signal (dash.js), missing from the typings.
     */
    _onIconSizeChanged(callback: () => void) {
        const connect = this.connect.bind(this) as
            (signal: string, callback: () => void) => number;
        connect('icon-size-changed', callback);
    }

    /**
     * Length of an app item along the dock, in stage px: its tile and the
     * margins beside it. The drop placeholder takes it (handleDragOver).
     */
    #slotLength(): number {
        const g = geometryAt(this.iconSize);
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        return appSlotLength(this.iconSize, g) * scaleFactor;
    }

    /** The app items currently in the dock (not ones animating out). */
    _appItems(): DashItemContainer[] {
        return (this._box.get_children() as unknown as DashItemContainer[])
            .filter(item => !item.animatingOut &&
                (item.child as unknown as AppIcon | null)?.app);
    }

    /**
     * Populate and fit the dock before its first paint. The stock Dash defers
     * redisplay until it is mapped (Main.initializeDeferredWork in main.js),
     * which would briefly show only Show Apps and Trash at the initial size.
     * The stock _shownInitially check in dash.js already skips the first item
     * animation.
     */
    fillNow() {
        this._redisplay();
    }

    /**
     * Allocate `actor` to the dock background's bounds on every layout. The
     * blur actor uses this hook and clears it on destruction.
     *
     * BinLayout allocates children in order. The blur is drawn below the
     * background and is allocated first, so a BindConstraint would read the
     * previous background bounds. Reallocate after the background to keep the
     * blur aligned through a resize.
     */
    placeOverBackground(actor: Clutter.Actor) {
        this._overBackground = actor;
        actor.connectObject('destroy', () => {
            if (this._overBackground === actor)
                this._overBackground = null;
        }, this);
        this.queue_relayout();
    }

    override vfunc_allocate(box: Clutter.ActorBox) {
        super.vfunc_allocate(box);
        this._overBackground?.allocate(this._background.get_allocation_box());
    }

    /** The app icons currently in the dock (not ones animating out). */
    _appIcons(): AppIcon[] {
        return this._appItems().map(item => item.child as unknown as AppIcon);
    }

    /**
     * Mark running apps' tiles, by GNOME's own app state, as the stock
     * running dot does (AppIcon._updateRunningStyle, appDisplay.js).
     */
    _syncRunning() {
        for (const appIcon of this._appIcons())
            this._syncRunningIcon(appIcon);
    }

    _syncRunningIcon(appIcon: AppIcon) {
        if (appIcon.app.state === Shell.AppState.RUNNING)
            appIcon.add_style_class_name(RUNNING_CLASS);
        else
            appIcon.remove_style_class_name(RUNNING_CLASS);
    }

    /**
     * Adapt the stock app item from dash.js to the dock's orientation, tile
     * styling and drag image. If an accepted drop creates this item, give it
     * its final size immediately and hide its icon until the drag image
     * arrives.
     */
    override _createAppItem(app: Shell.App) {
        const item = super._createAppItem(app);
        const appIcon = item.child as unknown as AppIcon;
        this._turnItem(item);
        // Its menu opens away from the screen edge; the stock DashIcon's
        // opens upwards (popupMenuSide, dash.js), read when the menu is
        // first created (AppIcon.popupMenu, appDisplay.js).
        (appIcon as unknown as {_popupMenuSide: St.Side})._popupMenuSide = stSide(this._side);
        // Icons grow into their tile's padding (src/geometry.ts).
        followIconGrow(appIcon.icon, size => geometryAt(size).iconGrow);
        this.#dragWithTile(appIcon);
        this._syncRunningIcon(appIcon);
        this._styleAppIcon(appIcon, geometryAt(this.iconSize));

        const landing = this.#landing;
        if (landing?.applied && landing.app === app && !landing.appIcon) {
            landing.appIcon = appIcon;
            landing.recreated = true;
            // Take the placeholder's place at full size right away (no
            // zoom-in; the landing image is the arrival animation), with
            // the icon hidden until the image arrives.
            item.set_scale(1, 1);
            item.opacity = 255;
            appIcon.opacity = 0;
            appIcon.icon.connectObject('notify::allocation', () => {
                if (appIcon.icon.width > 0)
                    this.#flyIn(landing);
            }, this);
        }
        return item;
    }

    /**
     * Adapt stock drag-over handling from dash.js. Give the placeholder a full
     * item slot, including its margins, and count it during fitting so the
     * dock makes room before the drop. Use vertical coordinates in a column.
     *
     * A favorite dropped back into its own slot is accepted by GNOME. Return
     * the matching drop feedback even when the stock implementation removes
     * the placeholder and reports CONTINUE or NO_DROP.
     */
    override handleDragOver(...args: Parameters<Dash['handleDragOver']>) {
        const hadPlaceholder = !!this._dragPlaceholder;
        const [source, , x, y] = args;
        const result = this._vertical
            ? this.#dragOverColumn(source, y)
            : super.handleDragOver(...args);
        const placeholder = this._dragPlaceholder?.child;
        if (this._vertical)
            placeholder?.set_height(this.#slotLength());
        else
            placeholder?.set_width(this.#slotLength());
        if (!!this._dragPlaceholder !== hadPlaceholder)
            this._adjustIconSize();
        if (result !== DND.DragMotionResult.MOVE_DROP && this.#overOwnSlot(source, x, y))
            return DND.DragMotionResult.MOVE_DROP;
        return result;
    }

    /**
     * Find the slot at `pos` along the apps box, following handleDragOver() in
     * dash.js. Divide the length evenly among the items after accounting for
     * the placeholder and separator. Return null while the box has no length.
     */
    #slotAt(pos: number): number | null {
        const lengthOf = (actor: Clutter.Actor) => this._vertical ? actor.height : actor.width;
        let count = this._box.get_n_children();
        let length = lengthOf(this._box);
        for (const actor of [this._dragPlaceholder, this._separator]) {
            if (actor) {
                length -= lengthOf(actor);
                count--;
            }
        }
        if (length <= 0)
            return null;
        const slot = Math.floor(pos * count / length);
        return !this._vertical && this.text_direction === Clutter.TextDirection.RTL
            ? count - slot : slot;
    }

    /**
     * Apply the stock favorite insertion rules from handleDragOver() in
     * dash.js using y coordinates. A placeholder can go between favorites or
     * after the last one. The slots immediately before and after the dragged
     * favorite count as its current position. Build the placeholder from a
     * .placeholder bin because dash.js keeps DragPlaceholderItem private.
     */
    #dragOverColumn(source: Parameters<Dash['handleDragOver']>[0], y: number): DND.DragMotionResult {
        const app = Dash.getAppFromSource(source);
        if (!app || app.is_window_backed() ||
            !global.settings.is_writable('favorite-apps'))
            return DND.DragMotionResult.NO_DROP;
        const favorites = AppFavorites.getAppFavorites().getFavorites();
        const favPos = favorites.indexOf(app);
        // Private Dash state (dash.js).
        const stock = this as unknown as {
            _emptyDropTarget: unknown,
            _animatingPlaceholdersCount: number,
        };
        const pos = Math.min(stock._emptyDropTarget ? 0 : this.#slotAt(y) ?? 0,
            favorites.length);

        if (pos !== this._dragPlaceholderPos && stock._animatingPlaceholdersCount === 0) {
            this._dragPlaceholderPos = pos;
            if (favPos !== -1 && (pos === favPos || pos === favPos + 1)) {
                this._clearDragPlaceholder();
                return DND.DragMotionResult.CONTINUE;
            }
            // Animate the first placeholder in. Replace it immediately when
            // it moves to another slot.
            const fadeIn = !this._dragPlaceholder;
            this._dragPlaceholder?.destroy();
            const placeholder = new DashItemContainer();
            placeholder.setChild(new St.Bin({style_class: 'placeholder'}));
            placeholder.child.set_width(this.iconSize);
            this._turnItem(placeholder);
            this._box.insert_child_at_index(placeholder, pos);
            placeholder.show(fadeIn);
            this._dragPlaceholder = placeholder;
        }
        return this._dragPlaceholder
            ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.NO_DROP;
    }

    /**
     * Check whether the pointer is immediately before or after the dragged
     * favorite. Both positions count as dropping it back into its own slot.
     */
    #overOwnSlot(source: Parameters<Dash['handleDragOver']>[0], x: number, y: number): boolean {
        const app = Dash.getAppFromSource(source);
        if (!app || app.is_window_backed() ||
            !global.settings.is_writable('favorite-apps'))
            return false;
        const favorites = AppFavorites.getAppFavorites().getFavorites();
        const favPos = favorites.indexOf(app);
        if (favPos === -1)
            return false;
        const slot = this.#slotAt(this._vertical ? y : x);
        if (slot === null)
            return false;
        const pos = Math.min(slot, favorites.length);
        return pos === favPos || pos === favPos + 1;
    }

    /**
     * Take over the image for an accepted drop while it is still a direct
     * child of Main.uiGroup. Reparenting gives baseDOCK control of the
     * animation; dnd.js otherwise handles the image. The target can be a new
     * tile or the app's existing one.
     */
    override acceptDrop(...args: Parameters<Dash['acceptDrop']>) {
        const [source, image] = args;
        const placeholder = this._dragPlaceholder;
        const accepted = super.acceptDrop(...args);
        const app = Dash.getAppFromSource(source);
        if (!accepted || !app || image?.get_parent() !== Main.uiGroup)
            return accepted;
        const landing = this.#beginLanding(app, image, placeholder);
        if (!placeholder)
            this.#settleLanding(landing);
        return accepted;
    }

    /**
     * Replace any pending drop animation and reparent the image without
     * changing its screen position. The favorites change marks the drop as
     * applied. If redisplay does not settle it, LANDING_TIMEOUT_MS triggers
     * the fallback.
     */
    #beginLanding(app: Shell.App, image: Clutter.Actor,
        placeholder: DashItemContainer | null): Landing {
        this.#finishLanding();

        const [x, y] = image.get_transformed_position();
        const layer = new Clutter.Actor({reactive: false});
        Main.uiGroup.add_child(layer);
        Main.uiGroup.remove_child(image);
        layer.add_child(image);
        image.set_position(x, y);

        const landing: Landing = {
            app, layer, image, placeholder, applied: false, appIcon: null,
            recreated: false, timeline: null, timeoutId: 0,
        };
        // acceptDrop() changes the favorites in a later; the redisplay that
        // follows is the one that reflects the drop (see _redisplay).
        AppFavorites.getAppFavorites().connectObject('changed', () => {
            landing.applied = true;
        }, layer);
        landing.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            LANDING_TIMEOUT_MS, () => {
                landing.timeoutId = 0;
                this.#settleLanding(landing);
                return GLib.SOURCE_REMOVE;
            });
        this.#landing = landing;
        return landing;
    }

    /**
     * Keep the accepted drop's placeholder until redisplay can hand its space
     * to the destination item. The stock drag-end handler removes it
     * immediately, which would close and reopen the gap.
     */
    override _clearDragPlaceholder() {
        if (this.#landing && this._dragPlaceholder === this.#landing.placeholder) {
            this._dragPlaceholder = null as unknown as typeof this._dragPlaceholder;
            this._dragPlaceholderPos = -1;
            return;
        }
        const hadPlaceholder = !!this._dragPlaceholder;
        super._clearDragPlaceholder();
        // It no longer counts (handleDragOver).
        if (hadPlaceholder)
            this._adjustIconSize();
    }

    /**
     * Run stock redisplay from dash.js with the running-app list filtered to
     * delay unmatched windows. When the overview is closed, temporarily report
     * it as visible and idle so the stock code animates item changes on the
     * desktop. During actual overview transitions, the stock animation rules
     * apply.
     *
     * Synchronous callbacks triggered by redisplay can see the temporary
     * values. The finally block restores the app system and each overview
     * property even if the redisplay fails.
     */
    override _redisplay() {
        const overview = Main.overview;
        const stock = this as unknown as {_appSystem: Shell.AppSystem};
        const appSystem = stock._appSystem;
        const running = this.#runningToShow(appSystem.get_running());
        const previous = new Map<string, PropertyDescriptor | undefined>();
        const restoreOverview = () => {
            for (const [key, descriptor] of previous) {
                if (descriptor)
                    Object.defineProperty(overview, key, descriptor);
                else
                    Reflect.deleteProperty(overview, key);
            }
            previous.clear();
        };

        try {
            if (!overview.visible) {
                try {
                    for (const [key, value] of [['visible', true], ['animationInProgress', false]] as const) {
                        const descriptor = Object.getOwnPropertyDescriptor(overview, key);
                        Object.defineProperty(overview, key, {configurable: true, get: () => value});
                        previous.set(key, descriptor);
                    }
                } catch {
                    // Another owner can make an override unavailable.
                    restoreOverview();
                }
            }
            stock._appSystem = {get_running: () => running} as unknown as Shell.AppSystem;
            super._redisplay();
        } finally {
            stock._appSystem = appSystem;
            restoreOverview();
        }

        this._makeSeparatorDraggable();
        if (this.#landing?.applied)
            this.#settleLanding(this.#landing);
    }

    /**
     * Defer a window-backed app while every one of its windows is newer than
     * UNMATCHED_APP_DELAY_MS. Windows already open when the dock starts count
     * as old. One shared timeout queues a redisplay, which can schedule
     * another retry if needed.
     */
    #runningToShow(running: Shell.App[]): Shell.App[] {
        const now = GLib.get_monotonic_time() / 1000;
        return running.filter(app => {
            const windows = app.get_windows();
            if (!app.is_window_backed() || windows.length === 0)
                return true;
            const opened = Math.min(...windows
                .map(window => this._windowsSince.get(window) ?? -Infinity));
            const wait = opened + UNMATCHED_APP_DELAY_MS - now;
            if (wait <= 0)
                return true;
            if (!this._unmatchedTimeoutId) {
                this._unmatchedTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                    Math.ceil(wait), () => {
                        this._unmatchedTimeoutId = 0;
                        this._queueRedisplay();
                        return GLib.SOURCE_REMOVE;
                    });
            }
            return false;
        });
    }

    /**
     * Replace the stock favorites separator with a resize handle during the
     * redisplay that creates it. The stock Dash still moves and destroys it
     * through _separator. Clear _separatorHandle on destruction so later
     * updates skip the disposed actor.
     */
    _makeSeparatorDraggable() {
        const separator = this._separator;
        if (!separator || separator === this._separatorHandle?.actor)
            return;
        const handle = new ResizeHandle(this, this._side);
        handle.setLength(this.iconSize);
        this._styleHandle(handle, geometryAt(this.iconSize));
        this._box.insert_child_above(handle.actor, separator);
        separator.destroy();
        this._separator = handle.actor;
        this._separatorHandle = handle;
        handle.actor.connect('destroy', () => {
            if (this._separatorHandle === handle)
                this._separatorHandle = null;
        });
    }

    /**
     * Resolve the drop target after redisplay. The stock reorder can recreate
     * a neighbor and reuse the dropped app's item. For example, moving A one
     * slot right in [A, B, C] can recreate B before A.
     *
     * If the target was recreated at full size, remove the placeholder in the
     * same layout pass. If the target was reused, hide its icon and shrink the
     * placeholder while the neighbor moves. Use the existing item as the
     * fallback target if no redisplay comes.
     */
    #settleLanding(landing: Landing) {
        if (landing !== this.#landing)
            return;

        if (!landing.appIcon) {
            const appIcon = this._appIcons().find(icon => icon.app === landing.app);
            if (appIcon) {
                landing.appIcon = appIcon;
                appIcon.opacity = 0;
                this.#flyIn(landing);
            }
        }

        const placeholder = landing.placeholder;
        if (placeholder) {
            landing.placeholder = null;
            if (landing.recreated)
                placeholder.destroy();
            else
                placeholder.animateOutAndDestroy();
        }

        if (!landing.appIcon)
            this.#finishLanding(landing);
    }

    /**
     * Animate the drop image into the tile. Read the destination on every
     * frame because removing or resizing nearby items can move it during the
     * flight.
     */
    #flyIn(landing: Landing) {
        if (landing !== this.#landing || !landing.appIcon || landing.timeline)
            return;
        const tile = landing.appIcon.icon;
        tile.disconnectObject(this);

        // Reduced motion (Settings → Accessibility): no flight across the
        // dock; the icon just appears in its slot.
        const settings = St.Settings.get();
        if (!settings.enable_animations || settings.reducedMotion === St.ReducedMotion.REDUCE) {
            this.#finishLanding(landing);
            return;
        }

        const {image} = landing;
        image.remove_all_transitions();
        const startX = image.x, startY = image.y;
        const target = () => {
            const [tx, ty] = tile.get_transformed_position();
            const [tw, th] = tile.get_transformed_size();
            return [
                tx + (tw - image.width * image.scale_x) / 2,
                ty + (th - image.height * image.scale_y) / 2,
            ];
        };

        // Use a timeline to update the moving destination on every frame.
        const timeline = new Clutter.Timeline({
            actor: image,
            duration: REORDER_ANIMATION_TIME * settings.slow_down_factor,
        });
        timeline.connect('new-frame', () => {
            const t = easeOutQuad(timeline.get_progress());
            const [x, y] = target();
            image.set_position(startX + (x - startX) * t, startY + (y - startY) * t);
        });
        timeline.connect('completed', () => this.#finishLanding(landing));
        landing.timeline = timeline;
        timeline.start();
    }

    /** End the landing (or `only` that one): reveal the item, drop the image. */
    #finishLanding(only?: Landing) {
        const landing = this.#landing;
        if (!landing || (only && only !== landing))
            return;
        this.#landing = null;

        if (landing.timeoutId)
            GLib.source_remove(landing.timeoutId);
        landing.timeline?.stop();
        landing.appIcon?.icon.disconnectObject(this);
        if (landing.appIcon)
            landing.appIcon.opacity = 255;
        landing.placeholder?.destroy();
        landing.layer.destroy();
    }

    /**
     * Replace the drag actor and its alignment source so the icon and tile
     * move together. dnd.js uses AppIcon's delegate methods in appDisplay.js
     * to create the image and align it at drag start or snapback. Point both
     * at the tile geometry so the image lines up with the dock.
     *
     * Main.uiGroup draws the image outside the dock's CSS scope. Give it the
     * drag-tile class, copy the dock's color variant and apply the tile's
     * current padding and radius.
     */
    #dragWithTile(appIcon: AppIcon) {
        appIcon.getDragActor = () => {
            const g = geometryAt(this.iconSize);
            return new St.Bin({
                style_class: this.has_style_class_name('basedock-light')
                    ? 'basedock-drag-tile basedock-light' : 'basedock-drag-tile',
                style: `padding: ${g.tilePadding}px; border-radius: ${g.tileRadius}px;`,
                child: appIcon.app.create_icon_texture(this.iconSize + iconGrowOf(appIcon.icon)),
            });
        };
        // Typed as returning the St.Icon; dnd.js only needs an actor to
        // align with (position, size).
        appIcon.getDragActorSource =
            (() => appIcon.icon) as unknown as AppIcon['getDragActorSource'];
    }

    /**
     * Connect once per dash and before the first read so GSettings sends
     * change notifications. The connection follows the actor's lifetime, and
     * commitResize() saves the preferred size to this key.
     */
    attachSettings(settings: Gio.Settings) {
        this._settings = settings;
        settings.connectObject('changed::icon-size', () => this._applyIconSizeSetting(), this);
        this.connect('destroy', () => settings.disconnectObject(this));
        this._applyIconSizeSetting();
    }

    /**
     * Cap the saved icon size at the current grow limit and try to persist the
     * cap. Use the cap locally if GSettings rejects the write. Fitting can
     * still choose a smaller displayed size.
     */
    _applyIconSizeSetting() {
        const settings = this._settings!;
        const requested = settings.get_int('icon-size');
        const size = Math.min(requested, this._growCap());
        if (size < requested && settings.set_int('icon-size', size))
            return;
        this.setPreferredIconSize(size);
    }

    /**
     * Find the largest size allowed by the remaining room across the dock.
     * Check each size step because thicker padding makes a one-pixel icon
     * increase grow the background by more than one pixel at some sizes.
     */
    _growCap(measurements = this._dockMeasurements()): number {
        const room = this._growLimit();
        if (room === Infinity || !measurements)
            return MAX_ICON_SIZE;
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        return dockGrowthCap(measurements, this.iconSize, room / scaleFactor);
    }

    /**
     * Set the icon size the dock aims for, clamped to MIN_ICON_SIZE and
     * MAX_ICON_SIZE. The visible size also depends on available room
     * and #fit()'s minimum-size fallback.
     */
    setPreferredIconSize(size: number) {
        size = Math.min(Math.max(size, MIN_ICON_SIZE), MAX_ICON_SIZE);
        if (size === this._preferredIconSize)
            return;
        this._preferredIconSize = size;
        this.#fit(false);
    }

    /**
     * Whether `actor` is in an item with its own menu (an app's, or the
     * Trash): there, a right-click isn't the dock's menu (src/dockMenu.ts).
     */
    hasOwnMenu(actor: Clutter.Actor): boolean {
        for (let a: Clutter.Actor | null = actor; a && a !== this; a = a.get_parent()) {
            if (a === this._trashIcon || (a as Partial<AppIcon>).app instanceof Shell.App)
                return true;
        }
        return false;
    }

    /** Allowed icon sizes: [min, max] right now (max depends on the screen and tiled windows). */
    iconSizeRange(): [number, number] {
        const measurements = this._dockMeasurements();
        const fitting = measurements ? fitDock(measurements).iconSize : MAX_ICON_SIZE;
        const max = Math.min(fitting, this._growCap(measurements));
        return [Math.min(MIN_ICON_SIZE, max), max];
    }

    /**
     * Cap how far the dock can grow, by dragging or by the icon-size
     * setting: `limit()` is the room its inner edge has, in stage px.
     */
    setGrowLimit(limit: () => number) {
        this._growLimit = limit;
    }

    /** Call `callback` once the dock has changed size by itself (Dock: tiled windows). */
    onAutoSized(callback: () => void) {
        this._autoSized = callback;
    }

    // ResizeTarget (src/resize.ts): dragging a divider or the inner border.

    /**
     * Fix the resize range at the start of the drag. The available room before
     * a tiled window is measured from the dock's initial edge.
     */
    beginResize(_x: number, _y: number) {
        this._sizeTimeline?.stop();
        this._sizeTimeline = null;
        this.#setIconSize(this._targetIconSize || this.iconSize);
        const [min, max] = this.iconSizeRange();
        this._drag = {start: this.iconSize, min, max, size: this.iconSize, laterId: 0};
    }

    /**
     * Map each pixel of drag displacement to one icon-size step, within the
     * range set by beginResize(). Apply the new layout at most once per frame.
     * St.Icon displays the previous image until the replacement loads.
     */
    previewResize(grow: number) {
        const drag = this._drag;
        if (!drag)
            return;
        drag.size = Math.min(Math.max(Math.round(drag.start + grow), drag.min), drag.max);
        if (drag.laterId)
            return;
        drag.laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            drag.laterId = 0;
            this.#setIconSize(drag.size);
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * The drag ends: keep the size it reached, as the preferred size, and
     * save it to the icon-size setting.
     */
    commitResize(grow: number) {
        const drag = this._drag;
        if (!drag)
            return;
        this.previewResize(grow);
        if (drag.laterId)
            global.compositor.get_laters().remove(drag.laterId);
        this._drag = null;
        if (drag.size === drag.start) {
            this.#setIconSize(drag.start);
            this.#fit(true);
            return;
        }
        this._preferredIconSize = this._targetIconSize = drag.size;
        this.#setIconSize(drag.size);
        this._settings?.set_int('icon-size', drag.size);
    }

    /**
     * Choose the preferred icon size or the largest smaller size that fits.
     * The stock Dash calls this hook when items or available room change.
     * Include Trash and the dividers in the calculation and allow any integer
     * size in range.
     */
    override _adjustIconSize() {
        this.#fit(true);
    }

    /**
     * Fit the preferred size to the available room, using the minimum size if
     * the dock still overflows. A drag manages its own sizing. Apply the first
     * fit, unmapped fits and fits with animations disabled immediately. Notify
     * the dock after subsequent automatic size changes so tiled windows can
     * follow its edge.
     */
    #fit(automatic: boolean) {
        if (this._drag)
            return;
        const measurements = this._dockMeasurements();
        if (!measurements)
            return;
        const {iconSize: fitting, scrollRoom, overflows} = fitDock(measurements);
        this.#syncOverflow(scrollRoom, overflows);
        const size = Math.max(MIN_ICON_SIZE, Math.min(this._preferredIconSize, fitting));
        if (size === this._targetIconSize)
            return;
        const first = this._targetIconSize === 0;
        this._targetIconSize = size;
        const settings = St.Settings.get();
        if (first || !settings.enable_animations ||
            settings.reducedMotion === St.ReducedMotion.REDUCE || !this.mapped) {
            this._sizeTimeline?.stop();
            this._sizeTimeline = null;
            this.#setIconSize(size);
            if (automatic && !first)
                this._autoSized();
            return;
        }
        this.#animateIconSize(size, automatic);
    }

    /**
     * Animate from the current icon size, rounding the interpolated
     * value on each frame. Use a Timeline because iconSize is a plain
     * JavaScript field.
     */
    #animateIconSize(size: number, automatic: boolean) {
        this._sizeTimeline?.stop();
        this._sizeTimeline = null;
        const from = this.iconSize;
        const done = () => {
            this.#setIconSize(size);
            if (automatic)
                this._autoSized();
        };
        if (from === size) {
            done();
            return;
        }
        const timeline = new Clutter.Timeline({
            actor: this,
            duration: REORDER_ANIMATION_TIME * St.Settings.get().slow_down_factor,
        });
        const settings = St.Settings.get();
        settings.connectObject('notify::reduced-motion', () => {
            if (settings.reducedMotion === St.ReducedMotion.REDUCE) {
                timeline.stop();
                done();
            }
        }, timeline);
        timeline.connect('new-frame', () => this.#setIconSize(
            Math.round(from + (size - from) * easeOutQuad(timeline.get_progress()))));
        timeline.connect('stopped', (_timeline, finished) => {
            settings.disconnectObject(timeline);
            this._sizeTimeline = null;
            if (finished)
                done();
        });
        this._sizeTimeline = timeline;
        timeline.start();
    }

    /**
     * Lay the dock out at icon `size` now: emit 'icon-size-changed' and
     * resize every icon, with items moving directly rather than sliding.
     */
    #setIconSize(size: number) {
        if (size === this.iconSize)
            return;
        this.iconSize = size;
        // Items move because they're resized: apply directly, don't slide.
        this._slider?.suspend();
        // The Dash's own signal (dash.js), missing from the typings.
        (this.emit as (signal: string) => void).call(this, 'icon-size-changed');
        this._resizeIcons();
        this._separatorHandle?.setLength(this.iconSize);
    }

    /**
     * Apply the icon size to the dock's geometry and to every icon, in
     * place: BaseIcon.setIconSize() would recreate the icons, which are
     * blank for a frame until loaded (see resizeIcon).
     */
    _resizeIcons() {
        this._applyGeometry();
        for (const item of this._iconItems())
            resizeIcon(iconOf(item), this.iconSize);
        resizeIcon(this._trashIcon.icon, this.iconSize);
    }

    /** Items with an icon: the apps (not animating out) and Show Apps. */
    _iconItems(): DashItemContainer[] {
        return [...this._appItems(), this._showAppsIcon];
    }

    /**
     * Read the fixed lengths and available room in logical pixels. The
     * sizing functions can reuse this snapshot for every candidate icon
     * size. Return null until there is room to measure on the stage.
     */
    _dockMeasurements(): DockMeasurements | null {
        if (this._maxWidth === -1 || this._maxHeight === -1 || !this.get_stage())
            return null;

        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const logical = (length: number) => length / scaleFactor;
        const vertical = this._vertical;
        const node = this.get_theme_node();
        const background = this._background.get_theme_node();
        const borders = (sides: St.Side[]) =>
            logical(sides.reduce((sum, side) => sum + background.get_border_width(side), 0));
        const [along, across] = vertical
            ? [[St.Side.TOP, St.Side.BOTTOM], [St.Side.LEFT, St.Side.RIGHT]]
            : [[St.Side.LEFT, St.Side.RIGHT], [St.Side.TOP, St.Side.BOTTOM]];
        return {
            alongBorder: borders(along),
            acrossBorder: borders(across),
            alongPadding: logical(vertical ? node.get_vertical_padding() : node.get_horizontal_padding()),
            acrossPadding: logical(vertical ? node.get_horizontal_padding() : node.get_vertical_padding()),
            edgeGap: logical(background.get_margin(stSide(this._side))),
            dividerLine: logical(this._showAppsHandle.lineThickness()),
            spacing: logical(node.get_length('spacing')),
            appSlots: this._appItems().length + (this._dragPlaceholder ? 1 : 0),
            dividers: [this._showAppsHandle, this._trashHandle, this._separatorHandle]
                .filter(handle => handle).length,
            maxLength: logical(vertical ? this._maxHeight : this._maxWidth),
            maxThickness: logical(vertical
                ? this._maxWidth - this.margin_left - this.margin_right
                : this._maxHeight - this.margin_top - this.margin_bottom),
        };
    }

    /**
     * Scroll the apps strip if the minimum icon size still overflows. Keep the
     * stock apps box and drag-and-drop delegate so drop coordinates remain
     * relative to that box.
     */
    #syncOverflow(room: number, overflows: boolean) {
        const container = this._dashContainer;
        if (!overflows) {
            const scroll = this.#overflowView;
            if (scroll) {
                this.#overflowView = null;
                (scroll.child as St.Viewport).remove_child(this._box);
                container.replace_child(scroll, this._box);
                scroll.destroy();
            }
            return;
        }

        const vertical = this._vertical;
        if (!this.#overflowView) {
            const viewport = new St.Viewport({
                layout_manager: vertical ? new Clutter.BinLayout() : new OverflowRowLayout(),
            });
            const scroll = new St.ScrollView({
                name: 'basedock-overflow',
                reactive: true,
                overlay_scrollbars: true,
                hscrollbar_policy: vertical ? St.PolicyType.NEVER : St.PolicyType.AUTOMATIC,
                vscrollbar_policy: vertical ? St.PolicyType.AUTOMATIC : St.PolicyType.NEVER,
                x_expand: vertical,
                y_expand: !vertical,
            });
            scroll.child = viewport;
            this.#overflowView = scroll;
            container.replace_child(this._box, scroll);
            viewport.add_child(this._box);

            const adjustment = vertical ? scroll.vadjustment : scroll.hadjustment;
            global.stage.connectObject('notify::key-focus', () => {
                let actor = global.stage.get_key_focus();
                while (actor && actor.get_parent() !== this._box)
                    actor = actor.get_parent();
                if (actor) {
                    const box = actor.get_allocation_box();
                    if (vertical)
                        adjustment.clamp_page(box.y1, box.y2);
                    else if (viewport.text_direction === Clutter.TextDirection.RTL)
                        adjustment.clamp_page(adjustment.upper - box.x2, adjustment.upper - box.x1);
                    else
                        adjustment.clamp_page(box.x1, box.x2);
                }
            }, scroll);

            // A mouse wheel normally scrolls vertically, even in a row.
            if (!vertical) {
                scroll.connect('scroll-event', (_actor, event) => {
                    const direction = event.get_scroll_direction();
                    if (direction !== Clutter.ScrollDirection.UP && direction !== Clutter.ScrollDirection.DOWN)
                        return Clutter.EVENT_PROPAGATE;
                    adjustment.value += direction === Clutter.ScrollDirection.UP
                        ? -adjustment.step_increment : adjustment.step_increment;
                    return Clutter.EVENT_STOP;
                });
            }
        }
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const length = Math.max(1, Math.floor(room * scaleFactor));
        if (vertical) {
            if (this.#overflowView.natural_height !== length)
                this.#overflowView.height = length;
        } else if (this.#overflowView.natural_width !== length) {
            this.#overflowView.width = length;
        }
    }
});

export type BasedockDashInstance = InstanceType<typeof BasedockDash>;
