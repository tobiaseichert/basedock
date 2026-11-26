// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

import type Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';

/**
 * The private ControlsManagerLayout API in overviewControls.js that computes
 * workspace bounds for each overview state.
 */
interface ControlsLayout {
    _computeWorkspacesBoxForState(state: ControlsState, ...rest: unknown[]): Clutter.ActorBox;
}

/**
 * BaseAppViewGridLayout in appDisplay.js shows hints at the grid's edges
 * during a drag, with icons from adjacent pages.
 */
interface AppGridLayout {
    /** 0 at rest, 1 with the hints shown. */
    _pageIndicatorsAdjustment: St.Adjustment;
    _previousPageIndicator: St.Widget;
    _nextPageIndicator: St.Widget;
}

/** The app grid's actors (BaseAppView, appDisplay.js); private. */
interface AppDisplay extends St.Widget {
    _appGridLayout: AppGridLayout;
    _scrollView: St.ScrollView;
    /** An St.Viewport, with the pages side by side. */
    _grid: St.Viewport & {
        /** The empty band at each page's sides (BaseAppViewGridLayout). */
        indicatorsPadding: Clutter.Margin | null,
    };
}

/**
 * Reserve equal space on both sides of the overview for a side dock. In the
 * window picker, inset the workspace so it stays centered and clears the dock.
 * Preserve the hidden state's work-area bounds because previews animate from
 * and back to those bounds. The app grid's small workspace already clears the
 * dock.
 *
 * Give the app grid matching margins to keep its page arrows accessible.
 * Extend its page clips so ordinary page transitions can still slide behind
 * the dock to the screen edge. During an icon drag, let the grid clip its own
 * hints and adjacent pages as usual.
 *
 * destroy() restores the saved layout method, styles and clipping settings.
 */
export class OverviewSideRoom {
    readonly #controls: St.Widget;
    readonly #layout: ControlsLayout;
    readonly #computeWithRoom: ControlsLayout['_computeWorkspacesBoxForState'];
    readonly #computeDescriptor: PropertyDescriptor | undefined;
    readonly #appDisplay: AppDisplay;
    /** The app grid's own inline style, kept under the margin. */
    readonly #style: string | null;
    /** The app grid's clipping actors: its scroll view and the container around it. */
    readonly #pageClips: St.Widget[];
    /** Their own clip_to_allocation, to restore. */
    readonly #pageClipsToAllocation: boolean[];
    readonly #originalClips: ([number, number, number, number] | null)[];
    #restoreClipToView = false;
    #width = 0;
    #hintsId = 0;

