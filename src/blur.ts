// SPDX-FileCopyrightText: 2026 Tobias Eichert
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import type {Monitor} from 'resource:///org/gnome/shell/ui/layout.js';
import {MonitorGroup} from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

// Blur strength (Shell.BlurEffect radius, logical px).
const BLUR_RADIUS = 30;

// Inset the blur mask by one stage pixel. This keeps its antialiased edge
// under the dock fill and prevents a bright fringe at the corners.
const MASK_INSET = 1;

const MASK_DECLARATIONS = `
uniform vec2 size;
uniform float radius;
uniform float inset;

float rounded_box_coverage(vec2 p) {
    vec2 half_size = size * 0.5;
    vec2 q = abs(p - half_size) - (half_size - vec2(inset + radius));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
    return clamp(0.5 - d, 0.0, 1.0);
}
`;

// Scale all channels to mask cogl_color_out because the offscreen sample uses
// premultiplied alpha.
const MASK_CODE = `
cogl_color_out *= rounded_box_coverage(cogl_tex_coord_in[0].xy * size);
`;

/**
 * Masks an actor to a rounded rectangle (antialiased), like CSS
 * border-radius but for whatever the actor paints, effects included.
 */
const RoundedMaskEffect = GObject.registerClass({
    GTypeName: 'BasedockRoundedMaskEffect',
}, class RoundedMaskEffect extends Clutter.ShaderEffect {
    override vfunc_get_static_snippet() {
        return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT,
            MASK_DECLARATIONS, MASK_CODE);
    }

    /**
     * The mask: a `width`×`height` box with corner `radius`, shrunk by
     * `inset` on every side, its corners concentric with the box's.
     */
    setGeometry(width: number, height: number, radius: number, inset: number) {
        radius = Math.min(radius, width / 2, height / 2);
        this.set_uniform_float('size', 2, [width, height]);
        this.set_uniform_float('inset', 1, [inset]);
        this.set_uniform_float('radius', 1, [Math.max(0, radius - inset)]);
        this.queue_repaint();
    }
});

/**
 * Size this layer to the dock background through
 * BasedockDash.placeOverBackground(). Report zero preferred size so the
 * stage-sized clones inside it do not enlarge the dock.
 */
const BlurLayer = GObject.registerClass({
    GTypeName: 'BasedockBlurLayer',
}, class BlurLayer extends Clutter.Actor {
    override vfunc_get_preferred_width(_forHeight: number): [number, number] {
        return [0, 0];
    }

    override vfunc_get_preferred_height(_forWidth: number): [number, number] {
        return [0, 0];
    }
});

/**
 * Draw a rounded, blurred copy of the scene directly below the dock
 * background. Shell.BlurEffect's BACKGROUND mode samples the framebuffer, but
 * a rounded offscreen mask would make it sample an empty buffer. Instead,
 * align clones with the scene, blur them in ACTOR mode and mask the result
 * just inside the background edge.
 *
 * On the desktop, clone global.window_group. During a workspace switch, also
 * clone the primary monitor's MonitorGroup from js/ui/workspaceAnimation.js so
 * the blur follows the sliding windows and wallpapers.
 *
 * Clone the overview while the dock sits above it. A bottom dock moves inside
 * the overview after the transition, where only the overview's background
 * color lies behind it. Drop the overview clone before reparenting to avoid
 * drawing the dock recursively.
 */
export class DockBlur {
    readonly #target: St.Widget;
    readonly #layer: Clutter.Actor;
    readonly #mask: InstanceType<typeof RoundedMaskEffect>;
    readonly #windowClone: Clutter.Clone;
    /** The overview behind the dock while it animates → its clone. */
    readonly #overviewClones = new Map<Clutter.Actor, Clutter.Clone>();
    /** The dock sits inside the overview (below its window previews). */
    #insideOverview = false;
    readonly #movers: Clutter.Actor[];
    /** Workspace-switch animation groups → their clones, while switching. */
    readonly #switchClones = new Map<Clutter.Actor, {clone: Clutter.Clone, monitor: Monitor}>();
    #inOverview = false;
    /** The overview's animation adjustments, followed (#followOverviewAnimations). */
    #adjustments: [St.Adjustment, number][] = [];

