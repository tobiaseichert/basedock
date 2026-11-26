// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

/** Default icon size and reference for the dock's proportions. */
const REFERENCE_SIZE = 48;

/**
 * Spacing and corner radii at REFERENCE_SIZE, in logical pixels. geometryAt()
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
 * Scale the geometry from REFERENCE_SIZE and return whole logical pixels.
 * Round two totals before solving for G and P from the rounded S and T.
 * Those totals are the extra length around each item (2S + 2T + G) and the
 * end padding (P - S). This avoids jumps when several individual lengths
 * would otherwise round up together.
 *
 * Keep the running dot at least 2px wide and leave enough padding for the dot
 * and its gap to the tile.
 */
export function geometryAt(size: number): Geometry {
    const scale = size / REFERENCE_SIZE;
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
export function showAppsPadding(size: number): number {
    const {footprint, iconGrow} = geometryAt(size);
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
export function showAppsSymbolMargin(size: number): number {
    const {footprint} = geometryAt(size);
    const symbol = size + footprint - 2 * showAppsPadding(size);
    return Math.round(symbol / 6);
}
