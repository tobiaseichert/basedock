// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';

// org.gnome.desktop.interface color-scheme's value for GNOME's Dark style
// (GDesktopColorScheme).
const COLOR_SCHEME_PREFER_DARK = 1;

/**
 * The style setting. `system` follows Settings → Appearance, using dark for
 * prefer-dark and light otherwise. `light` and `dark` select a fixed palette.
 */
type StyleSetting = 'system' | 'light' | 'dark';

/**
 * Resolve the current palette and notify on dock style changes or system color
 * scheme changes in Follow System mode. The callback indicates when to use
 * wallpaper cross-fade timing.
 */
export class DockStyle {
    readonly #settings: Gio.Settings;
    readonly #interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

    constructor(settings: Gio.Settings, onChange: (withWallpaper: boolean) => void) {
        this.#settings = settings;
        settings.connectObject('changed::style', () => onChange(false), this);
        this.#interface.connectObject('changed::color-scheme', () => {
            if (this.setting === 'system')
                onChange(true);
        }, this);
    }

    get setting(): StyleSetting {
        return this.#settings.get_string('style') as StyleSetting;
    }

    /** Whether the dock is light (.basedock-light, stylesheet.css). */
    get light(): boolean {
        switch (this.setting) {
            case 'light':
                return true;
            case 'dark':
                return false;
            default:
                return this.#interface.get_enum('color-scheme') !== COLOR_SCHEME_PREFER_DARK;
        }
    }

    destroy() {
        this.#settings.disconnectObject(this);
        this.#interface.disconnectObject(this);
    }
}
