// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported Workspace */

const { Clutter, GLib, GObject, Graphene, Meta, St } = imports.gi;

const Background = imports.ui.background;
const DND = imports.ui.dnd;
const Main = imports.ui.main;
const { WindowPreview } = imports.ui.windowPreview;

var WINDOW_PREVIEW_MAXIMUM_SCALE = 0.95;

var WINDOW_REPOSITIONING_DELAY = 750;

// When calculating a layout, we calculate the scale of windows and the percent
// of the available area the new layout uses. If the values for the new layout,
// when weighted with the values as below, are worse than the previous layout's,
// we stop looking for a new layout and use the previous layout.
// Otherwise, we keep looking for a new layout.
var LAYOUT_SCALE_WEIGHT = 1;
var LAYOUT_SPACE_WEIGHT = 0.1;

function _interpolate(start, end, step) {
    return start + (end - start) * step;
}

// Window Thumbnail Layout Algorithm
// =================================
//
// General overview
// ----------------
//
// The window thumbnail layout algorithm calculates some optimal layout
// by computing layouts with some number of rows, calculating how good
// each layout is, and stopping iterating when it finds one that is worse
// than the previous layout. A layout consists of which windows are in
// which rows, row sizes and other general state tracking that would make
// calculating window positions from this information fairly easy.
//
// After a layout is computed that's considered the best layout, we
// compute the layout scale to fit it in the area, and then compute
// slots (sizes and positions) for each thumbnail.
//
// Layout generation
// -----------------
//
// Layout generation is naive and simple: we simply add windows to a row
// until we've added too many windows to a row, and then make a new row,
// until we have our required N rows. The potential issue with this strategy
// is that we may have too many windows at the bottom in some pathological
// cases, which tends to make the thumbnails have the shape of a pile of
// sand with a peak, with one window at the top.
//
// Scaling factors
// ---------------
//
// Thumbnail position is mostly straightforward -- the main issue is
// computing an optimal scale for each window that fits the constraints,
// and doesn't make the thumbnail too small to see. There are two factors
// involved in thumbnail scale to make sure that these two goals are met:
// the window scale (calculated by _computeWindowScale) and the layout
// scale (calculated by computeSizeAndScale).
//
// The calculation logic becomes slightly more complicated because row
// and column spacing are not scaled, they're constant, so we can't
// simply generate a bunch of window positions and then scale it. In
// practice, it's not too bad -- we can simply try to fit the layout
// in the input area minus whatever spacing we have, and then add
// it back afterwards.
//
// The window scale is constant for the window's size regardless of the
// input area or the layout scale or rows or anything else, and right
// now just enlarges the window if it's too small. The fact that this
// factor is stable makes it easy to calculate, so there's no sense
// in not applying it in most calculations.
//
// The layout scale depends on the input area, the rows, etc, but is the
// same for the entire layout, rather than being per-window. After
// generating the rows of windows, we basically do some basic math to
// fit the full, unscaled layout to the input area, as described above.
//
// With these two factors combined, the final scale of each thumbnail is
// simply windowScale * layoutScale... almost.
//
// There's one additional constraint: the thumbnail scale must never be
// larger than WINDOW_PREVIEW_MAXIMUM_SCALE, which means that the inequality:
//
//   windowScale * layoutScale <= WINDOW_PREVIEW_MAXIMUM_SCALE
//
// must always be true. This is for each individual window -- while we
// could adjust layoutScale to make the largest thumbnail smaller than
// WINDOW_PREVIEW_MAXIMUM_SCALE, it would shrink windows which are already
// under the inequality. To solve this, we simply cheat: we simply keep
// each window's "cell" area to be the same, but we shrink the thumbnail
// and center it horizontally, and align it to the bottom vertically.

