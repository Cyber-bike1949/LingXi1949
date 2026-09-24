import { relativeOperationPath, type FileOperationResponse } from '../../services/terminal/fileOperations';
/**
 * Directory tree panel (candidate doc "目录树与双向文件传输", phase 1 / local).
 *
 * Scope decisions carried over from the dev doc, worth restating here since
 * they show up directly in this file's shape:
 *  - The tree root is the terminal's current working directory, not some
 *    fixed "workspace root" (there isn't one for an arbitrary terminal
 *    session) or the filesystem root. An "up" affordance re-roots to the
 *    parent directory. Root children render already loaded/expanded;
 *    everything below that is collapsed and lazy-loaded on click.
 *  - Docking is a self-drawn resizable side panel (own CSS class +
 *    drag-resize handle), not Obsidian's native pane-split, and not a true
 *    "grab this button and drop it on an edge" gesture — dock side is a
 *    two-state toggle button instead. See dev doc §4 decision 3 for why.
  *  - The "copy a tree entry into the vault" direction has two entry
 *    points: right-click "复制到 Vault", and dragging a row out. The drag
 *    isn't a real OS-level file drag (a renderer-only Obsidian plugin has
 *    no reliable way to originate one that Obsidian's own file explorer,
 *    which expects its *own* internal drag payload, would accept) - rows
 *    are draggable with a plugin-private MIME type instead
 *    (`DIRECTORY_TREE_DRAG_MIME`, `directoryTreeDrop.ts`), which only a
 *    listener this plugin itself registers on Obsidian's file-explorer pane
 *    (in `main.ts`, once, plugin-wide) recognizes; every other drop target
 *    - Obsidian's own move-file handling, a real OS file drag - never sees
 *    this MIME type and behaves exactly as if the row weren't draggable at
 *    all.
 */

import type { Menu as ObsidianMenu } from 'obsidian';
import { Menu, Notice, setIcon } from 'obsidian';

import type { Disposable } from '../../services/remote/transport.ts';
import type { DirectoryEntry, DirectoryTreeSource } from '../../services/terminal/directoryTreeSource.ts';
import type { DirectoryModificationStore } from '../../services/terminal/directoryModificationStore.ts';
import { DIRECTORY_TREE_DRAG_MIME, type DirectoryTreeDragPayload } from '../../services/terminal/directoryTreeDrop.ts';
import { resolveDirectoryTreeDropTarget } from '../../services/terminal/directoryTreeDropTarget.ts';
import { calculateDirectoryTooltipPosition } from '../../services/terminal/directoryTreeTooltip.ts';
import { t } from '../../i18n';

export type DockSide = 'left' | 'right';

export interface DirectoryTreePanelCallbacks {
  confirmDelete?(path: string, type: string): Promise<boolean>;
  /** Double-click on a directory node: caller is expected to `cd` the terminal there. */
  onActivateDirectory(path: string): void;
  /**
   * Double-click on a file node (requirement 4, v1.8): caller inserts a
   * reference to this file's path into the agent-cli input, as a
   * lower-friction alternative to dragging the row there.
   */
  onActivateFile(path: string): void;
  /** A vault drag landed on a tree node; the path is the destination directory. */
  onDropToPath(dataTransfer: DataTransfer, targetPath: string): void;
  /** The dock-side toggle button was used; caller may persist the new side. */
  onDockSideChange?(side: DockSide): void;
  /** "复制到 Vault" was chosen from a node's context menu. */
  onCopyToVault(path: string, isDirectory: boolean, baseName: string): void;
  /** The panel was closed via its own header button. */
  onRequestClose(): void;
  /** Optional transfer modification state; omitted for legacy callers. */
  modificationStore?: DirectoryModificationStore;
  deviceKey?: string;
}

interface PathApi {
  join(...segments: string[]): string;
  dirname(target: string): string;
  basename(target: string): string;
}

const MIN_WIDTH_PX = 180;
const MAX_WIDTH_PX = 640;
const DEFAULT_WIDTH_PX = 260;
const MTIME_TOOLTIP_DELAY_MS = 500;

export class DirectoryTreePanel {
  readonly element: HTMLElement;

