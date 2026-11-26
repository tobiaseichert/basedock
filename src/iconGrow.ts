// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

import type Gio from 'gi://Gio';
import St from 'gi://St';

import type {BaseIcon} from 'resource:///org/gnome/shell/ui/iconGrid.js';

/**
 * Per-icon function that maps the dock's icon size to the extra pixels drawn
 * by that icon.
 */
const grows = new WeakMap<BaseIcon, (size: number) => number>();

const growAt = (baseIcon: BaseIcon, size: number) => grows.get(baseIcon)?.(size) ?? 0;

/**
 * Resize the existing St.Icon when possible. BaseIcon.setIconSize() creates a
 * replacement that can be blank until its texture loads. St.Icon keeps the
 * previous texture while loading a new one (pending_texture in st-icon.c).
 *
 * Set the actor's dimensions immediately so neighboring tiles move together
 * even when textures finish loading on different frames. Repeat after a
 * scale-factor change.
 */
export function resizeIcon(baseIcon: BaseIcon, size: number) {
    if (!baseIcon.icon) {
        baseIcon.setIconSize(size);
        return;
    }
    const iconSize = size + growAt(baseIcon, size);
    const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
    baseIcon.iconSize = size;
    baseIcon.icon.icon_size = iconSize;
    baseIcon.icon.set_size(iconSize * scaleFactor, iconSize * scaleFactor);
    // Invalidate BaseIcon._iconBin directly (iconGrid.js). Relayout from
    // St.Icon can stop before reaching it, leaving one dimension cached from
    // the original icon size after re-enabling the extension. Shell.SquareBin
    // uses the larger dimension, so a stale height can keep the tile
    // oversized.
    baseIcon.icon.get_parent()?.queue_relayout();
}

/** How much bigger `baseIcon`'s icon is drawn now (followIconGrow); 0 if not set up. */
export const iconGrowOf = (baseIcon: BaseIcon) => growAt(baseIcon, baseIcon.iconSize);

/**
 * Adjust the drawn icon by grow(size) pixels. App and Trash icons extend into
 * tile padding. Show Apps uses a negative adjustment and fills the remaining
 * footprint with padding.
 *
 * resizeIcon() applies the adjustment on resize. Wrap BaseIcon.createIcon()
 * (iconGrid.js) once per dock-owned icon so replacements use the adjustment
 * too.
 */
export function followIconGrow(baseIcon: BaseIcon, grow: (size: number) => number) {
    grows.set(baseIcon, grow);
    // An icon created before (the stock dash creates an app's icon with
    // its item) takes the grow now.
    if (baseIcon.icon)
        resizeIcon(baseIcon, baseIcon.iconSize);
    const createIcon = baseIcon.createIcon.bind(baseIcon);
    baseIcon.createIcon = (size: number) => createIcon(size + growAt(baseIcon, size));
}

/**
 * Use getGicon() for a non-app icon such as Show Apps or Trash. Apply the same
 * size adjustment as followIconGrow() and pass each new St.Icon to onCreate.
 */
export function setUpGrowingIcon(baseIcon: BaseIcon, getGicon: () => Gio.Icon,
    styleClass: string, onCreate: (icon: St.Icon) => void,
    grow: (size: number) => number) {
    baseIcon.createIcon = (size: number) => {
        const icon = new St.Icon({
            gicon: getGicon(),
            icon_size: size,
            style_class: styleClass,
            track_hover: true,
        });
        onCreate(icon);
        return icon;
    };
    followIconGrow(baseIcon, grow);
    baseIcon._createIconTexture(baseIcon.iconSize);
}