var LayoutStrategy = class {
    constructor(monitor, rowSpacing, columnSpacing) {
        if (this.constructor === LayoutStrategy)
            throw new TypeError(`Cannot instantiate abstract type ${this.constructor.name}`);

        this._monitor = monitor;
        this._rowSpacing = rowSpacing;
        this._columnSpacing = columnSpacing;
    }

    _newRow() {
        // Row properties:
        //
        // * x, y are the position of row, relative to area
        //
        // * width, height are the scaled versions of fullWidth, fullHeight
        //
        // * width also has the spacing in between windows. It's not in
        //   fullWidth, as the spacing is constant, whereas fullWidth is
        //   meant to be scaled
        //
        // * neither height/fullHeight have any sort of spacing or padding
        return { x: 0, y: 0,
                 width: 0, height: 0,
                 fullWidth: 0, fullHeight: 0,
                 windows: [] };
    }

    // Computes and returns an individual scaling factor for @window,
    // to be applied in addition to the overall layout scale.
    _computeWindowScale(window) {
        // Since we align windows next to each other, the height of the
        // thumbnails is much more important to preserve than the width of
        // them, so two windows with equal height, but maybe differering
        // widths line up.
        let ratio = window.boundingBox.height / this._monitor.height;

        // The purpose of this manipulation here is to prevent windows
        // from getting too small. For something like a calculator window,
        // we need to bump up the size just a bit to make sure it looks
        // good. We'll use a multiplier of 1.5 for this.

        // Map from [0, 1] to [1.5, 1]
        return _interpolate(1.5, 1, ratio);
    }

    // Compute the size of each row, by assigning to the properties
    // row.width, row.height, row.fullWidth, row.fullHeight, and
    // (optionally) for each row in @layout.rows. This method is
    // intended to be called by subclasses.
    _computeRowSizes(_layout) {
        throw new GObject.NotImplementedError(`_computeRowSizes in ${this.constructor.name}`);
    }

    // Compute strategy-specific window slots for each window in
    // @windows, given the @layout. The strategy may also use @layout
    // as strategy-specific storage.
    //
    // This must calculate:
    //  * maxColumns - The maximum number of columns used by the layout.
    //  * gridWidth - The total width used by the grid, unscaled, unspaced.
    //  * gridHeight - The totial height used by the grid, unscaled, unspaced.
    //  * rows - A list of rows, which should be instantiated by _newRow.
    computeLayout(_windows, _layout) {
        throw new GObject.NotImplementedError(`computeLayout in ${this.constructor.name}`);
    }

    // Given @layout, compute the overall scale and space of the layout.
    // The scale is the individual, non-fancy scale of each window, and
    // the space is the percentage of the available area eventually
    // used by the layout.

    // This method does not return anything, but instead installs
    // the properties "scale" and "space" on @layout directly.
    //
    // Make sure to call this methods before calling computeWindowSlots(),
    // as it depends on the scale property installed in @layout here.
    computeScaleAndSpace(layout) {
        let area = layout.area;

        let hspacing = (layout.maxColumns - 1) * this._columnSpacing;
        let vspacing = (layout.numRows - 1) * this._rowSpacing;

        let spacedWidth = area.width - hspacing;
        let spacedHeight = area.height - vspacing;

        let horizontalScale = spacedWidth / layout.gridWidth;
        let verticalScale = spacedHeight / layout.gridHeight;

        // Thumbnails should be less than 70% of the original size
        let scale = Math.min(
            horizontalScale, verticalScale, WINDOW_PREVIEW_MAXIMUM_SCALE);

        let scaledLayoutWidth = layout.gridWidth * scale + hspacing;
        let scaledLayoutHeight = layout.gridHeight * scale + vspacing;
        let space = (scaledLayoutWidth * scaledLayoutHeight) / (area.width * area.height);

        layout.scale = scale;
        layout.space = space;
    }

    computeWindowSlots(layout, area) {
        this._computeRowSizes(layout);

        let { rows, scale } = layout;

        let slots = [];

        // Do this in three parts.
        let heightWithoutSpacing = 0;
        for (let i = 0; i < rows.length; i++) {
            let row = rows[i];
            heightWithoutSpacing += row.height;
        }

        let verticalSpacing = (rows.length - 1) * this._rowSpacing;
        let additionalVerticalScale = Math.min(1, (area.height - verticalSpacing) / heightWithoutSpacing);

        // keep track how much smaller the grid becomes due to scaling
        // so it can be centered again
        let compensation = 0;
        let y = 0;

        for (let i = 0; i < rows.length; i++) {
            let row = rows[i];

            // If this window layout row doesn't fit in the actual
            // geometry, then apply an additional scale to it.
            let horizontalSpacing = (row.windows.length - 1) * this._columnSpacing;
            let widthWithoutSpacing = row.width - horizontalSpacing;
            let additionalHorizontalScale = Math.min(1, (area.width - horizontalSpacing) / widthWithoutSpacing);

            if (additionalHorizontalScale < additionalVerticalScale) {
                row.additionalScale = additionalHorizontalScale;
                // Only consider the scaling in addition to the vertical scaling for centering.
                compensation += (additionalVerticalScale - additionalHorizontalScale) * row.height;
            } else {
                row.additionalScale = additionalVerticalScale;
                // No compensation when scaling vertically since centering based on a too large
                // height would undo what vertical scaling is trying to achieve.
            }

            row.x = area.x + (Math.max(area.width - (widthWithoutSpacing * row.additionalScale + horizontalSpacing), 0) / 2);
            row.y = area.y + (Math.max(area.height - (heightWithoutSpacing + verticalSpacing), 0) / 2) + y;
            y += row.height * row.additionalScale + this._rowSpacing;
        }

        compensation /= 2;

        for (let i = 0; i < rows.length; i++) {
            let row = rows[i];
            let x = row.x;
            for (let j = 0; j < row.windows.length; j++) {
                let window = row.windows[j];

                let s = scale * this._computeWindowScale(window) * row.additionalScale;
                let cellWidth = window.boundingBox.width * s;
                let cellHeight = window.boundingBox.height * s;

                s = Math.min(s, WINDOW_PREVIEW_MAXIMUM_SCALE);
                let cloneWidth = window.boundingBox.width * s;
                const cloneHeight = window.boundingBox.height * s;

                let cloneX = x + (cellWidth - cloneWidth) / 2;
                let cloneY = row.y + row.height * row.additionalScale - cellHeight + compensation;

                // Align with the pixel grid to prevent blurry windows at scale = 1
                cloneX = Math.floor(cloneX);
                cloneY = Math.floor(cloneY);

                slots.push([cloneX, cloneY, cloneWidth, cloneHeight, window]);
                x += cellWidth + this._columnSpacing;
            }
        }
        return slots;
    }
};