  private readonly headerEl: HTMLElement;
  private readonly pathInputEl: HTMLInputElement;
  private readonly treeRootEl: HTMLElement;
  private readonly resizerEl: HTMLElement;

  private rootPath: string | null = null;
  private writable = false;
  private capabilityCode = 'CHECKING';
  private operationPending = false;
  private dragSource: {path:string; token:string; root:string} | null = null;
  private rootGeneration = 0;
  private dockSide: DockSide;
  private width = DEFAULT_WIDTH_PX;

  /** One watch subscription per directory currently rendered as expanded. */
  private readonly watches = new Map<string, Disposable>();
  private readonly expandedPaths = new Set<string>();
  private destroyed = false;
  private modificationCleanup?: () => void;
  private mtimeHoverToken = 0;
  private mtimeHoverTimer: number | null = null;
  private mtimeTooltip: HTMLElement | null = null;

  private readonly source: DirectoryTreeSource;
  private readonly pathApi: PathApi;
  private readonly callbacks: DirectoryTreePanelCallbacks;
  /** The device this tree browses, or `null` for the local filesystem - stamped onto each row's drag payload. */
  private readonly remoteNodeId: string | null;
  private readonly modificationStore?: DirectoryModificationStore;
  private readonly deviceKey: string;

  constructor(
    source: DirectoryTreeSource,
    pathApi: PathApi,
    callbacks: DirectoryTreePanelCallbacks,
    initialDockSide: DockSide = 'right',
    remoteNodeId: string | null = null,
  ) {
    this.source = source;
    this.pathApi = pathApi;
    this.callbacks = callbacks;
    this.remoteNodeId = remoteNodeId;
    this.modificationStore = callbacks.modificationStore;
    this.deviceKey = callbacks.deviceKey ?? remoteNodeId ?? 'local';
    this.dockSide = initialDockSide;
    this.element = createDiv('directory-tree-panel');

    this.headerEl = this.element.createDiv('directory-tree-panel__header');
    this.buildHeaderControls();

    this.pathInputEl = this.element.createEl('input', {
      cls: 'directory-tree-panel__path',
      type: 'text',
      attr: { spellcheck: 'false', 'aria-label': t('directoryTree.pathInput') },
    });
    this.bindPathInput();

    this.treeRootEl = this.element.createDiv('directory-tree-panel__tree');
    this.modificationCleanup = this.modificationStore?.subscribe(() => {
      if (this.destroyed) return;
      this.treeRootEl.querySelectorAll<HTMLElement>('.directory-tree-panel__row').forEach((row) => {
        const path = row.dataset.path;
        if (!path) return;
        const marked = row.dataset.directory === 'true'
          ? this.modificationStore?.isFolderMarked(this.deviceKey, path, path.includes('\\') ? '\\' : '/')
          : this.modificationStore?.isMarked(this.deviceKey, path);
        row.toggleClass('is-modified', marked === true);
      });
    });

    this.resizerEl = this.element.createDiv('directory-tree-panel__resizer');
    this.bindResizer();

    this.bindPanelDropFallback();

    this.applyDockSide();
    this.applyWidth();
  }

