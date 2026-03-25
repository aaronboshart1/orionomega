/**
 * @module components/layer-group
 * Groups workflow nodes by execution layer with visual headers.
 * Supports collapsing completed layers to a single summary line.
 *
 * Header formats:
 *   Active:    ═══ Layer N (completed/total) ═══
 *   Pending:   ─── Layer N ───
 *   Collapsed: ▸ Layer N — ✓ done/total complete · duration
 */

import { Container, Text } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import { palette, spacing, icons, box } from '../theme.js';
import { formatDuration } from '../utils/format.js';
import type { NodeDisplay } from './node-display.js';

export type LayerStatus = 'pending' | 'active' | 'complete';

export class LayerGroup extends Container {
  private _collapsed = false;
  private _layerIndex: number;
  private _layerStatus: LayerStatus = 'pending';
  private _completedCount = 0;
  private _totalCount = 0;
  private _layerDuration = 0;
  private headerText: Text;
  private nodeDisplays: NodeDisplay[] = [];

  constructor(layerIndex: number) {
    super();
    this._layerIndex = layerIndex;
    this.headerText = new Text('', 1, 0);
    this.addChild(this.headerText);
    this.updateHeader();
  }

  get layerIndex(): number { return this._layerIndex; }
  get collapsed(): boolean { return this._collapsed; }
  get layerStatus(): LayerStatus { return this._layerStatus; }
  get completedCount(): number { return this._completedCount; }
  get totalCount(): number { return this._totalCount; }

  /** Set the node displays for this layer. Handles add/remove from the Container. */
  setNodes(nodes: NodeDisplay[]): void {
    if (this.nodeDisplays.length === nodes.length && this.nodeDisplays.every((nd, i) => nd === nodes[i])) {
      return;
    }

    this.nodeDisplays = nodes;

    if (!this._collapsed) {
      (this as any).children = [this.headerText, ...nodes];
    }
  }

  /** Get current node displays. */
  getNodes(): NodeDisplay[] {
    return this.nodeDisplays;
  }

  /** Update layer statistics and header. */
  updateStats(
    completedCount: number,
    totalCount: number,
    layerDuration: number,
    layerStatus: LayerStatus,
  ): void {
    this._completedCount = completedCount;
    this._totalCount = totalCount;
    this._layerDuration = layerDuration;
    this._layerStatus = layerStatus;
    this.updateHeader();
  }

  /** Collapse to a single summary line (hides node displays). */
  collapse(): void {
    if (this._collapsed) return;
    this._collapsed = true;
    (this as any).children = [this.headerText];
    this.updateHeader();
  }

  /** Expand to show all node displays. */
  expand(): void {
    if (!this._collapsed) return;
    this._collapsed = false;
    (this as any).children = [this.headerText, ...this.nodeDisplays];
    this.updateHeader();
  }

  private updateHeader(): void {
    if (this._collapsed) {
      // ▸ Layer N — ✓ done/total complete · duration
      const arrow = chalk.hex(palette.dim)(icons.collapsed);
      const check = chalk.hex(palette.success)(icons.complete);
      const stats = chalk.hex(palette.dim)(`${this._completedCount}/${this._totalCount} complete`);
      const dur = this._layerDuration > 0
        ? chalk.hex(palette.dim)(` \u00b7 ${formatDuration(this._layerDuration)}`)
        : '';
      this.headerText.setText(
        `${spacing.indent2}${arrow} Layer ${this._layerIndex + 1} \u2014 ${check} ${stats}${dur}`,
      );
    } else if (this._layerStatus === 'active') {
      // ═══ Layer N (completed/total) ═══
      const header = `Layer ${this._layerIndex + 1} (${this._completedCount}/${this._totalCount})`;
      const line = `${box.doubleHorizontal.repeat(3)} ${header} ${box.doubleHorizontal.repeat(3)}`;
      this.headerText.setText(
        `${spacing.indent2}${chalk.hex(palette.info).bold(line)}`,
      );
    } else {
      // ─── Layer N ───
      const header = `Layer ${this._layerIndex + 1}`;
      const line = `${box.horizontal.repeat(3)} ${header} ${box.horizontal.repeat(3)}`;
      this.headerText.setText(
        `${spacing.indent2}${chalk.hex(palette.dim)(line)}`,
      );
    }
  }
}