var UnalignedLayoutStrategy = class extends LayoutStrategy {
    _computeRowSizes(layout) {
        let { rows, scale } = layout;
        for (let i = 0; i < rows.length; i++) {
            let row = rows[i];
            row.width = row.fullWidth * scale + (row.windows.length - 1) * this._columnSpacing;
            row.height = row.fullHeight * scale;
        }
    }

    _keepSameRow(row, window, width, idealRowWidth) {
        if (row.fullWidth + width <= idealRowWidth)
            return true;

        let oldRatio = row.fullWidth / idealRowWidth;
        let newRatio = (row.fullWidth + width) / idealRowWidth;

        if (Math.abs(1 - newRatio) < Math.abs(1 - oldRatio))
            return true;

        return false;
    }

    _sortRow(row) {
        // Sort windows horizontally to minimize travel distance.
        // This affects in what order the windows end up in a row.
        row.windows.sort((a, b) => a.windowCenter.x - b.windowCenter.x);
    }

    computeLayout(windows, layout) {
        let numRows = layout.numRows;

        let rows = [];
        let totalWidth = 0;
        for (let i = 0; i < windows.length; i++) {
            let window = windows[i];
            let s = this._computeWindowScale(window);
            totalWidth += window.boundingBox.width * s;
        }

        let idealRowWidth = totalWidth / numRows;

        // Sort windows vertically to minimize travel distance.
        // This affects what rows the windows get placed in.
        let sortedWindows = windows.slice();
        sortedWindows.sort((a, b) => a.windowCenter.y - b.windowCenter.y);

        let windowIdx = 0;
        for (let i = 0; i < numRows; i++) {
            let row = this._newRow();
            rows.push(row);

            for (; windowIdx < sortedWindows.length; windowIdx++) {
                let window = sortedWindows[windowIdx];
                let s = this._computeWindowScale(window);
                let width = window.boundingBox.width * s;
                let height = window.boundingBox.height * s;
                row.fullHeight = Math.max(row.fullHeight, height);

                // either new width is < idealWidth or new width is nearer from idealWidth then oldWidth
                if (this._keepSameRow(row, window, width, idealRowWidth) || (i == numRows - 1)) {
                    row.windows.push(window);
                    row.fullWidth += width;
                } else {
                    break;
                }
            }
        }

        let gridHeight = 0;
        let maxRow;
        for (let i = 0; i < numRows; i++) {
            let row = rows[i];
            this._sortRow(row);

            if (!maxRow || row.fullWidth > maxRow.fullWidth)
                maxRow = row;
            gridHeight += row.fullHeight;
        }

        layout.rows = rows;
        layout.maxColumns = maxRow.windows.length;
        layout.gridWidth = maxRow.fullWidth;
        layout.gridHeight = gridHeight;
    }
};

function animateAllocation(actor, box) {
    if (actor.allocation.equal(box) ||
        actor.allocation.get_width() === 0 ||
        actor.allocation.get_height() === 0) {
        actor.allocate(box);
        return null;
    }

    actor.save_easing_state();
    actor.set_easing_mode(Clutter.AnimationMode.EASE_OUT_QUAD);
    actor.set_easing_duration(200);

    actor.allocate(box);

    actor.restore_easing_state();

    return actor.get_transition('allocation');
}

