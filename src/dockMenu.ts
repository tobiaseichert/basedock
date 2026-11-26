// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import type Gio from 'gi://Gio';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {stSide, type DockSide} from './side.js';

/**
 * Build the menu sections after the extension initializes its gettext domain.
 * Each section pairs a setting with translated labels for its available
 * values.
 */
const sections = (): {title: string, key: string, choices: [string, string][]}[] => [{
    // Labelled like GNOME's own (Settings → Appearance), where "Default"
    // is the light style.
    title: _('Dock Style'),
    key: 'style',
    choices: [
        ['system', _('Follow System')],
        // Translators: GNOME's light style, labelled "_Default" in
        // Settings → Appearance; use its translation there, without the
        // underscore (the access key).
        ['light', _('Default')],
        // Translators: GNOME's dark style, labelled "Da_rk" in Settings →
        // Appearance; use its translation there, without the underscore
        // (the access key).
        ['dark', _('Dark')],
    ],
}, {
    // Where the dock sits: a new position rebuilds it there
    // (src/extension.ts).
    title: _('Position'),
    key: 'position',
    choices: [
        // Translators: the dock's position, at the bottom of the screen.
        ['bottom', _('Bottom')],
        // Translators: the dock's position, at the left edge of the screen.
        ['left', _('Left')],
        // Translators: the dock's position, at the right edge of the screen.
        ['right', _('Right')],
    ],
}];

/**
 * Open the dock settings menu on a dock right-click or Show Apps' keyboard
 * menu action. App and Trash items handle their own menus. A dot marks the
 * current value in each section.
 *
 * For a pointer click, move the layout manager's dummy cursor to the click
 * position, as js/ui/backgroundMenu.js does. Open the menu from that point
 * toward the center of the screen.
 */
export class DockMenu {
    readonly #settings: Gio.Settings;
    readonly #menu: PopupMenu.PopupMenu;
    readonly #manager: PopupMenu.PopupMenuManager;
    /** Menu items indexed by setting key and value. */
    readonly #items = new Map<string, Map<string, PopupMenu.PopupMenuItem>>();
    readonly #keyboardSource: Clutter.Actor;
    readonly #dock: Clutter.Actor;
    readonly #click: Clutter.ClickGesture;
    readonly #side: DockSide;

    /**
     * @param settings settings displayed and updated by the menu
     * @param dock actor that receives right-clicks
     * @param side screen edge that anchors the menu
     * @param keyboardSource actor that opens the menu with the Menu key
     * @param ownMenu identifies items that handle their own clicks
     */
    constructor(settings: Gio.Settings, dock: Clutter.Actor, side: DockSide,
        keyboardSource: Clutter.Actor, ownMenu: (actor: Clutter.Actor) => boolean) {
        this.#settings = settings;
        this.#keyboardSource = keyboardSource;
        this.#dock = dock;
        this.#side = side;

        this.#menu = new PopupMenu.PopupMenu(Main.layoutManager.dummyCursor, 0, stSide(side));
        this.#menu.actor.add_style_class_name('basedock-menu');
        for (const {title, key, choices} of sections()) {
            this.#menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(title));
            const items = new Map<string, PopupMenu.PopupMenuItem>();
            for (const [value, label] of choices) {
                const item = new PopupMenu.PopupMenuItem(label);
                item.connect('activate', () => settings.set_string(key, value));
                this.#menu.addMenuItem(item);
                items.set(value, item);
            }
            this.#items.set(key, items);
            settings.connectObject(`changed::${key}`, () => this.#syncOrnaments(key), this);
            this.#syncOrnaments(key);
        }
        Main.uiGroup.add_child(this.#menu.actor);
        this.#menu.actor.hide();
        this.#manager = new PopupMenu.PopupMenuManager(dock);
        this.#manager.addMenu(this.#menu);

        // Leave clicks on items with their own menu to those items so the dock
        // and item gestures do not compete (appDisplay.js).
        const click = this.#click = new Clutter.ClickGesture({
            required_button: Clutter.BUTTON_SECONDARY,
            recognize_on_press: true,
        });
        click.connect('should-handle-sequence', (_gesture, event: Clutter.Event) => {
            const [x, y] = event.get_coords();
            const target = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
            return !target || !ownMenu(target);
        });
        click.connect('recognize', () => {
            const {x, y} = click.get_coords_abs();
            this.open(x, y);
        });
        dock.add_action(click);

        keyboardSource.connectObject('popup-menu', () => this.#openAtKeyboardSource(), this);
    }

    /** Open the menu at (x, y), in stage coordinates, unless it's already open. */
    open(x: number, y: number) {
        if (this.#menu.isOpen)
            return;
        Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
        this.#menu.open();
    }

    /**
     * Open at the middle of the keyboard source's inner edge, so the menu
     * opens above it for a dock at the bottom, beside it for one at a side.
     */
    #openAtKeyboardSource() {
        const source = this.#keyboardSource;
        const [x, y] = source.get_transformed_position();
        const [width, height] = source.get_transformed_size();
        switch (this.#side) {
            case 'left':
            this.open(x + width, y + height / 2);
                break;
            case 'right':
            this.open(x, y + height / 2);
                break;
            default:
            this.open(x + width / 2, y);
        }
    }

    /** Put the dot on the item for `key`'s current value, and only there. */
    #syncOrnaments(key: string) {
        const current = this.#settings.get_string(key);
        for (const [value, item] of this.#items.get(key) ?? []) {
            item.setOrnament(value === current
                ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
        }
    }

    destroy() {
        this.#settings.disconnectObject(this);
        this.#keyboardSource.disconnectObject(this);
        this.#dock.remove_action(this.#click);
        this.#menu.destroy();
    }
}
