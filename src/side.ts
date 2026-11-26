// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import type Gio from 'gi://Gio';
import St from 'gi://St';

/**
 * The configured screen edge. Read it at construction because changing the
 * position rebuilds the dock (src/extension.ts).
 */
export type DockSide = 'bottom' | 'left' | 'right';

/** The position setting, as a DockSide; unknown values fall back to the bottom. */
export function sideFromSettings(settings: Gio.Settings): DockSide {
    const value = settings.get_string('position');
    return value === 'left' || value === 'right' ? value : 'bottom';
}

/** Whether the dock runs along the screen's height (its items in a column). */
export const isVertical = (side: DockSide) => side !== 'bottom';

export const orientationOf = (side: DockSide) =>
    isVertical(side) ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL;

/**
 * Convert the dock edge to St.Side for the screen-edge gap and menu arrows. An
 * arrow points toward the screen edge so the menu opens toward the screen
 * interior.
 */
export function stSide(side: DockSide): St.Side {
    switch (side) {
        case 'left':
            return St.Side.LEFT;
        case 'right':
            return St.Side.RIGHT;
        default:
            return St.Side.BOTTOM;
    }
}