var WorkspaceLayout = GObject.registerClass({
    Properties: {
        'spacing': GObject.ParamSpec.double(
            'spacing', 'Spacing', 'Spacing',
            GObject.ParamFlags.READWRITE,
            0, Infinity, 20),
        'layout-frozen': GObject.ParamSpec.boolean(
            'layout-frozen', 'Layout frozen', 'Layout frozen',
            GObject.ParamFlags.READWRITE,
            false),
    },
}, class WorkspaceLayout extends Clutter.LayoutManager {
    _init(metaWorkspace, monitorIndex) {
        super._init();

        this._spacing = 20;
        this._layoutFrozen = false;

        this._monitorIndex = monitorIndex;
        this._metaWorkspace = metaWorkspace;
        this._workarea = metaWorkspace
            ? metaWorkspace.get_work_area_for_monitor(this._monitorIndex)
            : Main.layoutManager.getWorkAreaForMonitor(this._monitorIndex);

        this._container = null;
        this._windows = new Map();
        this._sortedWindows = [];
        this._background = null;
        this._lastBox = null;
        this._windowSlots = [];
        this._layout = null;

        this._stateAdjustment = new St.Adjustment({
            value: 0,
            lower: 0,
            upper: 1,
        });

        this._stateAdjustment.connect('notify::value', () => {
            [...this._windows.keys()].forEach(
                preview => this._syncOverlay(preview));
            this.layout_changed();
        });
    }

    _isBetterLayout(oldLayout, newLayout) {
        if (oldLayout.scale === undefined)
            return true;

        let spacePower = (newLayout.space - oldLayout.space) * LAYOUT_SPACE_WEIGHT;
        let scalePower = (newLayout.scale - oldLayout.scale) * LAYOUT_SCALE_WEIGHT;

        if (newLayout.scale > oldLayout.scale && newLayout.space > oldLayout.space) {
            // Win win -- better scale and better space
            return true;
        } else if (newLayout.scale > oldLayout.scale && newLayout.space <= oldLayout.space) {
            // Keep new layout only if scale gain outweighs aspect space loss
            return scalePower > spacePower;
        } else if (newLayout.scale <= oldLayout.scale && newLayout.space > oldLayout.space) {
            // Keep new layout only if aspect space gain outweighs scale loss
            return spacePower > scalePower;
        } else {
            // Lose -- worse scale and space
            return false;
        }
    }

    _adjustSpacingAndPadding(rowSpacing, colSpacing, containerBox) {
        if (this._sortedWindows.length === 0)
            return [colSpacing, rowSpacing, containerBox];

        // All of the overlays have the same chrome sizes,
        // so just pick the first one.
        const window = this._sortedWindows[0];

        const [topOversize, bottomOversize] = window.chromeHeights();
        const [leftOversize, rightOversize] = window.chromeWidths();

        if (rowSpacing)
            rowSpacing += Math.max(topOversize, bottomOversize);
        if (colSpacing)
            colSpacing += Math.max(leftOversize, rightOversize);

        if (containerBox) {
            containerBox.x1 += leftOversize;
            containerBox.x2 -= rightOversize;
            containerBox.y1 += topOversize;
            containerBox.y2 -= bottomOversize;
        }

        return [rowSpacing, colSpacing, containerBox];
    }

    _createBestLayout(area) {
        const [rowSpacing, colSpacing] =
            this._adjustSpacingAndPadding(this._spacing, this._spacing, null);

        // We look for the largest scale that allows us to fit the
        // largest row/tallest column on the workspace.
        const strategy = new UnalignedLayoutStrategy(
            Main.layoutManager.monitors[this._monitorIndex],
            rowSpacing,
            colSpacing);

        let lastLayout = {};

        for (let numRows = 1; ; numRows++) {
            let numColumns = Math.ceil(this._sortedWindows.length / numRows);

            // If adding a new row does not change column count just stop
            // (for instance: 9 windows, with 3 rows -> 3 columns, 4 rows ->
            // 3 columns as well => just use 3 rows then)
            if (numColumns === lastLayout.numColumns)
                break;

            let layout = { area, strategy, numRows, numColumns };
            strategy.computeLayout(this._sortedWindows, layout);
            strategy.computeScaleAndSpace(layout);

            if (!this._isBetterLayout(lastLayout, layout))
                break;

            lastLayout = layout;
        }

        return lastLayout;
    }

    _getWindowSlots(containerBox) {
        [, , containerBox] =
            this._adjustSpacingAndPadding(null, null, containerBox);

        const availArea = {
            x: parseInt(containerBox.x1),
            y: parseInt(containerBox.y1),
            width: parseInt(containerBox.get_width()),
            height: parseInt(containerBox.get_height()),
        };

        return this._layout.strategy.computeWindowSlots(this._layout, availArea);
    }

    _getAdjustedWorkarea(container) {
        const workarea = this._workarea.copy();

        if (container instanceof St.Widget) {
            const themeNode = container.get_theme_node();
            workarea.width -= themeNode.get_horizontal_padding();
            workarea.height -= themeNode.get_vertical_padding();
        }

        return workarea;
    }

    vfunc_set_container(container) {
        this._container = container;
        this._stateAdjustment.actor = container;
    }

    vfunc_get_preferred_width(container, forHeight) {
        const workarea = this._getAdjustedWorkarea(container);
        if (forHeight === -1)
            return [0, workarea.width];

        const workAreaAspectRatio = workarea.width / workarea.height;
        const widthPreservingAspectRatio = forHeight * workAreaAspectRatio;

        return [0, widthPreservingAspectRatio];
    }

    vfunc_get_preferred_height(container, forWidth) {
        const workarea = this._getAdjustedWorkarea(container);
        if (forWidth === -1)
            return [0, workarea.height];

        const workAreaAspectRatio = workarea.width / workarea.height;
        const heightPreservingAspectRatio = forWidth / workAreaAspectRatio;

        return [0, heightPreservingAspectRatio];
    }

    vfunc_allocate(container, box) {
        const containerBox = container.allocation;
        const containerAllocationChanged =
            this._lastBox === null || !this._lastBox.equal(containerBox);
        this._lastBox = containerBox.copy();

        // If the containers size changed, we can no longer keep around
        // the old windowSlots, so we must unfreeze the layout.
        //
        // However, if the overview animation is in progress, don't unfreeze
        // the layout. This is needed to prevent windows "snapping" to their
        // new positions during the overview closing animation when the
        // allocation subtly expands every frame.
        if (this._layoutFrozen && containerAllocationChanged && !Main.overview.animationInProgress) {
            this._layoutFrozen = false;
            this.notify('layout-frozen');
        }

        let layoutChanged = false;
        if (!this._layoutFrozen) {
            if (this._layout === null) {
                this._layout = this._createBestLayout(this._workarea);
                layoutChanged = true;
            }

            if (layoutChanged || containerAllocationChanged)
                this._windowSlots = this._getWindowSlots(box.copy());
        }

        if (this._background)
            this._background.allocate(box);

        if (this._cover)
            this._cover.allocate(box);

        const allocationScale = containerBox.get_width() / this._workarea.width;

        const workspaceBox = new Clutter.ActorBox();
        const layoutBox = new Clutter.ActorBox();
        let childBox = new Clutter.ActorBox();

        for (const child of container) {
            if (!child.visible ||
                child === this._background ||
                child === this._cover)
                continue;

            // The fifth element in the slot array is the WindowPreview
            const index = this._windowSlots.findIndex(s => s[4] === child);
            if (index === -1) {
                log('Couldn\'t find child %s in window slots'.format(child));
                child.allocate(childBox);
                continue;
            }

            const [x, y, width, height] = this._windowSlots[index];
            const windowInfo = this._windows.get(child);

            if (windowInfo.metaWindow.showing_on_its_workspace()) {
                workspaceBox.x1 = child.boundingBox.x - this._workarea.x;
                workspaceBox.x2 = workspaceBox.x1 + child.boundingBox.width;
                workspaceBox.y1 = child.boundingBox.y - this._workarea.y;
                workspaceBox.y2 = workspaceBox.y1 + child.boundingBox.height;
            } else {
                workspaceBox.set_origin(this._workarea.x, this._workarea.y);
                workspaceBox.set_size(0, 0);

                child.opacity = this._stateAdjustment.value * 255;
            }

            workspaceBox.scale(allocationScale);
            // don't allow the scaled floating size to drop below
            // the target layout size
            workspaceBox.set_size(
                Math.max(workspaceBox.get_width(), width),
                Math.max(workspaceBox.get_height(), height));

            layoutBox.x1 = x;
            layoutBox.x2 = layoutBox.x1 + width;
            layoutBox.y1 = y;
            layoutBox.y2 = layoutBox.y1 + height;

            childBox = workspaceBox.interpolate(layoutBox,
                this._stateAdjustment.value);

            if (windowInfo.currentTransition) {
                windowInfo.currentTransition.get_interval().set_final(childBox);

                // The timeline of the transition might not have been updated
                // before this allocation cycle, so make sure the child
                // still updates needs_allocation to FALSE.
                // Unfortunately, this relies on the fast paths in
                // clutter_actor_allocate(), otherwise we'd start a new
                // transition on the child, replacing the current one.
                child.allocate(child.allocation);
                continue;
            }

            // We want layout changes (ie. larger changes to the layout like
            // reshuffling the window order) to be animated, but small changes
            // like changes to the container size to happen immediately (for
            // example if the container height is being animated, we want to
            // avoid animating the children allocations to make sure they
            // don't "lag behind" the other animation).
            if (layoutChanged && !Main.overview.animationInProgress) {
                const transition = animateAllocation(child, childBox);
                if (transition) {
                    windowInfo.currentTransition = transition;
                    windowInfo.currentTransition.connect('stopped', () => {
                        windowInfo.currentTransition = null;
                    });
                }
            } else {
                child.allocate(childBox);
            }
        }
    }

    _syncOverlay(preview) {
        preview.overlay_enabled = this._stateAdjustment.value === 1;
    }

    /**
     * addWindow:
     * @param {WindowPreview} window: the window to add
     * @param {Meta.Window} metaWindow: the MetaWindow of the window
     *
     * Adds @window to the workspace, it will be shown immediately if
     * the layout isn't frozen using the layout-frozen property.
     *
     * If @window is already part of the workspace, nothing will happen.
     */
    addWindow(window, metaWindow) {
        if (this._windows.has(window))
            return;

        this._windows.set(window, {
            metaWindow,
            sizeChangedId: metaWindow.connect('size-changed', () => {
                this._layout = null;
                this.layout_changed();
            }),
            destroyId: window.connect('destroy', () =>
                this.removeWindow(window)),
            currentTransition: null,
        });

        this._sortedWindows.push(window);
        this._sortedWindows.sort((a, b) => {
            const winA = this._windows.get(a).metaWindow;
            const winB = this._windows.get(b).metaWindow;

            return winA.get_stable_sequence() - winB.get_stable_sequence();
        });

        this._syncOverlay(window);
        this._container.add_child(window);

        this._layout = null;
        this.layout_changed();
    }

    /**
     * removeWindow:
     * @param {WindowPreview} window: the window to remove
     *
     * Removes @window from the workspace if @window is a part of the
     * workspace. If the layout-frozen property is set to true, the
     * window will still be visible until the property is set to false.
     */
    removeWindow(window) {
        const windowInfo = this._windows.get(window);
        if (!windowInfo)
            return;

        windowInfo.metaWindow.disconnect(windowInfo.sizeChangedId);
        window.disconnect(windowInfo.destroyId);
        if (windowInfo.currentTransition)
            window.remove_transition('allocation');

        this._windows.delete(window);
        this._sortedWindows.splice(this._sortedWindows.indexOf(window), 1);

        // The layout might be frozen and we might not update the windowSlots
        // on the next allocation, so remove the slot now already
        this._windowSlots.splice(
            this._windowSlots.findIndex(s => s[4] === window), 1);

        // The window might have been reparented by DND
        if (window.get_parent() === this._container)
            this._container.remove_child(window);

        this._layout = null;
        this.layout_changed();
    }

    setBackground(background) {
        if (this._background)
            this._container.remove_child(this._background);

        this._background = background;

        if (this._background)
            this._container.add_child(this._background);
    }

    setCover(cover) {
        if (this._cover)
            this._container.remove_child(this._cover);

        this._cover = cover;

        if (this._cover)
            this._container.add_child(this._cover);
    }

    syncStacking(stackIndices) {
        const windows = [...this._windows.keys()];
        windows.sort((a, b) => {
            const seqA = this._windows.get(a).metaWindow.get_stable_sequence();
            const seqB = this._windows.get(b).metaWindow.get_stable_sequence();

            return stackIndices[seqA] - stackIndices[seqB];
        });

        let lastWindow = this._background;
        for (const window of windows) {
            window.setStackAbove(lastWindow);
            lastWindow = window;
        }

        this.restackCover();

        this._layout = null;
        this.layout_changed();
    }

    restackCover() {
        const workspaceManager = global.workspace_manager;
        const isActiveWorkspace = this._metaWorkspace
            ? this._metaWorkspace === workspaceManager.get_active_workspace()
            : true;

        this._container.set_child_above_sibling(
            this._cover,
            isActiveWorkspace ? this._background : null);
    }

    /**
     * getFocusChain:
     *
     * Gets the focus chain of the workspace. This function will return
     * an empty array if the floating window layout is used.
     *
     * @returns {Array} an array of {Clutter.Actor}s
     */
    getFocusChain() {
        if (this._stateAdjustment.value === 0)
            return [];

        // The fifth element in the slot array is the WindowPreview
        return this._windowSlots.map(s => s[4]);
    }

    /**
     * An StAdjustment for controlling and transitioning between
     * the alignment of windows using the layout strategy and the
     * floating window layout.
     *
     * A value of 0 of the adjustment completely uses the floating
     * window layout while a value of 1 completely aligns windows using
     * the layout strategy.
     *
     * @type {St.Adjustment}
     */
    get stateAdjustment() {
        return this._stateAdjustment;
    }

    get spacing() {
        return this._spacing;
    }

    set spacing(s) {
        if (this._spacing === s)
            return;

        this._spacing = s;

        this._layout = null;
        this.notify('spacing');
        this.layout_changed();
    }

    // eslint-disable-next-line camelcase
    get layout_frozen() {
        return this._layoutFrozen;
    }

    // eslint-disable-next-line camelcase
    set layout_frozen(f) {
        if (this._layoutFrozen === f)
            return;

        this._layoutFrozen = f;

        this.notify('layout-frozen');
        if (!this._layoutFrozen)
            this.layout_changed();
    }
});

