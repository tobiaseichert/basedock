// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

// Logical pixels. Keep the range and default in sync with the GSettings schema.
export const MIN_ICON_SIZE = 16;
export const MAX_ICON_SIZE = 64;
export const DEFAULT_ICON_SIZE = 48;

/**
 * Spacing and corner radii at DEFAULT_ICON_SIZE, in logical pixels. geometryAt()
 * scales these values with the icon size. The stylesheet controls the fixed
 * screen-edge gap and borders. The letters below match the geometry rules in
 * its header.
 */
const REFERENCE = {
    /** S is the margin on each end of a tile, measured along the dock. */
    itemMargin: 5,
    /** T: padding between a tile's edge and its icon. */
    tilePadding: 3,
    /** G is the number of pixels added to the drawn icon size. */
    iconGrow: 6,
    /** R: a tile's corner radius. */
    tileRadius: 10,
    /** P: the dock background's padding around the tiles. */
    backgroundPadding: 12,
    /**
     * B is the background corner radius. It is smaller than R + P to keep the
     * background less rounded while preserving the tile radius.
     */
    backgroundRadius: 16,
    /** Grab area on each side of a divider's line. */
    handlePadding: 4,
    /** The running dot, and its gap to the tile. */
    dotSize: 5,
    dotGap: 4,
};

export type Geometry = typeof REFERENCE & {
    /** Extra space beyond the icon size in a tile's footprint (2T + G). */
    footprint: number;
    /** P - S: the background's padding at the dock's ends. */
    endPadding: number;
};

/**
 * Scale the geometry from DEFAULT_ICON_SIZE and return whole logical pixels.
 * Round two totals before solving for G and P from the rounded S and T.
 * Those totals are the extra length around each item (2S + 2T + G) and the
 * end padding (P - S). This avoids jumps when several individual lengths
 * would otherwise round up together.
 *
 * Keep window dots at least 2px wide. The background padding leaves room
 * for the dot, its gap to the tile and a pixel clear of the background edge.
 */
export function geometryAt(size: number): Geometry {
    const scale = size / DEFAULT_ICON_SIZE;
    const px = (value: number, min = 1) => Math.max(min, Math.round(value * scale));
    const {itemMargin: S, tilePadding: T, iconGrow: G, backgroundPadding: P} = REFERENCE;
    const itemMargin = px(S);
    const tilePadding = px(T);
    const iconGrow = Math.max(1, px(2 * S + 2 * T + G) - 2 * itemMargin - 2 * tilePadding);
    const endPadding = px(P - S);
    const dotSize = px(REFERENCE.dotSize, 2);
    const dotGap = px(REFERENCE.dotGap);
    const backgroundPadding = Math.max(endPadding + itemMargin, dotSize + dotGap + 1);
    const tileRadius = px(REFERENCE.tileRadius);
    return {
        itemMargin,
        tilePadding,
        iconGrow,
        tileRadius,
        backgroundPadding,
        handlePadding: px(REFERENCE.handlePadding),
        dotSize,
        dotGap,
        footprint: 2 * tilePadding + iconGrow,
        endPadding,
        backgroundRadius: px(REFERENCE.backgroundRadius),
    };
}

/**
 * Return the whole-pixel padding that lets the Show Apps symbol fill a tile's
 * footprint. The symbol plus twice this padding equals size + F. Rounding
 * approximates the reference ratio of 7/9, or a 42px symbol beside a 54px app
 * icon.
 */
export function showAppsPadding(size: number, {footprint, iconGrow} = geometryAt(size)): number {
    return Math.round((size + footprint - (size + iconGrow) * 7 / 9) / 2);
}

/**
 * Return the transparent margin on either side of the drawn Show Apps dots.
 * The dots span the middle two-thirds of the SVG, leaving 7px on each side at
 * the default size.
 *
 * _styleHandle() adds this margin to the spacing toward app icons so the
 * dividers are centered between the visible shapes.
 */
export function showAppsSymbolMargin(size: number, g = geometryAt(size)): number {
    const symbol = size + g.footprint - 2 * showAppsPadding(size, g);
    return Math.round(symbol / 6);
}

/** Offset between the Show Apps padding and the space around an app icon. */
export function showAppsDividerShift(size: number, g: Geometry): number {
    return showAppsPadding(size, g) - g.tilePadding - g.itemMargin;
}

/** Fixed theme measurements and available room, in logical pixels. */
export interface DockMeasurements {
    alongBorder: number;
    acrossBorder: number;
    alongPadding: number;
    acrossPadding: number;
    edgeGap: number;
    dividerLine: number;
    spacing: number;
    /** App slots include a drop placeholder while it is present. */
    appSlots: number;
    dividers: number;
    maxLength: number;
    maxThickness: number;
}

export function appSlotLength(size: number, g: Geometry): number {
    return size + g.footprint + 2 * g.itemMargin;
}

/** Calculate the space needed at an icon size, before applying overflow. */
export function dockSizeAt(m: DockMeasurements, size: number) {
    const g = geometryAt(size);
    const symbolMargin = showAppsSymbolMargin(size, g);
    const appSlot = appSlotLength(size, g);
    const showAppsSlot = size + g.footprint - showAppsDividerShift(size, g) - symbolMargin;
    const divider = 2 * (g.handlePadding + symbolMargin) + m.dividerLine;
    // Show Apps, Trash, dividers and their spacing stay outside the scrollable strip.
    const fixedBackgroundLength = m.alongBorder + 2 * g.endPadding + showAppsSlot +
        appSlot + m.dividers * divider + (m.appSlots + 1 + m.dividers) * m.spacing;
    const backgroundThickness = m.acrossBorder + size + g.footprint + 2 * g.backgroundPadding;
    return {
        length: m.alongPadding + (fixedBackgroundLength + m.appSlots * appSlot),
        thickness: m.acrossPadding + m.edgeGap + backgroundThickness,
        fixedLength: m.alongPadding + fixedBackgroundLength,
        backgroundThickness,
    };
}

/** Find the largest fitting size and the room available to the apps strip. */
export function fitDock(m: DockMeasurements) {
    let iconSize = MAX_ICON_SIZE;
    for (; iconSize > MIN_ICON_SIZE; iconSize--) {
        const {length, thickness} = dockSizeAt(m, iconSize);
        if (length <= m.maxLength && thickness <= m.maxThickness)
            break;
    }
    const minimum = dockSizeAt(m, MIN_ICON_SIZE);
    return {
        iconSize,
        overflows: minimum.length > m.maxLength,
        scrollRoom: m.maxLength - minimum.fixedLength,
    };
}

/** Cap growth by the extra room available across the visible background. */
export function dockGrowthCap(m: DockMeasurements, current: number, room: number): number {
    const limit = dockSizeAt(m, current).backgroundThickness + room;
    let size = current;
    while (size < MAX_ICON_SIZE && dockSizeAt(m, size + 1).backgroundThickness <= limit)
        size++;
    return size;
}