    constructor() {
        // OverviewActor's ControlsManager (overview.js), and its AppDisplay
        // (overviewControls.js).
        const overview = Main.overview as unknown as {_overview: {_controls: St.Widget}};
        this.#controls = overview._overview._controls;
        const controlsLayout = this.#controls.layout_manager as unknown as ControlsLayout;
        this.#layout = controlsLayout;
        const compute = controlsLayout._computeWorkspacesBoxForState;
        this.#computeDescriptor = Object.getOwnPropertyDescriptor(controlsLayout,
            '_computeWorkspacesBoxForState');
        this.#computeWithRoom = (state, ...rest) => {
            const box = compute.call(controlsLayout, state, ...rest);
            if (state === ControlsState.WINDOW_PICKER)
                this.#clearWorkspaceBox(box);
            return box;
        };
        this.#appDisplay = (this.#controls as unknown as {_appDisplay: AppDisplay})._appDisplay;
        this.#style = this.#appDisplay.style;

        const scrollView = this.#appDisplay._scrollView;
        this.#pageClips = [scrollView, scrollView.get_parent() as St.Widget];
        this.#pageClipsToAllocation = this.#pageClips.map(actor => actor.clip_to_allocation);
        this.#originalClips = this.#pageClips.map(actor => actor.has_clip ? actor.get_clip() : null);
        try {
            Object.defineProperty(controlsLayout, '_computeWorkspacesBoxForState', {
                configurable: true,
                writable: true,
                value: this.#computeWithRoom,
            });
            for (const actor of this.#pageClips)
                actor.clip_to_allocation = false;
            // The grid's margin can move the clipping actors in stage
            // coordinates even when their local allocations remain unchanged.
            const sync = () => this.#syncPageClips();
            for (const actor of [this.#appDisplay, ...this.#pageClips])
                actor.connectObject('notify::allocation', sync, this);
            // The drag hints coming and going, and the grid's own clipping,
            // which they switch (showPageIndicators, hidePageIndicators).
            const layout = this.#appDisplay._appGridLayout;
            // A raw handler ID, as in src/blur.ts: the signal tracker would
            // disconnect it from the disposed adjustment at shutdown.
            this.#hintsId = layout._pageIndicatorsAdjustment.connect('notify::value', sync);
            for (const indicator of [layout._previousPageIndicator, layout._nextPageIndicator])
                indicator.connectObject('notify::visible', sync, this);
            this.#appDisplay._grid.connectObject('notify::clip-to-view', sync, this);
            this.#syncPageClips();
        } catch (error) {
            this.destroy();
            throw error;
        }
    }

    /**
     * Reserve `width` (stage px) on both sides of the app grid and
     * workspace so both stay centered.
     */
    setWidth(width: number) {
        if (width === this.#width)
            return;
        this.#width = width;
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const appDisplay = this.#appDisplay;
        appDisplay.style = `${this.#style ?? ''} ` +
            `margin-left: ${width / scaleFactor}px; margin-right: ${width / scaleFactor}px;`;
        // St restyles a hidden widget only once it's shown again; the
        // margin applies now.
        appDisplay.ensure_style();
        appDisplay.queue_relayout();
        this.#controls.queue_relayout();
    }

    /**
     * Inset the window picker's workspace box within the monitor-wide
     * controls. WorkspaceLayout in workspace.js uses the height and work-area
     * aspect ratio to determine width. Reduce the height to fit the new width
     * and center the result vertically.
     */
    #clearWorkspaceBox(box: Clutter.ActorBox) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || this.#width === 0)
            return;
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const width = Math.max(0, box.get_width() - 2 * this.#width);
        const height = Math.min(box.get_height(), Math.floor(width * area.height / area.width));
        box.set_origin(box.x1 + this.#width,
            box.y1 + Math.floor((box.get_height() - height) / 2));
        box.set_size(width, height);
    }

    /** Whether the grid shows its drag hints, or they're still animating away. */
    #draggingInGrid(): boolean {
        const layout = this.#appDisplay._appGridLayout;
        return layout._pageIndicatorsAdjustment.value > 0 ||
            layout._previousPageIndicator.visible || layout._nextPageIndicator.visible;
    }

    /**
     * Extend the clips toward the screen edges so pages can slide behind the
     * dock. Stop at the adjacent page's empty side band (indicatorsPadding) to
     * keep its icons out of view while the grid is at rest.
     *
     * During an icon drag, clip to the scroll view and container allocations.
     * The grid manages its viewport clip while the drag hints are visible.
     */
    #syncPageClips() {
        const grid = this.#appDisplay._grid;
        const dragging = this.#draggingInGrid();
        if (!dragging && grid.clip_to_view) {
            this.#restoreClipToView = true;
            grid.clip_to_view = false;
        }
        const padding = grid.indicatorsPadding;
        const leftBand = dragging ? 0 : padding?.left ?? 0;
        const rightBand = dragging ? 0 : padding?.right ?? 0;
        // The controls span the monitor (overview.js: MonitorConstraint).
        const controlsWidth = this.#controls.get_allocation_box().get_width();
        for (const actor of this.#pageClips) {
            const box = actor.get_allocation_box();
            // The actor's x in the controls' coordinates.
            let x = 0;
            for (let a: Clutter.Actor | null = actor; a && a !== this.#controls; a = a.get_parent())
                x += a.get_allocation_box().x1;
            const left = Math.max(0, Math.min(x, leftBand));
            const right = Math.max(0, Math.min(controlsWidth - x - box.get_width(), rightBand));
            actor.set_clip(-left, 0, box.get_width() + left + right, box.get_height());
        }
    }

    destroy() {
        const key = '_computeWorkspacesBoxForState';
        if (Object.getOwnPropertyDescriptor(this.#layout, key)?.value === this.#computeWithRoom) {
            if (this.#computeDescriptor)
                Object.defineProperty(this.#layout, key, this.#computeDescriptor);
            else
                Reflect.deleteProperty(this.#layout, key);
        }
        this.#controls.queue_relayout();
        const layout = this.#appDisplay._appGridLayout;
        if (this.#hintsId)
            layout._pageIndicatorsAdjustment.disconnect(this.#hintsId);
        layout._previousPageIndicator.disconnectObject(this);
        layout._nextPageIndicator.disconnectObject(this);
        this.#appDisplay._grid.disconnectObject(this);
        this.#appDisplay.disconnectObject(this);
        this.#pageClips.forEach((actor, i) => {
            actor.disconnectObject(this);
            const clip = this.#originalClips[i];
            if (clip)
                actor.set_clip(...clip);
            else
                actor.remove_clip();
            actor.clip_to_allocation = this.#pageClipsToAllocation[i];
        });
        // Undo our viewport override at rest. During a drag, the grid
        // restores clipping itself when the page hints finish hiding.
        if (this.#restoreClipToView && !this.#draggingInGrid())
            this.#appDisplay._grid.clip_to_view = true;
        this.#appDisplay.style = this.#style;
        this.#appDisplay.ensure_style();
        this.#appDisplay.queue_relayout();
    }
}