var WorkspaceBackground = GObject.registerClass(
class WorkspaceBackground extends St.Widget {
    _init(monitorIndex) {
        super._init({
            style_class: 'workspace-background',
            reactive: false,
            clip_to_allocation: true,
        });

        this._monitorIndex = monitorIndex;
        this._workarea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);

        this._backgroundGroup = new Meta.BackgroundGroup({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._backgroundGroup);

        this._bgManager = null;

        this.update();

        this.connect('destroy', this._onDestroy.bind(this));
    }

    _getAdjustedWorkarea() {
        const workarea = this._workarea.copy();

        const themeNode = this.get_theme_node();
        workarea.width -= themeNode.get_horizontal_padding();
        workarea.height -= themeNode.get_vertical_padding();

        return workarea;
    }

    vfunc_get_preferred_width(forHeight) {
        const workarea = this._getAdjustedWorkarea();
        if (forHeight === -1)
            return [0, workarea.width];

        const workAreaAspectRatio = workarea.width / workarea.height;
        const widthPreservingAspectRatio = forHeight * workAreaAspectRatio;

        return [0, widthPreservingAspectRatio];
    }

    vfunc_get_preferred_height(forWidth) {
        const workarea = this._getAdjustedWorkarea();
        if (forWidth === -1)
            return [0, workarea.height];

        const workAreaAspectRatio = workarea.width / workarea.height;
        const heightPreservingAspectRatio = forWidth / workAreaAspectRatio;

        return [0, heightPreservingAspectRatio];
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        const themeNode = this.get_theme_node();
        const contentBox = themeNode.get_content_box(box);

        const [contentWidth, contentHeight] = contentBox.get_size();
        const monitor = Main.layoutManager.monitors[this._monitorIndex];
        const xOff = (contentWidth / this._workarea.width) *
            (this._workarea.x - monitor.x);
        const yOff = (contentHeight / this._workarea.height) *
            (this._workarea.y - monitor.y);

        contentBox.x1 -= xOff;
        contentBox.y1 -= yOff;
        contentBox.set_size(xOff + contentWidth, yOff + contentHeight);
        this._backgroundGroup.allocate(contentBox);
    }


    _onDestroy() {
        if (this._bgManager) {
            this._bgManager.destroy();
            this._bgManager = null;
        }
    }

    update() {
        if (this._bgManager) {
            this._bgManager.destroy();
            this._bgManager = null;
        }

        this._bgManager = new Background.BackgroundManager({
            container: this._backgroundGroup,
            monitorIndex: this._monitorIndex,
            controlPosition: false,
            forceSize: false,
        });
    }
});

