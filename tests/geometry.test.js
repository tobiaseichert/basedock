// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    dockSizeAt, fitDock, geometryAt, MAX_ICON_SIZE, MIN_ICON_SIZE, windowDotCapacity,
} from '../dist/geometry.js';

const measurements = {
    alongBorder: 2,
    acrossBorder: 2,
    alongPadding: 12,
    acrossPadding: 0,
    edgeGap: 8,
    dividerLine: 1,
    spacing: 0,
    appSlots: 3,
    dividers: 2,
    maxLength: 406,
    maxThickness: 94,
};

test('an exact fit counts both length and thickness', () => {
    assert.deepEqual(dockSizeAt(measurements, 48), {
        length: 406,
        thickness: 94,
        fixedLength: 196,
        backgroundThickness: 86,
    });
    assert.equal(fitDock(measurements).iconSize, 48);
    assert.ok(fitDock({...measurements, maxLength: 405}).iconSize < 48);
    assert.ok(fitDock({...measurements, maxThickness: 93}).iconSize < 48);
});

test('only the apps strip scrolls when the minimum size overflows', () => {
    assert.deepEqual(fitDock({...measurements, maxLength: 141}), {
        iconSize: 16,
        overflows: false,
        scrollRoom: 69,
    });
    assert.deepEqual(fitDock({...measurements, maxLength: 140}), {
        iconSize: 16,
        overflows: true,
        scrollRoom: 68,
    });
});

test('the drop placeholder takes one app slot and its spacing', () => {
    const withoutPlaceholder = {...measurements, spacing: 2, maxLength: 418};
    const withPlaceholder = {...withoutPlaceholder, appSlots: 4};
    assert.equal(dockSizeAt(withoutPlaceholder, 48).length, 418);
    assert.equal(dockSizeAt(withPlaceholder, 48).length, 490);
    assert.equal(fitDock(withoutPlaceholder).iconSize, 48);
    assert.ok(fitDock(withPlaceholder).iconSize < 48);
});

test('window marks fit and their capacity never increases as the dock shrinks', () => {
    assert.equal(windowDotCapacity(48), 7);
    for (let size = MIN_ICON_SIZE; size <= MAX_ICON_SIZE; size++) {
        const {dotSize, dotSpacing, footprint} = geometryAt(size);
        const count = windowDotCapacity(size);
        assert.ok(count * dotSize + (count - 1) * dotSpacing <= size + footprint, `size ${size}`);
        if (size > MIN_ICON_SIZE)
            assert.ok(count >= windowDotCapacity(size - 1), `size ${size}`);
    }
});
