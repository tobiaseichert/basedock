// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Dock} from './dock.js';
import {sideFromSettings} from './side.js';

export default class BasedockExtension extends Extension {
    #dock: Dock | null = null;
    #settings: Gio.Settings | null = null;
    #rebuildId = 0;

    override enable() {
        const settings = this.#settings = this.getSettings();
        try {
            this.#replaceDock(settings);
            // Defer the rebuild so the menu can finish handling the setting
            // change before the dock is destroyed.
            settings.connectObject('changed::position', () => {
                if (this.#rebuildId)
                    return;
                this.#rebuildId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                    this.#rebuildId = 0;
                    try {
                        this.#replaceDock(settings);
                    } catch (error) {
                        this.disable();
                        console.error('baseDOCK: could not rebuild the dock', error);
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }, this);
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    #replaceDock(settings: Gio.Settings) {
        this.#destroyDock();
        this.#dock = new Dock({
            settings,
            side: sideFromSettings(settings),
            showAppsGicon: new Gio.FileIcon({
                file: this.dir.resolve_relative_path('icons/show-apps-symbolic.svg'),
            }),
        });
    }

    #destroyDock() {
        const dock = this.#dock;
        this.#dock = null;
        dock?.destroy();
    }

    override disable() {
        if (this.#rebuildId) {
            global.compositor.get_laters().remove(this.#rebuildId);
            this.#rebuildId = 0;
        }
        this.#settings?.disconnectObject(this);
        this.#settings = null;
        this.#destroyDock();
    }
}