/**
 * @metaWorkspace: a #Meta.Workspace, or null
 */
var Workspace = GObject.registerClass(
class Workspace extends St.Widget {
    _init(metaWorkspace, monitorIndex) {
        super._init({
            style_class: 'window-picker',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
            layout_manager: new WorkspaceLayout(metaWorkspace, monitorIndex),
        });

        this.metaWorkspace = metaWorkspace;

        this.monitorIndex = monitorIndex;
        this._monitor = Main.layoutManager.monitors[this.monitorIndex];

        if (monitorIndex != Main.layoutManager.primaryIndex)
            this.add_style_class_name('external-monitor');

        // Background
        this._background = new WorkspaceBackground(monitorIndex);
        this.layout_manager.setBackground(this._background);

        // Cover
        this._cover = new Clutter.Actor({ reactive: true });
        this.layout_manager.setCover(this._cover);

        // Click action
        const workspaceManager = global.workspace_manager;

        const clickAction = new Clutter.ClickAction({ name: 'click' });
        clickAction.connect('clicked', () => {
            if (!this.metaWorkspace)
                return;

            if (clickAction.get_button() !== 1 && clickAction.get_button() !== 0)
                return;

            const workspaceIndex = this.metaWorkspace.index();

            if (workspaceIndex !== workspaceManager.get_active_workspace_index())
                Main.wm.actionMoveWorkspace(this.metaWorkspace);
            else
                Main.overview.hide();
        });
        this._cover.add_action(clickAction);

        this._switchWorkspaceId =
            global.window_manager.connect('switch-workspace',
                this._updateCover.bind(this));

        this._reorderWorkspacesdId =
            workspaceManager.connect('workspaces-reordered',
                this._updateCover.bind(this));

        this.connect('style-changed', this._onStyleChanged.bind(this));
        this.connect('destroy', this._onDestroy.bind(this));

        const windows = global.get_window_actors().map(a => a.meta_window)
            .filter(this._isMyWindow, this);

        // Create clones for windows that should be
        // visible in the Overview
        this._windows = [];
        for (let i = 0; i < windows.length; i++) {
            if (this._isOverviewWindow(windows[i]))
                this._addWindowClone(windows[i]);
        }

        // Track window changes
        if (this.metaWorkspace) {
            this._windowAddedId = this.metaWorkspace.connect('window-added',
                                                             this._windowAdded.bind(this));
            this._windowRemovedId = this.metaWorkspace.connect('window-removed',
                                                               this._windowRemoved.bind(this));
        }
        this._windowEnteredMonitorId = global.display.connect('window-entered-monitor',
                                                              this._windowEnteredMonitor.bind(this));
        this._windowLeftMonitorId = global.display.connect('window-left-monitor',
                                                           this._windowLeftMonitor.bind(this));
        this._layoutFrozenId = 0;

        this._updateCover();

        // DND requires this to be set
        this._delegate = this;
    }

    _updateCover() {
        this.layout_manager.restackCover();
    }

    vfunc_get_focus_chain() {
        return this.layout_manager.getFocusChain();
    }

    _lookupIndex(metaWindow) {
        return this._windows.findIndex(w => w.metaWindow == metaWindow);
    }

    containsMetaWindow(metaWindow) {
        return this._lookupIndex(metaWindow) >= 0;
    }

    isEmpty() {
        return this._windows.length == 0;
    }

    syncStacking(stackIndices) {
        this.layout_manager.syncStacking(stackIndices);
    }

    _doRemoveWindow(metaWin) {
        let clone = this._removeWindowClone(metaWin);

        if (!clone)
            return;

        clone.destroy();

        // We need to reposition the windows; to avoid shuffling windows
        // around while the user is interacting with the workspace, we delay
        // the positioning until the pointer remains still for at least 750 ms
        // or is moved outside the workspace
        this.layout_manager.layout_frozen = true;

        if (this._layoutFrozenId > 0) {
            GLib.source_remove(this._layoutFrozenId);
            this._layoutFrozenId = 0;
        }

        let [oldX, oldY] = global.get_pointer();

        this._layoutFrozenId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            WINDOW_REPOSITIONING_DELAY,
            () => {
                const [newX, newY] = global.get_pointer();
                const pointerHasMoved = oldX !== newX || oldY !== newY;
                const actorUnderPointer = global.stage.get_actor_at_pos(
                    Clutter.PickMode.REACTIVE, newX, newY);

                if ((pointerHasMoved && this.contains(actorUnderPointer)) ||
                    this._windows.some(w => w.contains(actorUnderPointer))) {
                    oldX = newX;
                    oldY = newY;
                    return GLib.SOURCE_CONTINUE;
                }

                this.layout_manager.layout_frozen = false;
                this._layoutFrozenId = 0;
                return GLib.SOURCE_REMOVE;
            });

        GLib.Source.set_name_by_id(this._layoutFrozenId,
            '[gnome-shell] this._layoutFrozenId');
    }

    _doAddWindow(metaWin) {
        let win = metaWin.get_compositor_private();

        if (!win) {
            // Newly-created windows are added to a workspace before
            // the compositor finds out about them...
            let id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (metaWin.get_compositor_private() &&
                    metaWin.get_workspace() == this.metaWorkspace)
                    this._doAddWindow(metaWin);
                return GLib.SOURCE_REMOVE;
            });
            GLib.Source.set_name_by_id(id, '[gnome-shell] this._doAddWindow');
            return;
        }

        // We might have the window in our list already if it was on all workspaces and
        // now was moved to this workspace
        if (this._lookupIndex(metaWin) != -1)
            return;

        if (!this._isMyWindow(metaWin))
            return;

        if (!this._isOverviewWindow(metaWin)) {
            if (metaWin.get_transient_for() == null)
                return;

            // Let the top-most ancestor handle all transients
            let parent = metaWin.find_root_ancestor();
            let clone = this._windows.find(c => c.metaWindow == parent);

            // If no clone was found, the parent hasn't been created yet
            // and will take care of the dialog when added
            if (clone)
                clone.addDialog(metaWin);

            return;
        }

        const clone = this._addWindowClone(metaWin);

        clone.set_pivot_point(0.5, 0.5);
        clone.scale_x = 0;
        clone.scale_y = 0;
        clone.ease({
            scale_x: 1,
            scale_y: 1,
            duration: 250,
            onStopped: () => clone.set_pivot_point(0, 0),
        });

        if (this._layoutFrozenId > 0) {
            // If a window was closed before, unfreeze the layout to ensure
            // the new window is immediately shown
            this.layout_manager.layout_frozen = false;

            GLib.source_remove(this._layoutFrozenId);
            this._layoutFrozenId = 0;
        }
    }

    _windowAdded(metaWorkspace, metaWin) {
        this._doAddWindow(metaWin);
    }

    _windowRemoved(metaWorkspace, metaWin) {
        this._doRemoveWindow(metaWin);
    }

    _windowEnteredMonitor(metaDisplay, monitorIndex, metaWin) {
        if (monitorIndex == this.monitorIndex)
            this._doAddWindow(metaWin);
    }

    _windowLeftMonitor(metaDisplay, monitorIndex, metaWin) {
        if (monitorIndex == this.monitorIndex)
            this._doRemoveWindow(metaWin);
    }

    // check for maximized windows on the workspace
    hasMaximizedWindows() {
        for (let i = 0; i < this._windows.length; i++) {
            let metaWindow = this._windows[i].metaWindow;
            if (metaWindow.showing_on_its_workspace() &&
                metaWindow.maximized_horizontally &&
                metaWindow.maximized_vertically)
                return true;
        }
        return false;
    }

    prepareToLeaveOverview() {
        for (let i = 0; i < this._windows.length; i++)
            this._windows[i].remove_all_transitions();

        if (this._layoutFrozenId > 0) {
            GLib.source_remove(this._layoutFrozenId);
            this._layoutFrozenId = 0;
        }

        this.layout_manager.layout_frozen = true;
        this._overviewHiddenId = Main.overview.connect('hidden', this._doneLeavingOverview.bind(this));
    }

    _onDestroy() {
        if (this._overviewHiddenId) {
            Main.overview.disconnect(this._overviewHiddenId);
            this._overviewHiddenId = 0;
        }

        if (this._switchWorkspaceId) {
            global.window_manager.disconnect(this._switchWorkspaceId);
            delete this._switchWorkspaceId;
        }

        if (this._reorderWorkspacesdId) {
            global.workspace_manager.disconnect(this._reorderWorkspacesdId);
            delete this._reorderWorkspacesdId;
        }

        if (this.metaWorkspace) {
            this.metaWorkspace.disconnect(this._windowAddedId);
            this.metaWorkspace.disconnect(this._windowRemovedId);
        }
        global.display.disconnect(this._windowEnteredMonitorId);
        global.display.disconnect(this._windowLeftMonitorId);

        if (this._layoutFrozenId > 0) {
            GLib.source_remove(this._layoutFrozenId);
            this._layoutFrozenId = 0;
        }

        this._windows = [];
    }

    _doneLeavingOverview() {
        this.layout_manager.layout_frozen = false;
    }

    _doneShowingOverview() {
        this.layout_manager.layout_frozen = false;
    }

    _isMyWindow(window) {
        const isOnWorkspace = this.metaWorkspace === null ||
            window.located_on_workspace(this.metaWorkspace);
        const isOnMonitor = window.get_monitor() === this.monitorIndex;

        return isOnWorkspace && isOnMonitor;
    }

    _isOverviewWindow(window) {
        return !window.skip_taskbar;
    }

    // Create a clone of a (non-desktop) window and add it to the window list
    _addWindowClone(metaWindow) {
        let clone = new WindowPreview(metaWindow, this);

        clone.connect('selected',
                      this._onCloneSelected.bind(this));
        clone.connect('drag-begin', () => {
            Main.overview.beginWindowDrag(metaWindow);
        });
        clone.connect('drag-cancelled', () => {
            Main.overview.cancelledWindowDrag(metaWindow);
            this._updateCover();
        });
        clone.connect('drag-end', () => {
            Main.overview.endWindowDrag(metaWindow);
            this._updateCover();
        });
        clone.connect('show-chrome', () => {
            let focus = global.stage.key_focus;
            if (focus == null || this.contains(focus))
                clone.grab_key_focus();

            this._windows.forEach(c => {
                if (c !== clone)
                    c.hideOverlay(true);
            });
        });
        clone.connect('destroy', () => {
            this._doRemoveWindow(metaWindow);
        });

        this.layout_manager.addWindow(clone, metaWindow);

        if (this._windows.length == 0)
            clone.setStackAbove(this._background);
        else
            clone.setStackAbove(this._windows[this._windows.length - 1]);

        this._windows.push(clone);

        return clone;
    }

    _removeWindowClone(metaWin) {
        // find the position of the window in our list
        let index = this._lookupIndex(metaWin);

        if (index == -1)
            return null;

        this.layout_manager.removeWindow(this._windows[index]);

        return this._windows.splice(index, 1).pop();
    }

    _onStyleChanged() {
        const themeNode = this.get_theme_node();
        this.layout_manager.spacing = themeNode.get_length('spacing');
    }

    _onCloneSelected(clone, time) {
        const wsIndex = this.metaWorkspace?.index();
        Main.activateWindow(clone.metaWindow, time, wsIndex);
    }

    // Draggable target interface
    handleDragOver(source, _actor, _x, _y, _time) {
        if (source.metaWindow && !this._isMyWindow(source.metaWindow))
            return DND.DragMotionResult.MOVE_DROP;
        if (source.app && source.app.can_open_new_window())
            return DND.DragMotionResult.COPY_DROP;
        if (!source.app && source.shellWorkspaceLaunch)
            return DND.DragMotionResult.COPY_DROP;

        return DND.DragMotionResult.CONTINUE;
    }

    acceptDrop(source, actor, x, y, time) {
        let workspaceManager = global.workspace_manager;
        let workspaceIndex = this.metaWorkspace
            ? this.metaWorkspace.index()
            : workspaceManager.get_active_workspace_index();

        if (source.metaWindow) {
            const window = source.metaWindow;
            if (this._isMyWindow(window))
                return false;

            // We need to move the window before changing the workspace, because
            // the move itself could cause a workspace change if the window enters
            // the primary monitor
            if (window.get_monitor() != this.monitorIndex)
                window.move_to_monitor(this.monitorIndex);

            window.change_workspace_by_index(workspaceIndex, false);
            return true;
        } else if (source.app && source.app.can_open_new_window()) {
            if (source.animateLaunchAtPos)
                source.animateLaunchAtPos(actor.x, actor.y);

            source.app.open_new_window(workspaceIndex);
            return true;
        } else if (!source.app && source.shellWorkspaceLaunch) {
            // While unused in our own drag sources, shellWorkspaceLaunch allows
            // extensions to define custom actions for their drag sources.
            source.shellWorkspaceLaunch({ workspace: workspaceIndex,
                                          timestamp: time });
            return true;
        }

        return false;
    }

    get stateAdjustment() {
        return this.layout_manager.stateAdjustment;
    }
});
