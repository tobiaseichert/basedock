// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import type {AppIcon} from 'resource:///org/gnome/shell/ui/appDisplay.js';
import type {DashItemContainer} from 'resource:///org/gnome/shell/ui/dash.js';

type StockDash = typeof Main.overview.dash;
type FocusEntry = {root: unknown};

// Style class on the stock dash while it hosts the dock (stylesheet.css).
const HOST_CLASS = 'basedock-host';

/**
 * Keep the stock dash in the overview layout while baseDOCK is enabled. Hide
 * its contents and remove its Ctrl+Alt+Tab entry. A bottom dock uses it as a
 * host and as a spacer sized to the dock's maximum thickness. A side dock sets
 * its height to zero and uses OverviewRoom for clearance.
 *
 * Report the dock's icon size through the stock dash. AppIcon.getDragActor()
 * in appDisplay.js reads Main.overview.dash.iconSize for drags from the dock
 * and app grid. destroy() restores the original dash state.
 */
export class StockDashTakeover {
    readonly dash: StockDash = Main.overview.dash;
    readonly #iconSize = Object.getOwnPropertyDescriptor(this.dash, 'iconSize');
    readonly #adjustIconSize = Object.getOwnPropertyDescriptor(this.dash, '_adjustIconSize');
    readonly #minHeight = this.dash.min_height_set ? this.dash.min_height : null;
    readonly #naturalHeight = this.dash.natural_height_set ? this.dash.natural_height : null;
    readonly #hadHostClass = this.dash.has_style_class_name(HOST_CLASS);
    readonly #visibility = [this.dash, this.dash._background, this.dash._dashContainer]
        .map(actor => ({actor, visible: actor.visible}));
    /** The stock dash's Ctrl+Alt+Tab entry, held while it's taken over. */
    #ctrlAltTabItem: {entry: FocusEntry, index: number} | null = null;

    readonly #getIconSize: () => number;
    readonly #skipAdjustIconSize = () => {};

    /** @param getIconSize the dock's current icon size */
    constructor(getIconSize: () => number) {
        const stock = this.dash;

        this.#getIconSize = getIconSize;
        try {
            // Visible only while it hosts the dock (src/dock.ts).
            stock.hide();
            stock._background.hide();
            stock._dashContainer.hide();
            // Remove the host's padding so the dock can use its full width.
            stock.add_style_class_name(HOST_CLASS);
            // Skip resizing the hidden icons. With iconSize reporting the live
            // dock's size, the stock dash would keep seeing a size mismatch.
            // Its redisplay still runs because Dash._init() registered a bound
            // callback with Main.initializeDeferredWork() in dash.js. That
            // callback runs on map or after the idle timeout (main.js).
            Object.defineProperty(stock, '_adjustIconSize', {
                configurable: true,
                writable: true,
                value: this.#skipAdjustIconSize,
            });

            // ctrlAltTab.js also registers a focus group in addGroup(). Only
            // remove the switcher entry so the existing group stays registered.
            const manager = Main.ctrlAltTabManager as unknown as {_items: FocusEntry[]};
            const index = manager._items.findIndex(item => item.root === stock);
            if (index !== -1)
                this.#ctrlAltTabItem = {entry: manager._items.splice(index, 1)[0], index};

            Object.defineProperty(stock, 'iconSize', {
                configurable: true,
                enumerable: true,
                get: this.#getIconSize,
                // Stock code may still assign it; ignore that.
                set: () => {},
            });
        } catch (error) {
            this.destroy();
            throw error;
        }
    }

    /**
     * Set the stock dash's height in stage pixels. A bottom dock passes
     * its maximum thickness, a side dock passes zero, and -1 unsets the
     * explicit height.
     */
    setHeight(height: number) {
        // Only on change: setting a height queues a relayout even when it's
        // the same.
        const stock = this.dash;
        if (!stock.natural_height_set || stock.natural_height !== height)
            stock.height = height;
    }

    /**
     * Restore the original properties, height, visibility and Ctrl+Alt+Tab
     * entry. Queue redisplay so the stock dash can recalculate its icon size.
     */
    destroy() {
        const stock = this.dash;

        const ownsIconSize = Object.getOwnPropertyDescriptor(stock, 'iconSize')?.get === this.#getIconSize;
        const ownsAdjust = Object.getOwnPropertyDescriptor(stock, '_adjustIconSize')?.value === this.#skipAdjustIconSize;
        for (const [key, descriptor, owned] of [
            ['iconSize', this.#iconSize, ownsIconSize],
            ['_adjustIconSize', this.#adjustIconSize, ownsAdjust],
        ] as const) {
            if (!owned)
                continue;
            if (descriptor)
                Object.defineProperty(stock, key, descriptor);
            else
                Reflect.deleteProperty(stock, key);
        }

        // Dash._createAppItem() sizes new items from iconSize while we
        // override it. Dash._adjustIconSize() skips updates when the
        // restored size already fits, so bring those items back in sync.
        if (ownsIconSize) {
            for (const item of stock._box.get_children() as unknown as DashItemContainer[]) {
                const icon = (item.child as unknown as AppIcon | null)?.icon;
                if (icon && icon.iconSize !== stock.iconSize)
                    icon.setIconSize(stock.iconSize);
            }
            if (stock._separator)
                stock._separator.height = stock.iconSize;
        }

        stock.height = -1;
        if (this.#minHeight !== null)
            stock.min_height = this.#minHeight;
        if (this.#naturalHeight !== null)
            stock.natural_height = this.#naturalHeight;
        for (const {actor, visible} of this.#visibility)
            actor.visible = visible;
        if (!this.#hadHostClass)
            stock.remove_style_class_name(HOST_CLASS);
        if (this.#ctrlAltTabItem) {
            const {entry, index} = this.#ctrlAltTabItem;
            const manager = Main.ctrlAltTabManager as unknown as {_items: FocusEntry[]};
            if (!manager._items.some(item => item.root === stock))
                manager._items.splice(index, 0, entry);
            this.#ctrlAltTabItem = null;
        }
        stock._queueRedisplay();
    }
}
