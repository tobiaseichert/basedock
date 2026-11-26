// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {DashItemContainer} from 'resource:///org/gnome/shell/ui/dash.js';
import {BaseIcon} from 'resource:///org/gnome/shell/ui/iconGrid.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {geometryAt} from './geometry.js';
import {setUpGrowingIcon} from './iconGrow.js';

const TRASH_URI = 'trash:///';
const ITEM_COUNT = 'trash::item-count';

// Files' D-Bus interface for requesting Empty Trash with confirmation.
const FILE_OPERATIONS = {
    name: 'org.gnome.Nautilus',
    path: '/org/gnome/Nautilus/FileOperations2',
    iface: 'org.gnome.Nautilus.FileOperations2',
};

/**
 * Show the Trash at the end of the dock using Adwaita's full-color icon,
 * updated when its contents change. Activating the tile opens Trash in the
 * default file manager.
 *
 * Right-click, long-press or use the Menu key to open its menu, matching
 * AppIcon in appDisplay.js. Empty Trash asks Files to prompt for confirmation.
 */
export const TrashIcon = GObject.registerClass({
    GTypeName: 'BasedockTrashIcon',
    // Like AppIcon's: the dash hides the tooltip while the menu is open.
    Signals: {'menu-state-changed': {param_types: [GObject.TYPE_BOOLEAN]}},
}, class TrashIcon extends DashItemContainer {
    // GObject runs _init() before JavaScript installs subclass private fields.
    // Declare the fields used there.
    declare button: St.Button;
    declare icon: BaseIcon;
    declare _trash: Gio.File;
    declare _monitor: Gio.FileMonitor | null;
    declare _monitorId: number;
    declare _queryPending: boolean;
    declare _queryDirty: boolean;
    declare _cancellable: Gio.Cancellable;
    declare _full: boolean;
    declare _menu: PopupMenu.PopupMenu | null;
    declare _menuOpenStateId: number;
    /** The side the menu's arrow points out of (setMenuSide). */
    declare _menuSide: St.Side;
    declare _menuManager: PopupMenu.PopupMenuManager;
    declare _emptyItem: PopupMenu.PopupBaseMenuItem | null;

    override _init() {
        super._init();

        this._full = false;
        this._monitorId = 0;
        this._queryPending = false;
        this._queryDirty = false;
        this._menuOpenStateId = 0;
        this._menu = null;
        this._menuSide = St.Side.BOTTOM;
        this._emptyItem = null;
        this._trash = Gio.File.new_for_uri(TRASH_URI);
        this._cancellable = new Gio.Cancellable();
        const label = _('Trash');

        this.button = new St.Button({
            style_class: 'basedock-trash',
            track_hover: true,
            can_focus: true,
            accessible_name: label,
        });
        this.icon = new BaseIcon(label, {setSizeManually: true, showLabel: false});
        this.icon.y_align = Clutter.ActorAlign.CENTER;
        setUpGrowingIcon(this.icon, () => this._gicon(), 'basedock-trash-icon', () => {},
            size => geometryAt(size).iconGrow);
        this.button.child = this.icon;
        this.setChild(this.button);
        this.setLabelText(label);

        this.button.connect('clicked', () => this._open());
        this._setUpMenu();

        try {
            this._monitor = this._trash.monitor_directory(
                Gio.FileMonitorFlags.NONE, null);
            this._monitorId = this._monitor.connect('changed', () => this._update());
        } catch {
            // Without a monitor, only the initial query can update the icon.
            this._monitor = null;
        }
        this._update();

        this.connect('destroy', () => {
            this._cancellable.cancel();
            if (this._monitor) {
                this._monitor.disconnect(this._monitorId);
                this._monitor.cancel();
                this._monitor = null;
            }

            // DashItemContainer destroys its button before this handler.
            // Closing the popup must not touch the disposed source.
            Main.overview.disconnectObject(this);
            if (this._menu) {
                this._menu.disconnect(this._menuOpenStateId);
                this._menu.destroy();
                this._menu = null;
                this._emptyItem = null;
            }
        });
    }

    /**
     * Open the menu on a right-click, a long press or the Menu key, as an
     * app icon does (AppIcon, appDisplay.js). From the keyboard, focus
     * moves into the menu.
     */
    _setUpMenu() {
        this._menuManager = new PopupMenu.PopupMenuManager(this.button);
        const longPress = new Clutter.LongPressGesture();
        longPress.connect('recognize', () => this._popupMenu());
        this.button.add_action(longPress);
        const rightClick = new Clutter.ClickGesture({
            required_button: Clutter.BUTTON_SECONDARY,
            recognize_on_press: true,
        });
        rightClick.connect('recognize', () => this._popupMenu());
        this.button.add_action(rightClick);
        this.button.connect('popup-menu', () => {
            this._popupMenu();
            this._menu?.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
        });
    }

    /**
     * Point the menu arrow toward the dock's screen edge so the menu opens
     * toward the screen interior. Set the side before the menu is created on
     * its first opening.
     */
    setMenuSide(side: St.Side) {
        this._menuSide = side;
    }

    /**
     * Create the menu on first use. On each open, enable Empty Trash according
     * to the last successful count. Close the menu immediately when the
     * overview starts hiding.
     */
    _popupMenu() {
        if (!this._menu) {
            const menu = new PopupMenu.PopupMenu(this.button, 0.5, this._menuSide);
            menu.actor.add_style_class_name('app-menu');
            menu.addAction(_('Open'), () => this._open());
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._emptyItem = menu.addAction(_('Empty Trash'), () => this._empty());
            this._menuOpenStateId = menu.connect('open-state-changed', (_menu, open: boolean) => {
                if (!open)
                    this._setHighlighted(false);
            });
            // GNOME Shell 51 takes a parameters object in close()
            // (popupMenu.js). The typings still describe the old signature.
            const close = menu.close.bind(menu) as unknown as (params: {animate: boolean}) => void;
            Main.overview.connectObject('hiding', () => close({animate: false}), this);
            Main.uiGroup.add_child(menu.actor);
            this._menuManager.addMenu(menu);
            this._menu = menu;
        }
        this._emptyItem?.setSensitive(this._full);
        this._setHighlighted(true);
        this._menu.open();
    }

    /**
     * Highlight the tile while its menu is open, as AppIcon does in
     * appDisplay.js. Emit menu-state-changed so the dash can hide the tooltip.
     */
    _setHighlighted(highlighted: boolean) {
        this.button.set({track_hover: !highlighted, hover: highlighted});
        if (!highlighted)
            this.button.sync_hover();
        // Declared above (Signals), unknown to the typings.
        (this.emit as unknown as (signal: string, opened: boolean) => void)
            .call(this, 'menu-state-changed', highlighted);
    }

    /**
     * Ask Files to empty Trash with confirmation. If the D-Bus request fails,
     * open Trash in the default file manager.
     */
    _empty() {
        if (Main.overview.visible)
            Main.overview.hide();
        Gio.DBus.session.call(FILE_OPERATIONS.name, FILE_OPERATIONS.path,
            FILE_OPERATIONS.iface, 'EmptyTrash',
            new GLib.Variant('(ba{sv})', [true, {}]),
            null, Gio.DBusCallFlags.NONE,
            // Files acknowledges receipt before the operation completes.
            -1, this._cancellable, (connection, result) => {
                try {
                    connection!.call_finish(result);
                } catch (e) {
                    if (this._cancellable.is_cancelled())
                        return;
                    console.warn(`baseDOCK: Files can't empty the trash, opening it instead: ${e}`);
                    this._open();
                }
            });
    }

    /** The full or empty trash icon, whichever the trash was when last checked. */
    _gicon(): Gio.Icon {
        return new Gio.ThemedIcon({name: this._full ? 'user-trash-full' : 'user-trash'});
    }

    /** Leave the overview, and open the trash in the default file manager. */
    _open() {
        if (Main.overview.visible)
            Main.overview.hide();
        const context = global.create_app_launch_context(0, -1);
        Gio.AppInfo.launch_default_for_uri_async(TRASH_URI, context, null,
            (_source, result) => {
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(result);
                } catch (e) {
                    console.error('baseDOCK: could not open the trash:', e);
                }
            });
    }

    /**
     * Query the Trash count at startup and when the file monitor reports a
     * change. Preserve the previous count on query failure. Destroying the
     * actor cancels outstanding queries.
     */
    _update() {
        if (this._cancellable.is_cancelled())
            return;
        if (this._queryPending) {
            this._queryDirty = true;
            return;
        }
        this._queryPending = true;
        this._trash.query_info_async(ITEM_COUNT, Gio.FileQueryInfoFlags.NONE,
            0, this._cancellable, (file, result) => {
                let full: boolean | undefined;
                try {
                    full = file!.query_info_finish(result)
                        .get_attribute_uint32(ITEM_COUNT) > 0;
                } catch {
                    // Keep the last known count on failure.
                }
                this._queryPending = false;
                if (this._cancellable.is_cancelled())
                    return;
                if (this._queryDirty) {
                    this._queryDirty = false;
                    this._update();
                    return;
                }
                if (full !== undefined && full !== this._full) {
                    this._full = full;
                    // Swap the image on the existing St.Icon: it keeps
                    // showing the old one until the new one has loaded (a
                    // recreated icon would be blank for a frame).
                    if (this.icon.icon)
                        this.icon.icon.gicon = this._gicon();
                    else
                        this.icon._createIconTexture(this.icon.iconSize);
                }
            });
    }
});