  /**
   * Catch-all drop handler for anywhere in the panel that isn't a tree row
   * (the empty-state text, blank tree space, or header). Tree rows already
   * handle their own drops (see `renderNode`'s
   * `dragover`/`drop` wiring below) and always `stopPropagation`, so this
   * never double-handles those. Without this, a drop that misses every row
   * bubbles out of the panel to the terminal view's own container-level drop
   * handler, which is built for drops landing directly on the terminal/input
   * area and reacts by inserting an `@path` reference into the agent input -
   * a surprising side effect for what looks like "I dropped this on the
   * tree", not on the input box. Swallowing it here keeps the two drop
   * targets independent, matching the row-level convention of treating any
   * drop that doesn't carry our own drag MIME as a vault entry.
   */
  private bindPanelDropFallback(): void {
    this.element.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types.includes(DIRECTORY_TREE_DRAG_MIME)) return;
      event.preventDefault();
    });
    this.element.addEventListener('drop', (event) => {
      if (event.dataTransfer?.types.includes(DIRECTORY_TREE_DRAG_MIME)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer && this.rootPath) this.callbacks.onDropToPath(event.dataTransfer, this.rootPath);
    });
  }

  /** Enter navigates to the typed path; Escape or blur without Enter reverts the display. */
  private bindPathInput(): void {
    this.pathInputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const target = this.pathInputEl.value.trim();
        if (target && target !== this.rootPath) {
          void this.setRootPath(target);
        }
        this.pathInputEl.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.pathInputEl.value = this.rootPath ?? '';
        this.pathInputEl.blur();
      }
    });
    this.pathInputEl.addEventListener('blur', () => {
      this.pathInputEl.value = this.rootPath ?? '';
    });
    this.pathInputEl.addEventListener('focus', () => this.pathInputEl.select());
  }

  private buildHeaderControls(): void {
    const upBtn = this.headerEl.createEl('button', {
      cls: 'directory-tree-panel__icon-btn clickable-icon',
      attr: { 'aria-label': t('directoryTree.goUp') },
    });
    setIcon(upBtn, 'arrow-up');
    upBtn.addEventListener('click', () => {
      if (!this.rootPath) return;
      const parent = this.pathApi.dirname(this.rootPath);
      if (parent && parent !== this.rootPath) void this.setRootPath(parent);
    });

    const refreshBtn = this.headerEl.createEl('button', {
      cls: 'directory-tree-panel__icon-btn clickable-icon',
      attr: { 'aria-label': t('directoryTree.refresh') },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => {
      this.modificationStore?.clearAll();
      if (this.rootPath) void this.refreshWithBarrier(this.rootPath);
    });

    const dockBtn = this.headerEl.createEl('button', {
      cls: 'directory-tree-panel__icon-btn clickable-icon',
      attr: { 'aria-label': t('directoryTree.toggleDockSide') },
    });
    setIcon(dockBtn, 'flip-horizontal-2');
    dockBtn.addEventListener('click', () => {
      this.setDockSide(this.dockSide === 'left' ? 'right' : 'left');
    });

    const closeBtn = this.headerEl.createEl('button', {
      cls: 'directory-tree-panel__icon-btn clickable-icon',
      attr: { 'aria-label': t('directoryTree.close') },
    });
    setIcon(closeBtn, 'x');
    closeBtn.addEventListener('click', () => this.callbacks.onRequestClose());
  }

  private async refreshWithBarrier(path: string): Promise<void> {
    try {
      const snapshot = await this.source.snapshot?.(path);
      if (snapshot) this.modificationStore?.applyRefreshBarrier(this.deviceKey, snapshot.epoch, snapshot.sequence);
    } catch {
      new Notice('目录已刷新，但修改标记同步未完成');
    }
    await this.setRootPath(path, { keepExpanded: true });
  }

  private bindResizer(): void {
    let startX = 0;
    let startWidth = this.width;
    let dragging = false;

    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging) return;
      // Dragging the handle further from the terminal (left when docked
      // right, right when docked left) grows the panel.
      const delta = this.dockSide === 'right' ? startX - event.clientX : event.clientX - startX;
      this.setWidth(startWidth + delta);
    };

    const onPointerUp = (): void => {
      dragging = false;
      const doc = this.resizerEl.ownerDocument;
      doc.removeEventListener('pointermove', onPointerMove);
      doc.removeEventListener('pointerup', onPointerUp);
    };

    this.resizerEl.addEventListener('pointerdown', (event) => {
      dragging = true;
      startX = event.clientX;
      startWidth = this.width;
      const doc = this.resizerEl.ownerDocument;
      doc.addEventListener('pointermove', onPointerMove);
      doc.addEventListener('pointerup', onPointerUp);
      event.preventDefault();
    });
  }

  private setWidth(px: number): void {
    this.width = Math.min(MAX_WIDTH_PX, Math.max(MIN_WIDTH_PX, px));
    this.applyWidth();
  }

  private applyWidth(): void {
    this.element.style.setProperty('--directory-tree-panel-width', `${this.width}px`);
  }

  getDockSide(): DockSide {
    return this.dockSide;
  }

  setDockSide(side: DockSide): void {
    if (this.dockSide === side) return;
    this.dockSide = side;
    this.applyDockSide();
    this.callbacks.onDockSideChange?.(side);
  }

  private applyDockSide(): void {
    this.element.toggleClass('directory-tree-panel--left', this.dockSide === 'left');
    this.element.toggleClass('directory-tree-panel--right', this.dockSide === 'right');
  }

  async setRootPath(rootPath: string, options: { keepExpanded?: boolean } = {}): Promise<void> {
    this.clearMtimeTooltip();
    const generation = ++this.rootGeneration;
    this.writable = false;
    this.capabilityCode = 'CHECKING';
    this.dragSource = null;
    this.rootPath = rootPath;
    void this.source.operate?.({action:'capabilities',root:rootPath}).then(result => {
      if (generation !== this.rootGeneration || this.destroyed) return;
      this.writable = result.status === 'success';
      this.capabilityCode = result.code ?? (this.writable ? '' : 'UNKNOWN_RESULT');
    }).catch(() => {
      if (generation === this.rootGeneration && !this.destroyed) this.capabilityCode = 'CONNECTION_ERROR';
    });
    if (!this.source.operate) this.capabilityCode = 'UNSUPPORTED';
    this.pathInputEl.value = rootPath;
    this.pathInputEl.setAttribute('title', rootPath);

    if (!options.keepExpanded) {
      this.expandedPaths.clear();
    }
    this.disposeAllWatches();
    this.treeRootEl.empty();

    await this.renderChildrenInto(rootPath, this.treeRootEl, 0);
  }

  private async renderChildrenInto(dirPath: string, container: HTMLElement, depth: number): Promise<void> {
    if (this.destroyed) return;
    const generation = this.rootGeneration;
    let entries: DirectoryEntry[];
    try {
      entries = await this.source.list(dirPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      container.createDiv({ cls: 'directory-tree-panel__error', text: message });
      return;
    }
    if (this.destroyed || generation !== this.rootGeneration) return;

    container.empty();
    this.watchDirectory(dirPath, container, depth);

    if (entries.length === 0) {
      container.createDiv({ cls: 'directory-tree-panel__empty', text: t('directoryTree.empty') });
      return;
    }

    await Promise.all(entries.map(entry => this.renderNode(entry, dirPath, container, depth)));
  }

  private watchDirectory(dirPath: string, container: HTMLElement, depth: number): void {
    this.watches.get(dirPath)?.dispose();
    const disposable = this.source.watch(dirPath, () => {
      if (this.destroyed) return;
      void this.renderChildrenInto(dirPath, container, depth);
    });
    this.watches.set(dirPath, disposable);
  }

  private async renderNode(entry: DirectoryEntry, parentPath: string, container: HTMLElement, depth: number): Promise<void> {
    const fullPath = this.pathApi.join(parentPath, entry.name);

    const row = container.createDiv({ cls: 'directory-tree-panel__row' });
    row.style.setProperty('--directory-tree-depth', String(depth));
    row.dataset.path = fullPath;
    row.dataset.directory = String(entry.isDirectory);
    const marked = entry.isDirectory
      ? this.modificationStore?.isFolderMarked(this.deviceKey, fullPath, fullPath.includes('\\') ? '\\' : '/')
      : this.modificationStore?.isMarked(this.deviceKey, fullPath);
    row.toggleClass('is-modified', marked === true);

    const caret = row.createSpan({ cls: 'directory-tree-panel__caret' });
    if (entry.isDirectory) setIcon(caret, 'chevron-right');

    const icon = row.createSpan({ cls: 'directory-tree-panel__node-icon' });
    setIcon(icon, entry.isDirectory ? 'folder' : 'file');

    row.createSpan({ cls: 'directory-tree-panel__node-name', text: entry.name });

    let childrenEl: HTMLElement | null = null;
    let expanded = false;

    const toggle = async (): Promise<void> => {
      if (!entry.isDirectory) return;
      expanded = !expanded;
      row.toggleClass('is-expanded', expanded);
      if (expanded) {
        this.expandedPaths.add(fullPath);
        if (!childrenEl) {
          childrenEl = container.createDiv({ cls: 'directory-tree-panel__children' });
          row.insertAdjacentElement('afterend', childrenEl);
        }
        childrenEl.toggleClass('is-hidden', false);
        await this.renderChildrenInto(fullPath, childrenEl, depth + 1);
      } else {
        this.expandedPaths.delete(fullPath);
        childrenEl?.toggleClass('is-hidden', true);
        this.disposeWatchesUnder(fullPath);
      }
    };

    if (entry.isDirectory) {
      caret.addEventListener('click', (event) => {
        event.stopPropagation();
        void toggle();
      });
      row.addEventListener('dblclick', () => this.callbacks.onActivateDirectory(fullPath));
    } else {
      row.addEventListener('dblclick', () => this.callbacks.onActivateFile(fullPath));
    }

    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.showNodeContextMenu(event, fullPath, entry.isDirectory, entry.name);
    });

    row.tabIndex = 0;
    row.addEventListener('mouseenter', () => this.scheduleMtimeTooltip(row, fullPath));
    row.addEventListener('mouseleave', () => {
      if (!row.contains(row.ownerDocument.activeElement)) this.clearMtimeTooltip();
    });
    row.addEventListener('focusin', () => this.scheduleMtimeTooltip(row, fullPath));
    row.addEventListener('focusout', () => {
      if (!row.matches(':hover')) this.clearMtimeTooltip();
    });
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.clearMtimeTooltip();
      if ((event.key === 'Delete' || process.platform === 'darwin' && event.key === 'Backspace') && event.target === row) {
        event.preventDefault();event.stopPropagation();void this.deleteEntry(fullPath);
      }
    });

    // Draggable out to Obsidian's file explorer (see this file's top doc
    // comment) - not a real OS file drag, just a same-window HTML5 drag
    // carrying a plugin-private payload that only main.ts's explorer-drop
    // listener recognizes.
    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      if (!event.dataTransfer) return;
      const payload: DirectoryTreeDragPayload = {
        path: fullPath,
        isDirectory: entry.isDirectory,
        baseName: entry.name,
        nodeId: this.remoteNodeId,
      };
      event.dataTransfer.setData(DIRECTORY_TREE_DRAG_MIME, JSON.stringify(payload));
      if (this.rootPath && this.writable) {
        this.dragSource={path:fullPath,root:this.rootPath,token:crypto.randomUUID()};
        event.dataTransfer.setData('application/x-lingxi-tree-move',this.dragSource.token);
      }
      event.dataTransfer.effectAllowed = 'copyMove';
      if (!entry.isDirectory && this.modificationStore) {
        const version = this.modificationStore.version(this.deviceKey, fullPath);
        if (version !== null) this.modificationStore.acknowledge(this.deviceKey, fullPath, version);
      }
    });

    row.addEventListener('dragend', () => {this.dragSource=null;});

    row.addEventListener('click', () => {
      if (entry.isDirectory || !this.modificationStore) return;
      const version = this.modificationStore.version(this.deviceKey, fullPath);
      if (version !== null) this.modificationStore.acknowledge(this.deviceKey, fullPath, version);
    });

    row.addEventListener('dragover', (event) => {
      // A row we ourselves made draggable passing back over another row in
      // the same tree isn't a vault-drop. Let it remain a no-op instead of
      // flashing the row as a target.
      if (event.dataTransfer?.types.includes(DIRECTORY_TREE_DRAG_MIME)) {
        event.preventDefault();event.stopPropagation();
        if (this.dragSource && this.writable && !this.operationPending) {event.dataTransfer.dropEffect='move';row.addClass('is-drop-target');}
        else event.dataTransfer.dropEffect='none';
        return;
      }
      event.preventDefault();
      row.addClass('is-drop-target');
    });
    row.addEventListener('dragleave', () => row.removeClass('is-drop-target'));
    row.addEventListener('drop', (event) => {
      if (event.dataTransfer?.types.includes(DIRECTORY_TREE_DRAG_MIME)) {
        event.preventDefault();event.stopPropagation();row.removeClass('is-drop-target');
        const drag=this.dragSource;
        if (drag && event.dataTransfer.getData('application/x-lingxi-tree-move')===drag.token && drag.root===this.rootPath) {
          void this.moveEntry(drag.path,resolveDirectoryTreeDropTarget(parentPath,fullPath,entry.isDirectory));
        }
        if (!this.writable) new Notice(`${t('release21.upgradeRequired')} (${this.capabilityCode})`);
        this.dragSource=null;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      row.removeClass('is-drop-target');
      if (!event.dataTransfer) return;
      // A file cannot contain the dropped note. Treat its containing folder
      // as the target instead of letting the panel fallback use the tree root.
      const targetPath = resolveDirectoryTreeDropTarget(parentPath, fullPath, entry.isDirectory);
      this.callbacks.onDropToPath(event.dataTransfer, targetPath);
    });

    if (this.expandedPaths.has(fullPath) && entry.isDirectory) {
      await toggle();
    }
  }

  private showNodeContextMenu(event: MouseEvent, path: string, isDirectory: boolean, name: string): void {
    const menu: ObsidianMenu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle(t('directoryTree.copyToVault'))
        .setIcon('download')
        .onClick(() => this.callbacks.onCopyToVault(path, isDirectory, name));
    });
    menu.addItem(item => item.setTitle(t('common.delete')).setIcon('trash-2').setDisabled(!this.writable || this.operationPending).onClick(() => this.deleteEntry(path)));
    if (!this.writable) menu.addItem(item => item.setTitle(`${t('release21.upgradeRequired')} (${this.capabilityCode})`).setDisabled(true));
    menu.showAtMouseEvent(event);
  }

  private showOperationResult(result: FileOperationResponse): void {
    if (result.status === 'success') return;
    new Notice(result.status === 'partial' ? t('release21.partialDelete') : result.status === 'unknown' ? t('release21.unknownResult') : t('release21.operationFailed',{code:result.code ?? 'UNKNOWN'}));
  }

  private async deleteEntry(path: string): Promise<void> {
    const root=this.rootPath;
    if (!root || !this.source.operate || !this.writable || this.operationPending || !this.callbacks.confirmDelete) return;
    this.operationPending=true;
    const rows=Array.from(this.treeRootEl.querySelectorAll<HTMLElement>('.directory-tree-panel__row'));
    const index=rows.findIndex(row=>row.dataset.path===path);
    const parentPath=this.pathApi.dirname(path);
    const siblings=rows.filter(row=>row.dataset.path && this.pathApi.dirname(row.dataset.path)===parentPath);
    const siblingIndex=siblings.findIndex(row=>row.dataset.path===path);
    const nextPath=siblings[siblingIndex+1]?.dataset.path ?? siblings[siblingIndex-1]?.dataset.path ?? parentPath;
    try {
      const relative=relativeOperationPath(root,path);
      const inspected=await this.source.operate({action:'inspect',root,path:relative});
      if(inspected.status!=='success'||!inspected.identity){this.showOperationResult(inspected);return;}
      if(!await this.callbacks.confirmDelete(path,inspected.entryType ?? 'file')||root!==this.rootPath)return;
      const result=await this.source.operate({action:'delete',root,path:relative,expectedIdentity:inspected.identity,operationId:crypto.randomUUID()});
      this.showOperationResult(result);
      if(this.rootPath===root){await this.setRootPath(root,{keepExpanded:true});const current=Array.from(this.treeRootEl.querySelectorAll<HTMLElement>('.directory-tree-panel__row'));(current.find(row=>row.dataset.path===nextPath) ?? current[Math.max(0,index-1)])?.focus();}
    }catch{new Notice(t('release21.unknownResult'));}
    finally{this.operationPending=false;}
  }

  private async moveEntry(path:string,target:string):Promise<void>{
    const root=this.rootPath;
    if(!root||!this.writable||!this.source.operate||this.operationPending)return;
    this.operationPending=true;
    try{
      const relative=relativeOperationPath(root,path),destination=relativeOperationPath(root,target);
      const inspected=await this.source.operate({action:'inspect',root,path:relative});
      if(inspected.status!=='success'||!inspected.identity){this.showOperationResult(inspected);return;}
      if(relative===destination||destination.startsWith(relative+'/')){new Notice(t('release21.operationFailed',{code:'INVALID_TARGET'}));return;}
      const result=await this.source.operate({action:'move',root,path:relative,target:destination,expectedIdentity:inspected.identity,operationId:crypto.randomUUID()});
      this.showOperationResult(result);
      if (this.rootPath === root) {
        if (result.status === 'success') this.expandedPaths.add(target);
        await this.setRootPath(root, {keepExpanded:true});
        if (result.status === 'success' && this.rootPath === root) {
          // Keep the tree's path spelling (including ~) rather than the canonical backend path.
          const movedPath = this.pathApi.join(target, this.pathApi.basename(path));
          const row = Array.from(this.treeRootEl.querySelectorAll<HTMLElement>('.directory-tree-panel__row')).find(row => row.dataset.path === movedPath);
          row?.focus();
          row?.scrollIntoView({block:'nearest'});
        }
      }
    }catch{new Notice(t('release21.unknownResult'));}
    finally{this.operationPending=false;}
  }

  private scheduleMtimeTooltip(row: HTMLElement, path: string): void {
    this.clearMtimeTooltip();
    if (!this.source.stat) return;
    const token = ++this.mtimeHoverToken;
    const ownerWindow = row.ownerDocument.defaultView ?? window;
    this.mtimeHoverTimer = ownerWindow.setTimeout(() => {
      this.mtimeHoverTimer = null;
      const active = row.matches(':hover') || row.contains(row.ownerDocument.activeElement);
      if (this.destroyed || token !== this.mtimeHoverToken || !row.isConnected || !active) return;

      const tooltip = row.ownerDocument.body.createDiv({ cls: 'directory-tree-panel__mtime' });
      tooltip.setAttribute('role', 'tooltip');
      tooltip.createDiv({ cls: 'directory-tree-panel__mtime-label', text: t('directoryTree.recentlyModified') });
      const value = tooltip.createDiv({ cls: 'directory-tree-panel__mtime-value', text: t('directoryTree.readingModifiedTime') });
      this.mtimeTooltip = tooltip;
      this.positionMtimeTooltip(row, tooltip, ownerWindow);

      void this.source.stat?.(path).then((metadata) => {
        if (token !== this.mtimeHoverToken || this.mtimeTooltip !== tooltip) return;
        value.setText(metadata.modifiedAtMs === null ? t('directoryTree.modifiedTimeUnavailable') : new Date(metadata.modifiedAtMs).toLocaleString());
        this.positionMtimeTooltip(row, tooltip, ownerWindow);
      }).catch(() => {
        if (token !== this.mtimeHoverToken || this.mtimeTooltip !== tooltip) return;
        value.setText(t('directoryTree.modifiedTimeUnavailable'));
        this.positionMtimeTooltip(row, tooltip, ownerWindow);
      });
    }, MTIME_TOOLTIP_DELAY_MS);
  }

  private positionMtimeTooltip(row: HTMLElement, tooltip: HTMLElement, ownerWindow: Window): void {
    const anchor = row.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const position = calculateDirectoryTooltipPosition(anchor, tooltipRect, {
      width: ownerWindow.innerWidth,
      height: ownerWindow.innerHeight,
    });
    tooltip.style.left = `${position.left}px`;
    tooltip.style.top = `${position.top}px`;
    tooltip.dataset.side = position.side;
  }

  private clearMtimeTooltip(): void {
    this.mtimeHoverToken += 1;
    const ownerWindow = this.element.ownerDocument.defaultView ?? window;
    if (this.mtimeHoverTimer !== null) ownerWindow.clearTimeout(this.mtimeHoverTimer);
    this.mtimeHoverTimer = null;
    this.mtimeTooltip?.remove();
    this.mtimeTooltip = null;
  }

  private disposeWatchesUnder(path: string): void {
    for (const [watchedPath, disposable] of Array.from(this.watches.entries())) {
      if (watchedPath === path || watchedPath.startsWith(`${path}${watchedPath.includes('\\') ? '\\' : '/'}`)) {
        disposable.dispose();
        this.watches.delete(watchedPath);
      }
    }
  }

  private disposeAllWatches(): void {
    for (const disposable of this.watches.values()) disposable.dispose();
    this.watches.clear();
  }

  destroy(): void {
    this.destroyed = true;
    this.clearMtimeTooltip();
    this.modificationCleanup?.();
    this.modificationCleanup = undefined;
    this.disposeAllWatches();
    this.element.remove();
  }
}