    /**
     * @param target - The dock background, already attached to its parent.
     * @param movers - Ancestors whose movement must realign the clones.
     */
    constructor(target: St.Widget, movers: Clutter.Actor[]) {
        this.#target = target;
        this.#movers = movers;

        this.#windowClone = new Clutter.Clone({source: global.window_group});

        this.#layer = new BlurLayer({
            name: 'basedock-blur',
            clip_to_allocation: true,
            reactive: false,
        });
        this.#layer.add_child(this.#windowClone);

        // Add the mask first so it wraps the blur and clips the blurred
        // result. The blur operates on the clones inside it.
        this.#mask = new RoundedMaskEffect();
        try {
            this.#layer.add_effect(this.#mask);
            this.#layer.add_effect(new Shell.BlurEffect({
                mode: Shell.BlurMode.ACTOR,
                radius: BLUR_RADIUS,
                brightness: 1.0,
            }));

            target.get_parent()!.insert_child_below(this.#layer, target);

            const sync = () => this.#syncClones();
            this.#layer.connectObject('notify::allocation', () => {
                this.#syncMask();
                sync();
            }, this);
            target.connectObject('style-changed', () => this.#syncMask(), this);
            for (const actor of movers) {
                actor.connectObject(
                    'notify::x', sync,
                    'notify::y', sync,
                    'notify::translation-x', sync,
                    'notify::translation-y', sync,
                    'notify::allocation', sync,
                    this);
            }

            Main.overview.connectObject(
                'showing', () => this.#syncSource(true),
                'hidden', () => this.#syncSource(false),
                this);
            this.#syncSource(Main.overview.visible);
            this.#followOverviewAnimations();

            Main.uiGroup.connectObject(
                'child-added', (_group: Clutter.Actor, child: Clutter.Actor) =>
                    this.#onUiChildAdded(child),
                'child-removed', (_group: Clutter.Actor, child: Clutter.Actor) =>
                    this.#onUiChildRemoved(child),
                this);
        } catch (error) {
            this.destroy();
            throw error;
        }
    }

    /**
     * Select the scene to blur based on overview visibility and where the dock
     * is parented.
     */
    #syncSource(inOverview: boolean) {
        this.#inOverview = inOverview;
        // Clone the overview while the dock is above it. Inside the overview,
        // only its background color lies behind the dock, and cloning it would
        // include the dock itself.
        const inside = inOverview && this.#insideOverview;
        if (inOverview) {
            const node = Main.layoutManager.overviewGroup.get_theme_node();
            this.#layer.background_color = node.get_background_color();
        } else {
            this.#layer.background_color = new Cogl.Color({red: 0, green: 0, blue: 0, alpha: 0});
        }
        this.#setOverviewClones(inOverview && !inside);
        this.#syncClones();
        this.#windowClone.visible = !inOverview;
        for (const {clone} of this.#switchClones.values())
            clone.visible = !inOverview;
    }

    /**
     * Keep a stage-sized overviewGroup clone while the dock sits above the
     * overview. Remove it before the dock moves inside its source
     * (Dock.#placeInOverview()) to avoid recursive painting.
     */
    #setOverviewClones(active: boolean) {
        if (active === this.#overviewClones.size > 0)
            return;
        if (!active) {
            for (const clone of this.#overviewClones.values())
                clone.destroy();
            this.#overviewClones.clear();
            return;
        }
        const source = Main.layoutManager.overviewGroup;
        const clone = new Clutter.Clone({
            source,
            width: global.stage.width,
            height: global.stage.height,
        });
        this.#layer.add_child(clone);
        this.#overviewClones.set(source, clone);
    }

    /**
     * Redraw the blurred overview while its animations run. Shell.BlurEffect
     * caches its image until the clone redraws. A clone follows redraws of its
     * source, but an allocation change inside the source may leave the blur
     * frozen.
     *
     * Watch the overview state, workspace scroll and app-grid page adjustments
     * (overviewControls.js and appDisplay.js). They change each frame of their
     * respective animations. Desktop workspace switches already redraw because
     * they translate their actors.
     */
    #followOverviewAnimations() {
        const controls = (Main.overview as unknown as {
            _overview: {_controls: {
                _stateAdjustment: St.Adjustment,
                _workspaceAdjustment: St.Adjustment,
                _appDisplay: {_adjustment: St.Adjustment},
            }},
        })._overview._controls;
        const redraw = () => {
            if (this.#overviewClones.size > 0)
                this.#layer.queue_redraw();
        };
        // Keep raw IDs to avoid signalTracker.js disconnecting from
        // disposed adjustments during Shell shutdown. destroy() disconnects
        // them during normal teardown.
        for (const adjustment of [controls._stateAdjustment, controls._workspaceAdjustment,
            controls._appDisplay._adjustment])
            this.#adjustments.push([adjustment, adjustment.connect('notify::value', redraw)]);
    }

    /**
     * The blurred layer, below `target` in its parent. Whoever lays out
     * that parent places it over `target` (BasedockDash.placeOverBackground,
     * src/dash.ts).
     */
    get layer(): Clutter.Actor {
        return this.#layer;
    }

    /**
     * Update the blur when the dock moves into or out of the overview. Pass
     * true before moving it in to drop the clone first. Pass false after
     * moving it out.
     */
    setInsideOverview(inside: boolean) {
        this.#insideOverview = inside;
        this.#syncSource(this.#inOverview);
    }

    /**
     * A workspace switch starts: clone the primary monitor's MonitorGroup
     * (see DockBlur), so the blur follows the switch animation.
     */
    #onUiChildAdded(child: Clutter.Actor) {
        if (!(child instanceof MonitorGroup))
            return;
        // MonitorGroup stores its monitor in _monitor (workspaceAnimation.js).
        const monitor = (child as unknown as {_monitor: Monitor})._monitor;
        if (monitor?.index !== Main.layoutManager.primaryIndex)
            return;

        // Clutter scales the source to the clone's size. Use the monitor
        // dimensions because MonitorConstraint allocates the group to the
        // monitor while its preferred size spans the whole sliding strip.
        const clone = new Clutter.Clone({
            source: child,
            width: monitor.width,
            height: monitor.height,
            visible: !this.#inOverview,
        });
        this.#layer.add_child(clone);
        this.#switchClones.set(child, {clone, monitor});
        this.#syncClones();
    }

    /** A workspace switch ends: drop its group's clone. */
    #onUiChildRemoved(child: Clutter.Actor) {
        const entry = this.#switchClones.get(child);
        if (!entry)
            return;
        this.#switchClones.delete(child);
        entry.clone.destroy();
    }

    /**
     * Translate the clones to align with the screen. This runs during
     * allocation, where changing their position would queue another layout and
     * trigger Clutter allocation warnings on each frame of motion.
     */
    #syncClones() {
        const [x, y] = this.#layer.get_transformed_position();
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return;
        const place = (clone: Clutter.Actor, cx: number, cy: number) => {
            clone.translation_x = cx;
            clone.translation_y = cy;
        };
        place(this.#windowClone, -Math.round(x), -Math.round(y));
        for (const clone of this.#overviewClones.values())
            place(clone, -Math.round(x), -Math.round(y));
        for (const {clone, monitor} of this.#switchClones.values())
            place(clone, monitor.x - Math.round(x), monitor.y - Math.round(y));
    }

    /** Fit the mask to the layer's size and `target`'s corner radius. */
    #syncMask() {
        const radius = this.#target.get_theme_node()
            .get_border_radius(St.Corner.TOPLEFT);
        this.#mask.setGeometry(this.#layer.width, this.#layer.height, radius, MASK_INSET);
    }

    destroy() {
        for (const actor of [this.#target, this.#layer, ...this.#movers])
            actor.disconnectObject(this);
        Main.overview.disconnectObject(this);
        for (const [adjustment, id] of this.#adjustments)
            adjustment.disconnect(id);
        this.#adjustments = [];
        Main.uiGroup.disconnectObject(this);
        this.#setOverviewClones(false);
        this.#switchClones.clear();
        this.#layer.destroy();
    }
}
