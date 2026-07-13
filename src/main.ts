import {
  AbstractInputSuggest,
  App,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";
import {
  EffectiveLanguage,
  LANGUAGE_OPTIONS,
  LanguageSetting,
  TRANSLATIONS,
  TranslationKey,
} from "./i18n";

type WindowMoment = (() => { format(format: string): string }) & {
  locale?: () => string;
};

type WindowWithMoment = Window & {
  moment?: WindowMoment;
};

const CONFLICT_BEHAVIORS = {
  TIMESTAMP: "timestamp",
  SEQUENCE: "sequence",
  SKIP: "skip",
  STOP: "stop",
} as const;

type ConflictBehavior = (typeof CONFLICT_BEHAVIORS)[keyof typeof CONFLICT_BEHAVIORS];

const ARCHIVE_LOCATIONS = {
  CURRENT_FOLDER_SUBFOLDER: "current-folder-subfolder",
  SPECIFIED_FOLDER: "specified-folder",
} as const;

type ArchiveLocation = (typeof ARCHIVE_LOCATIONS)[keyof typeof ARCHIVE_LOCATIONS];

interface ArchiveRule {
  enabled: boolean;
  sourceFolderPath: string;
  destinationFolderPath: string;
  allowRestore: boolean;
}

interface MirrorArchiveSettings {
  archiveLocation: ArchiveLocation;
  archiveSubfolderName: string;
  archiveFolderPath: string;
  rules: ArchiveRule[];
  conflictBehavior: ConflictBehavior;
  language: LanguageSetting;
  showRibbonIcon: boolean;
  showFileMenuItem: boolean;
}

type RawMirrorArchiveSettings = Partial<Omit<MirrorArchiveSettings, "rules">> & {
  rules?: unknown;
  archiveRoot?: string;
  allowFolderArchive?: boolean;
  useFileExplorerSelectionForHotkey?: boolean;
  showSelectedCountInMenu?: boolean;
};

type ArchiveTarget = TFile | TFolder;
type TargetAction = "archive" | "restore";
type TargetActionResolution = TargetAction | "mixed";

interface ArchiveResult {
  skipped: boolean;
}

interface FileExplorerItemLike {
  file?: TAbstractFile | null;
  selected?: boolean;
  isSelected?: boolean;
  selfEl?: HTMLElement;
  titleEl?: HTMLElement;
  el?: HTMLElement;
  containerEl?: HTMLElement;
}

interface FileExplorerViewLike {
  fileItems?: Record<string, FileExplorerItemLike>;
  containerEl?: HTMLElement;
  contentEl?: HTMLElement;
  leaf?: unknown;
}

interface SelectedTargetOptions {
  focusedOnly?: boolean;
}

type TemplateValues = Record<string, number | string>;
type FolderChooseHandler = (folderPath: string) => Promise<void> | void;

const DEFAULT_SETTINGS: MirrorArchiveSettings = {
  archiveLocation: ARCHIVE_LOCATIONS.SPECIFIED_FOLDER,
  archiveSubfolderName: "",
  archiveFolderPath: "",
  rules: [],
  conflictBehavior: CONFLICT_BEHAVIORS.SEQUENCE,
  language: LANGUAGE_OPTIONS.SYSTEM,
  showRibbonIcon: true,
  showFileMenuItem: true,
};

function isConflictBehavior(value: unknown): value is ConflictBehavior {
  return Object.values(CONFLICT_BEHAVIORS).includes(value as ConflictBehavior);
}

function isArchiveLocation(value: unknown): value is ArchiveLocation {
  return Object.values(ARCHIVE_LOCATIONS).includes(value as ArchiveLocation);
}

export default class MirrorArchivePlugin extends Plugin {
  settings: MirrorArchiveSettings = { ...DEFAULT_SETTINGS };
  private ribbonIconEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerCommands();
    this.updateRibbonIcon();
    this.addSettingTab(new MirrorArchiveSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, target) => {
        this.addActionMenuItem(menu, this.getContextTargets(target));
      })
    );

    this.registerEvent(
      this.app.workspace.on("files-menu", (menu, targets) => {
        this.addActionMenuItem(menu, targets);
      })
    );
  }

  async loadSettings(): Promise<void> {
    const loadedData = ((await this.loadData()) ?? {}) as RawMirrorArchiveSettings;
    const archiveFolderPath = loadedData.archiveFolderPath ?? loadedData.archiveRoot ?? DEFAULT_SETTINGS.archiveFolderPath;

    this.settings = {
      archiveLocation: isArchiveLocation(loadedData.archiveLocation)
        ? loadedData.archiveLocation
        : DEFAULT_SETTINGS.archiveLocation,
      archiveSubfolderName: this.normalizeArchiveSubfolderName(
        loadedData.archiveSubfolderName ?? DEFAULT_SETTINGS.archiveSubfolderName
      ),
      archiveFolderPath: this.normalizeArchiveFolderPath(archiveFolderPath),
      rules: this.normalizeArchiveRules(loadedData.rules),
      conflictBehavior: isConflictBehavior(loadedData.conflictBehavior)
        ? loadedData.conflictBehavior
        : DEFAULT_SETTINGS.conflictBehavior,
      language: this.isSupportedLanguageSetting(loadedData.language) ? loadedData.language : DEFAULT_SETTINGS.language,
      showRibbonIcon: loadedData.showRibbonIcon ?? DEFAULT_SETTINGS.showRibbonIcon,
      showFileMenuItem: loadedData.showFileMenuItem ?? DEFAULT_SETTINGS.showFileMenuItem,
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  registerCommands(): void {
    this.addCommand({
      id: "active-file",
      name: this.t("command.mirrorArchive"),
      callback: () => this.runActiveAction(),
    });
  }

  updateRibbonIcon(): void {
    this.ribbonIconEl?.remove();
    this.ribbonIconEl = null;

    if (this.settings.showRibbonIcon) {
      this.ribbonIconEl = this.addRibbonIcon("archive", this.t("command.mirrorArchive"), () => this.runActiveAction());
    }
  }

  async runActiveAction(): Promise<void> {
    if (!this.hasArchiveDestination()) {
      this.showMissingArchiveDestinationNotice();
      return;
    }

    const selectedTargets = this.getSelectedTargets({ focusedOnly: true });
    if (selectedTargets.length > 0) {
      await this.handleTargets(selectedTargets);
      return;
    }

    const file = this.app.workspace.getActiveFile();

    if (!file) {
      new Notice(this.t("notice.noActiveFile"));
      return;
    }

    await this.handleTargets([file]);
  }

  async handleTargets(targets: unknown[]): Promise<void> {
    if (!this.hasArchiveDestination()) {
      this.showMissingArchiveDestinationNotice();
      return;
    }

    const invalidRuleIndex = this.getInvalidRuleIndexForTargets(targets);
    if (invalidRuleIndex !== null) {
      new Notice(this.t("notice.invalidRule", { index: invalidRuleIndex + 1 }));
      return;
    }

    const normalizedTargets = this.normalizeTargets(targets);

    if (normalizedTargets.length === 0) {
      new Notice(this.t("notice.noTargets"));
      return;
    }

    const action = this.getTargetsAction(normalizedTargets);

    if (action === "mixed") {
      new Notice(this.t("notice.mixedTargets"));
      return;
    }

    if (!action) {
      new Notice(this.t("notice.noTargets"));
      return;
    }

    if (action === "restore") {
      await this.restoreTargets(normalizedTargets);
      return;
    }

    await this.archiveTargets(normalizedTargets);
  }

  async archiveTargets(targets: unknown[]): Promise<void> {
    if (!this.hasArchiveDestination()) {
      this.showMissingArchiveDestinationNotice();
      return;
    }

    const normalizedTargets = this.normalizeTargets(targets);

    if (normalizedTargets.length === 0) {
      new Notice(this.t("notice.noTargets"));
      return;
    }

    let successCount = 0;
    let skippedCount = 0;
    let conflictCount = 0;
    const failures: Array<{ target: ArchiveTarget; error: unknown }> = [];
    let stoppedOnConflict = false;

    for (const target of normalizedTargets) {
      try {
        const result = await this.archiveTarget(target);

        if (result.skipped) {
          skippedCount += 1;
        } else {
          successCount += 1;
        }
      } catch (error) {
        if (error instanceof ArchiveConflictError) {
          conflictCount += 1;
          stoppedOnConflict = true;
          break;
        }

        console.error(error);
        failures.push({ target, error });
      }
    }

    if (stoppedOnConflict || failures.length > 0 || skippedCount > 0) {
      new Notice(this.getBatchSummary("archive", successCount, skippedCount, conflictCount, failures.length, stoppedOnConflict));
    } else if (successCount === 1) {
      new Notice(this.t("notice.archivedOne"));
    } else {
      new Notice(this.t("notice.archivedMany", { count: successCount }));
    }
  }

  async archiveTarget(target: ArchiveTarget): Promise<ArchiveResult> {
    if (!this.canArchive(target)) {
      const targetPath = (target as TAbstractFile | null | undefined)?.path ?? "unknown item";
      throw new Error(this.t("error.cannotArchive", { path: targetPath }));
    }

    const targetPath = await this.getAvailablePath(this.getArchiveTargetPath(target), target instanceof TFolder);

    if (!targetPath) {
      return { skipped: true };
    }

    const targetFolder = this.getFolderPath(targetPath);

    await this.ensureFolder(targetFolder);
    await this.app.fileManager.renameFile(target, targetPath);

    return { skipped: false };
  }

  async restoreTargets(targets: unknown[]): Promise<void> {
    if (!this.hasArchiveDestination()) {
      this.showMissingArchiveDestinationNotice();
      return;
    }

    const normalizedTargets = this.normalizeTargets(targets);

    if (normalizedTargets.length === 0) {
      new Notice(this.t("notice.noTargets"));
      return;
    }

    let successCount = 0;
    let skippedCount = 0;
    let conflictCount = 0;
    const failures: Array<{ target: ArchiveTarget; error: unknown }> = [];
    let stoppedOnConflict = false;

    for (const target of normalizedTargets) {
      try {
        const result = await this.restoreTarget(target);

        if (result.skipped) {
          skippedCount += 1;
        } else {
          successCount += 1;
        }
      } catch (error) {
        if (error instanceof ArchiveConflictError) {
          conflictCount += 1;
          stoppedOnConflict = true;
          break;
        }

        console.error(error);
        failures.push({ target, error });
      }
    }

    if (stoppedOnConflict || failures.length > 0 || skippedCount > 0) {
      new Notice(this.getBatchSummary("restore", successCount, skippedCount, conflictCount, failures.length, stoppedOnConflict));
    } else if (successCount === 1) {
      new Notice(this.t("notice.restoredOne"));
    } else {
      new Notice(this.t("notice.restoredMany", { count: successCount }));
    }
  }

  async restoreTarget(target: ArchiveTarget): Promise<ArchiveResult> {
    const restorePath = this.getRestoreTargetPath(target);

    if (!restorePath) {
      const targetPath = (target as TAbstractFile | null | undefined)?.path ?? "unknown item";
      throw new Error(this.t("error.cannotRestore", { path: targetPath }));
    }

    const targetPath = await this.getAvailablePath(restorePath, target instanceof TFolder);

    if (!targetPath) {
      return { skipped: true };
    }

    const targetFolder = this.getFolderPath(targetPath);

    await this.ensureFolder(targetFolder);
    await this.app.fileManager.renameFile(target, targetPath);

    return { skipped: false };
  }

  getBatchSummary(
    action: TargetAction,
    successCount: number,
    skippedCount: number,
    conflictCount: number,
    failureCount: number,
    stoppedOnConflict: boolean
  ): string {
    const parts: string[] = [];
    const successKey = action === "restore" ? "summary.restored" : "summary.archived";
    const finishedKey = action === "restore" ? "summary.restoreFinished" : "summary.finished";
    const stoppedKey = action === "restore" ? "summary.restoreStopped" : "summary.stopped";

    if (successCount > 0) {
      parts.push(this.t(successKey, { count: successCount }));
    }

    if (skippedCount > 0) {
      parts.push(this.t("summary.skipped", { count: skippedCount }));
    }

    if (conflictCount > 0) {
      parts.push(this.t("summary.conflicts", { count: conflictCount, plural: conflictCount === 1 ? "" : "s" }));
    }

    if (failureCount > 0) {
      parts.push(this.t("summary.failed", { count: failureCount }));
    }

    return this.t("summary.template", {
      prefix: stoppedOnConflict ? this.t(stoppedKey) : this.t(finishedKey),
      parts: parts.join(this.t("summary.separator")),
    });
  }

  getContextTargets(target: unknown): ArchiveTarget[] {
    if (!this.canHandle(target)) {
      return [];
    }

    const selectedTargets = this.getSelectedTargets();
    const selectedContainsTarget = selectedTargets.some((selectedTarget) => selectedTarget.path === target.path);

    if (selectedContainsTarget && selectedTargets.length > 1) {
      return this.normalizeTargets(selectedTargets);
    }

    return this.normalizeTargets([target]);
  }

  addActionMenuItem(menu: Menu, targets: unknown[]): void {
    if (!this.settings.showFileMenuItem) {
      return;
    }

    const normalizedTargets = this.normalizeTargets(targets);

    if (normalizedTargets.length === 0) {
      return;
    }

    const action = this.getTargetsAction(normalizedTargets);
    const label = this.getMenuLabel(action, normalizedTargets.length);

    menu.addItem((item) => {
      item
        .setTitle(label)
        .setIcon("archive")
        .onClick(() => {
          void this.handleTargets(normalizedTargets);
        });
    });
  }

  getMenuLabel(action: TargetActionResolution | null, count: number): string {
    if (action === "restore") {
      return count > 1 ? this.t("menu.restoreSelected", { count }) : this.t("command.restoreArchive");
    }

    return count > 1 ? this.t("menu.archiveSelected", { count }) : this.t("command.mirrorArchive");
  }

  getSelectedTargets(options: SelectedTargetOptions = {}): ArchiveTarget[] {
    const { focusedOnly = false } = options;
    const targetsByPath = new Map<string, ArchiveTarget>();

    for (const view of this.getFileExplorerViews()) {
      if (focusedOnly && !this.isFocusedView(view)) {
        continue;
      }

      for (const target of this.getSelectedTargetsFromFileItems(view)) {
        targetsByPath.set(target.path, target);
      }

      for (const target of this.getSelectedTargetsFromDom(view)) {
        targetsByPath.set(target.path, target);
      }
    }

    return this.normalizeTargets(Array.from(targetsByPath.values()));
  }

  getFileExplorerViews(): FileExplorerViewLike[] {
    return this.app.workspace
      .getLeavesOfType("file-explorer")
      .map((leaf) => leaf.view as FileExplorerViewLike)
      .filter((view): view is FileExplorerViewLike => Boolean(view));
  }

  getSelectedTargetsFromFileItems(view: FileExplorerViewLike): ArchiveTarget[] {
    const fileItems = view.fileItems ?? {};
    const selectedTargets: ArchiveTarget[] = [];

    for (const item of Object.values(fileItems)) {
      if (this.isSelectedFileExplorerItem(item) && this.canHandle(item.file)) {
        selectedTargets.push(item.file);
      }
    }

    return selectedTargets;
  }

  getSelectedTargetsFromDom(view: FileExplorerViewLike): ArchiveTarget[] {
    const root = view.containerEl ?? view.contentEl;
    if (!root) return [];

    const selectedEls = root.querySelectorAll(
      ".nav-file.is-selected, .nav-folder.is-selected, .tree-item-self.is-selected, .nav-file-title.is-selected, .nav-folder-title.is-selected"
    );
    const selectedTargets: ArchiveTarget[] = [];

    for (const el of Array.from(selectedEls)) {
      const path = this.getPathFromElement(el);
      if (!path) continue;

      const target = this.app.vault.getAbstractFileByPath(path);
      if (this.canHandle(target)) {
        selectedTargets.push(target);
      }
    }

    return selectedTargets;
  }

  isSelectedFileExplorerItem(item: FileExplorerItemLike | null | undefined): boolean {
    if (!item) return false;

    if (item.selected === true || item.isSelected === true) {
      return true;
    }

    const elements = [item.selfEl, item.titleEl, item.el, item.containerEl].filter(
      (el): el is HTMLElement => Boolean(el)
    );
    return elements.some((el) => this.hasClass(el, "is-selected"));
  }

  getPathFromElement(el: Element): string | null {
    return el.getAttribute("data-path") ?? el.closest("[data-path]")?.getAttribute("data-path") ?? null;
  }

  hasClass(el: HTMLElement, className: string): boolean {
    const obsidianEl = el as HTMLElement & { hasClass?: (className: string) => boolean };
    return obsidianEl.hasClass?.(className) ?? el.classList.contains(className);
  }

  isFocusedView(view: FileExplorerViewLike): boolean {
    const root = view.containerEl ?? view.contentEl;
    const activeElement = root?.ownerDocument.activeElement;

    if (root && activeElement && root.contains(activeElement)) {
      return true;
    }

    return Boolean(root?.closest(".workspace-leaf.mod-active"));
  }

  normalizeTargets(targets: unknown[]): ArchiveTarget[] {
    const targetsByPath = new Map<string, ArchiveTarget>();

    for (const target of targets) {
      if (this.canHandle(target)) {
        targetsByPath.set(target.path, target);
      }
    }

    const sortedTargets = Array.from(targetsByPath.values()).sort((a, b) => a.path.length - b.path.length);
    const topLevelTargets: ArchiveTarget[] = [];

    for (const target of sortedTargets) {
      const hasSelectedAncestor = topLevelTargets.some((parent) => this.isAncestorPath(parent.path, target.path));
      if (!hasSelectedAncestor) {
        topLevelTargets.push(target);
      }
    }

    return topLevelTargets;
  }

  getTargetsAction(targets: ArchiveTarget[]): TargetActionResolution | null {
    let hasArchiveTargets = false;
    let hasRestoreTargets = false;

    for (const target of targets) {
      if (this.canRestore(target)) {
        hasRestoreTargets = true;
      } else if (this.canArchive(target)) {
        hasArchiveTargets = true;
      }

      if (hasArchiveTargets && hasRestoreTargets) {
        return "mixed";
      }
    }

    if (hasRestoreTargets) {
      return "restore";
    }

    if (hasArchiveTargets) {
      return "archive";
    }

    return null;
  }

  canHandle(target: unknown): target is ArchiveTarget {
    return this.canArchive(target) || this.canRestore(target);
  }

  canArchive(target: unknown): target is ArchiveTarget {
    const isArchiveableType = target instanceof TFile || target instanceof TFolder;
    return isArchiveableType && Boolean(target.path) && !this.isGloballyArchived(target) && !this.canRestore(target);
  }

  canRestore(target: unknown): target is ArchiveTarget {
    return (target instanceof TFile || target instanceof TFolder) && Boolean(target.path) && Boolean(this.getRestoreTargetPath(target));
  }

  isAncestorPath(parentPath: string, childPath: string): boolean {
    return childPath.startsWith(`${parentPath}/`);
  }

  isSameOrDescendantPath(path: string, folderPath: string): boolean {
    return Boolean(folderPath) && (path === folderPath || path.startsWith(`${folderPath}/`));
  }

  isArchiveRuleValid(rule: ArchiveRule): boolean {
    const sourceFolderPath = this.normalizeArchiveFolderPath(rule.sourceFolderPath);
    const destinationFolderPath = this.normalizeArchiveFolderPath(rule.destinationFolderPath);

    if (!sourceFolderPath || !destinationFolderPath || sourceFolderPath === destinationFolderPath) {
      return false;
    }

    return (
      !this.isAncestorPath(sourceFolderPath, destinationFolderPath) &&
      !this.isAncestorPath(destinationFolderPath, sourceFolderPath)
    );
  }

  getInvalidRuleIndexForTargets(targets: unknown[]): number | null {
    const targetPaths = targets
      .filter((target): target is ArchiveTarget => target instanceof TFile || target instanceof TFolder)
      .map((target) => target.path);

    const invalidRuleIndex = this.settings.rules.findIndex((rule) => {
      if (!rule.enabled || this.isArchiveRuleValid(rule)) {
        return false;
      }

      const sourceFolderPath = this.normalizeArchiveFolderPath(rule.sourceFolderPath);
      const destinationFolderPath = this.normalizeArchiveFolderPath(rule.destinationFolderPath);

      return targetPaths.some(
        (path) =>
          this.isSameOrDescendantPath(path, sourceFolderPath) ||
          this.isSameOrDescendantPath(path, destinationFolderPath)
      );
    });

    return invalidRuleIndex === -1 ? null : invalidRuleIndex;
  }

  isGloballyArchived(target: ArchiveTarget): boolean {
    if (this.settings.archiveLocation === ARCHIVE_LOCATIONS.CURRENT_FOLDER_SUBFOLDER) {
      const archiveSubfolderName = this.getArchiveSubfolderName();
      if (!archiveSubfolderName) return false;

      const pathParts = target.path.split("/");
      const parentParts = pathParts.slice(0, -1);
      const targetName = pathParts[pathParts.length - 1];

      return (target instanceof TFolder && targetName === archiveSubfolderName) || parentParts.includes(archiveSubfolderName);
    }

    const archiveFolderPath = this.getArchiveFolderPath();
    return target.path === archiveFolderPath || target.path.startsWith(`${archiveFolderPath}/`);
  }

  async ensureFolder(folderPath: string): Promise<void> {
    if (!folderPath) return;

    const parts = folderPath.split("/");
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);

      if (!existing) {
        await this.app.vault.createFolder(current);
        continue;
      }

      if (!(existing instanceof TFolder)) {
        throw new Error(this.t("error.archivePathConflict", { path: current }));
      }
    }
  }

  async getAvailablePath(path: string, isFolder = false): Promise<string | null> {
    if (!this.app.vault.getAbstractFileByPath(path)) {
      return path;
    }

    if (this.settings.conflictBehavior === CONFLICT_BEHAVIORS.SKIP) {
      return null;
    }

    if (this.settings.conflictBehavior === CONFLICT_BEHAVIORS.STOP) {
      throw new ArchiveConflictError(path);
    }

    if (this.settings.conflictBehavior === CONFLICT_BEHAVIORS.SEQUENCE) {
      return this.getAvailableSequencePath(path, isFolder);
    }

    const stamp = this.getTimestamp();
    const stampedPath = this.addSuffix(path, stamp, isFolder);

    if (!this.app.vault.getAbstractFileByPath(stampedPath)) {
      return stampedPath;
    }

    let index = 2;
    while (this.app.vault.getAbstractFileByPath(this.addSuffix(path, `${stamp}-${index}`, isFolder))) {
      index += 1;
    }

    return this.addSuffix(path, `${stamp}-${index}`, isFolder);
  }

  getAvailableSequencePath(path: string, isFolder = false): string {
    let index = 1;
    while (this.app.vault.getAbstractFileByPath(this.addSequenceSuffix(path, index, isFolder))) {
      index += 1;
    }

    return this.addSequenceSuffix(path, index, isFolder);
  }

  getFolderPath(path: string): string {
    const slashIndex = path.lastIndexOf("/");
    return slashIndex === -1 ? "" : path.slice(0, slashIndex);
  }

  addSuffix(path: string, suffix: string, isFolder: boolean): string {
    if (isFolder) {
      return `${path}-${suffix}`;
    }

    const slashIndex = path.lastIndexOf("/");
    const dotIndex = path.lastIndexOf(".");

    if (dotIndex > slashIndex) {
      return `${path.slice(0, dotIndex)}-${suffix}${path.slice(dotIndex)}`;
    }

    return `${path}-${suffix}`;
  }

  addSequenceSuffix(path: string, index: number, isFolder: boolean): string {
    const suffix = ` ${index}`;

    if (isFolder) {
      return `${path}${suffix}`;
    }

    const slashIndex = path.lastIndexOf("/");
    const dotIndex = path.lastIndexOf(".");

    if (dotIndex > slashIndex) {
      return `${path.slice(0, dotIndex)}${suffix}${path.slice(dotIndex)}`;
    }

    return `${path}${suffix}`;
  }

  getTimestamp(): string {
    const activeMoment = (activeWindow as WindowWithMoment).moment;

    if (activeMoment) {
      return activeMoment().format("YYYYMMDD-HHmmss");
    }

    return new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  }

  getArchiveTargetPath(target: ArchiveTarget): string {
    const destinationRule = this.getMatchingDestinationRule(target.path);
    if (destinationRule) {
      return this.getGlobalArchiveTargetPath(target);
    }

    const sourceRule = this.getMatchingSourceRule(target.path);
    if (sourceRule) {
      return this.mapRulePath(
        target.path,
        sourceRule.sourceFolderPath,
        sourceRule.destinationFolderPath
      );
    }

    return this.getGlobalArchiveTargetPath(target);
  }

  getGlobalArchiveTargetPath(target: ArchiveTarget): string {
    if (this.settings.archiveLocation === ARCHIVE_LOCATIONS.CURRENT_FOLDER_SUBFOLDER) {
      return this.getCurrentFolderSubfolderArchivePath(target);
    }

    return normalizePath(`${this.getArchiveFolderPath()}/${target.path}`);
  }

  getCurrentFolderSubfolderArchivePath(target: ArchiveTarget): string {
    const candidates = this.getCurrentFolderSubfolderArchiveCandidates(target);
    const existingMirrorCandidate = candidates.find((candidate) => this.isExistingFolderPath(candidate.parentPath));

    return existingMirrorCandidate?.targetPath ?? candidates[0]?.targetPath ?? target.path;
  }

  getCurrentFolderSubfolderArchiveCandidates(target: ArchiveTarget): Array<{ targetPath: string; parentPath: string }> {
    const archiveSubfolderName = this.getArchiveSubfolderName();
    const pathParts = target.path.split("/").filter(Boolean);
    const candidates: Array<{ targetPath: string; parentPath: string }> = [];

    // Nearest to farthest: A/B/_archive/C, A/_archive/B/C, _archive/A/B/C.
    for (let baseLength = pathParts.length - 1; baseLength >= 0; baseLength -= 1) {
      const baseParts = pathParts.slice(0, baseLength);
      const relativeParts = pathParts.slice(baseLength);
      const candidateParts = [...baseParts, archiveSubfolderName, ...relativeParts];
      const parentParts = candidateParts.slice(0, -1);

      candidates.push({
        targetPath: normalizePath(candidateParts.join("/")),
        parentPath: normalizePath(parentParts.join("/")),
      });
    }

    return candidates;
  }

  getRestoreTargetPath(target: ArchiveTarget): string | null {
    const globalRestorePath = this.getGlobalRestoreTargetPath(target);
    if (globalRestorePath) {
      return globalRestorePath;
    }

    const destinationRule = this.getMatchingDestinationRule(target.path);
    if (destinationRule) {
      if (!destinationRule.allowRestore) {
        return null;
      }

      return this.mapRulePath(
        target.path,
        destinationRule.destinationFolderPath,
        destinationRule.sourceFolderPath
      );
    }

    return null;
  }

  getGlobalRestoreTargetPath(target: ArchiveTarget): string | null {
    if (this.settings.archiveLocation === ARCHIVE_LOCATIONS.CURRENT_FOLDER_SUBFOLDER) {
      return this.getCurrentFolderSubfolderRestorePath(target);
    }

    const archiveFolderPath = this.getArchiveFolderPath();

    if (!archiveFolderPath || !target.path.startsWith(`${archiveFolderPath}/`)) {
      return null;
    }

    const restorePath = target.path.slice(archiveFolderPath.length + 1);
    return restorePath ? normalizePath(restorePath) : null;
  }

  getActiveArchiveRules(): ArchiveRule[] {
    return this.settings.rules.filter((rule) => rule.enabled && this.isArchiveRuleValid(rule));
  }

  getMatchingSourceRule(path: string): ArchiveRule | null {
    return (
      this.getActiveArchiveRules().find((rule) =>
        this.isSameOrDescendantPath(path, this.normalizeArchiveFolderPath(rule.sourceFolderPath))
      ) ?? null
    );
  }

  getMatchingDestinationRule(path: string): ArchiveRule | null {
    return (
      this.getActiveArchiveRules().find((rule) =>
        this.isSameOrDescendantPath(path, this.normalizeArchiveFolderPath(rule.destinationFolderPath))
      ) ?? null
    );
  }

  mapRulePath(path: string, sourceFolderPath: string, destinationFolderPath: string): string {
    const normalizedSource = this.normalizeArchiveFolderPath(sourceFolderPath);
    const normalizedDestination = this.normalizeArchiveFolderPath(destinationFolderPath);

    if (path === normalizedSource) {
      return normalizedDestination;
    }

    const relativePath = path.slice(normalizedSource.length + 1);
    return normalizePath(`${normalizedDestination}/${relativePath}`);
  }

  getCurrentFolderSubfolderRestorePath(target: ArchiveTarget): string | null {
    const archiveSubfolderName = this.getArchiveSubfolderName();

    if (!archiveSubfolderName) {
      return null;
    }

    const pathParts = target.path.split("/");
    const parentParts = pathParts.slice(0, -1);
    const archiveFolderIndexes = parentParts
      .map((part, index) => (part === archiveSubfolderName ? index : -1))
      .filter((index) => index !== -1);

    if (archiveFolderIndexes.length !== 1) {
      return null;
    }

    const archiveFolderIndex = archiveFolderIndexes[0];
    const restoreParts = [
      ...parentParts.slice(0, archiveFolderIndex),
      ...parentParts.slice(archiveFolderIndex + 1),
      target.name,
    ];
    const restorePath = restoreParts.join("/");

    return restorePath ? normalizePath(restorePath) : null;
  }

  isExistingFolderPath(path: string): boolean {
    return this.app.vault.getAbstractFileByPath(path) instanceof TFolder;
  }

  getArchiveFolderPath(): string {
    return this.normalizeArchiveFolderPath(this.settings.archiveFolderPath);
  }

  getArchiveSubfolderName(): string {
    return this.normalizeArchiveSubfolderName(this.settings.archiveSubfolderName);
  }

  hasArchiveDestination(): boolean {
    if (this.settings.archiveLocation === ARCHIVE_LOCATIONS.CURRENT_FOLDER_SUBFOLDER) {
      return this.getArchiveSubfolderName().length > 0;
    }

    return this.getArchiveFolderPath().length > 0;
  }

  showMissingArchiveDestinationNotice(): void {
    new Notice(this.t("notice.missingArchiveRoot"));
  }

  normalizeArchiveFolderPath(value: unknown): string {
    const rawValue = String(value ?? "").trim();

    if (!rawValue) {
      return "";
    }

    const normalized = normalizePath(rawValue);

    if (!normalized || normalized === "/" || normalized === ".") {
      return "";
    }

    return normalized.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  normalizeArchiveRules(value: unknown): ArchiveRule[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const rules: ArchiveRule[] = [];

    for (const rawRule of value) {
      if (!rawRule || typeof rawRule !== "object") {
        continue;
      }

      const rule = rawRule as Partial<ArchiveRule>;
      rules.push({
        enabled: rule.enabled === true,
        sourceFolderPath: this.normalizeArchiveFolderPath(rule.sourceFolderPath),
        destinationFolderPath: this.normalizeArchiveFolderPath(rule.destinationFolderPath),
        allowRestore: rule.allowRestore !== false,
      });
    }

    return rules;
  }

  createArchiveRule(): ArchiveRule {
    return {
      enabled: false,
      sourceFolderPath: "",
      destinationFolderPath: "",
      allowRestore: true,
    };
  }

  normalizeArchiveSubfolderName(value: unknown): string {
    const rawValue = String(value ?? "").trim();

    if (!rawValue) {
      return "";
    }

    const normalized = normalizePath(rawValue).replace(/^\/+/, "").replace(/\/+$/, "");

    if (!normalized || normalized === "/" || normalized === ".") {
      return "";
    }

    return normalized.split("/").filter(Boolean).join("-");
  }

  t(key: TranslationKey, values: TemplateValues = {}): string {
    const language = this.getEffectiveLanguage();
    const dictionary = TRANSLATIONS[language] ?? TRANSLATIONS.en;
    const template = dictionary[key] ?? TRANSLATIONS.en[key] ?? key;

    return template.replace(/\{(\w+)\}/g, (_, valueKey: string) => String(values[valueKey] ?? ""));
  }

  getEffectiveLanguage(): EffectiveLanguage {
    if (this.settings.language && this.settings.language !== LANGUAGE_OPTIONS.SYSTEM) {
      return this.isEffectiveLanguage(this.settings.language) ? this.settings.language : LANGUAGE_OPTIONS.EN;
    }

    const locale = this.getSystemLocale();

    if (locale.startsWith("zh-tw") || locale.startsWith("zh-hant") || locale.startsWith("zh-hk") || locale.startsWith("zh-mo")) {
      return LANGUAGE_OPTIONS.ZH_TW;
    }

    return LANGUAGE_OPTIONS.EN;
  }

  getSystemLocale(): string {
    const vaultWithConfig = this.app.vault as typeof this.app.vault & { getConfig?: (key: string) => unknown };
    const { moment: activeMoment, navigator } = activeWindow as WindowWithMoment;
    const candidates = [
      vaultWithConfig.getConfig?.("locale"),
      activeMoment?.locale?.(),
      navigator?.language,
      ...(navigator?.languages ?? []),
    ];

    return String(candidates.find(Boolean) ?? LANGUAGE_OPTIONS.EN).toLowerCase();
  }

  isSupportedLanguageSetting(language: unknown): language is LanguageSetting {
    return language === LANGUAGE_OPTIONS.SYSTEM || this.isEffectiveLanguage(language);
  }

  private isEffectiveLanguage(language: unknown): language is EffectiveLanguage {
    return typeof language === "string" && Object.prototype.hasOwnProperty.call(TRANSLATIONS, language);
  }
}

class MirrorArchiveSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: MirrorArchivePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const t = (key: TranslationKey, values: TemplateValues = {}) => this.plugin.t(key, values);

    containerEl.empty();

    new Setting(containerEl)
      .setName(t("settings.language.name"))
      .setDesc(t("settings.language.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption(LANGUAGE_OPTIONS.SYSTEM, t("settings.language.system"))
          .addOption(LANGUAGE_OPTIONS.EN, t("settings.language.en"))
          .addOption(LANGUAGE_OPTIONS.ZH_TW, t("settings.language.zhTW"))
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            this.plugin.settings.language = this.plugin.isSupportedLanguageSetting(value) ? value : DEFAULT_SETTINGS.language;
            await this.plugin.saveSettings();
            this.plugin.updateRibbonIcon();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.archiveLocation.name"))
      .setDesc(t("settings.archiveLocation.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption(ARCHIVE_LOCATIONS.CURRENT_FOLDER_SUBFOLDER, t("settings.archiveLocation.currentFolderSubfolder"))
          .addOption(ARCHIVE_LOCATIONS.SPECIFIED_FOLDER, t("settings.archiveLocation.specifiedFolder"))
          .setValue(this.plugin.settings.archiveLocation)
          .onChange(async (value) => {
            this.plugin.settings.archiveLocation = isArchiveLocation(value) ? value : DEFAULT_SETTINGS.archiveLocation;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.archiveLocation === ARCHIVE_LOCATIONS.CURRENT_FOLDER_SUBFOLDER) {
      new Setting(containerEl)
        .setName(t("settings.archiveSubfolderName.name"))
        .setDesc(t("settings.archiveSubfolderName.desc"))
        .addText((text) =>
          text
            .setPlaceholder(t("settings.archiveSubfolderName.placeholder"))
            .setValue(this.plugin.settings.archiveSubfolderName)
            .onChange(async (value) => {
              this.plugin.settings.archiveSubfolderName = this.plugin.normalizeArchiveSubfolderName(value);
              await this.plugin.saveSettings();
            })
        );
    }

    if (this.plugin.settings.archiveLocation === ARCHIVE_LOCATIONS.SPECIFIED_FOLDER) {
      new Setting(containerEl)
        .setName(t("settings.archiveFolderPath.name"))
        .setDesc(t("settings.archiveFolderPath.desc"))
        .addText((text) => {
          text
            .setPlaceholder(t("settings.archiveFolderPath.placeholder"))
            .setValue(this.plugin.settings.archiveFolderPath)
            .onChange(async (value) => {
              this.plugin.settings.archiveFolderPath = this.plugin.normalizeArchiveFolderPath(value);
              await this.plugin.saveSettings();
            });

          new FolderSuggest(this.app, text.inputEl, async (folderPath) => {
            this.plugin.settings.archiveFolderPath = this.plugin.normalizeArchiveFolderPath(folderPath);
            text.setValue(this.plugin.settings.archiveFolderPath);
            await this.plugin.saveSettings();
          });
        });
    }

    const renderRules = (): void => {
      new Setting(containerEl)
        .setName(t("settings.rules.name"))
        .setDesc(t("settings.rules.desc"))
        .setHeading()
        .addButton((button) =>
          button.setButtonText(t("settings.rules.add")).onClick(async () => {
            this.plugin.settings.rules.push(this.plugin.createArchiveRule());
            await this.plugin.saveSettings();
            this.display();
          })
        );

      if (this.plugin.settings.rules.length === 0) {
        new Setting(containerEl).setDesc(t("settings.rules.empty"));
      }

      this.plugin.settings.rules.forEach((rule, index) => {
        const sourceLabel = rule.sourceFolderPath || t("settings.rules.unset");
        const destinationLabel = rule.destinationFolderPath || t("settings.rules.unset");
        const ruleSetting = new Setting(containerEl)
          .setName(t("settings.rules.ruleName", { index: index + 1 }))
          .setDesc(t("settings.rules.summary", { source: sourceLabel, destination: destinationLabel }))
          .addToggle((toggle) =>
            toggle.setValue(rule.enabled).onChange(async (value) => {
              if (value && !this.plugin.isArchiveRuleValid(rule)) {
                toggle.setValue(false);
                new Notice(t("notice.invalidRule", { index: index + 1 }));
                return;
              }

              rule.enabled = value;
              await this.plugin.saveSettings();
            })
          );

        ruleSetting
          .addExtraButton((button) =>
            button
              .setIcon("arrow-up")
              .setTooltip(t("settings.rules.moveUp"))
              .setDisabled(index === 0)
              .onClick(async () => {
                const [movedRule] = this.plugin.settings.rules.splice(index, 1);
                this.plugin.settings.rules.splice(index - 1, 0, movedRule);
                await this.plugin.saveSettings();
                this.display();
              })
          )
          .addExtraButton((button) =>
            button
              .setIcon("arrow-down")
              .setTooltip(t("settings.rules.moveDown"))
              .setDisabled(index === this.plugin.settings.rules.length - 1)
              .onClick(async () => {
                const [movedRule] = this.plugin.settings.rules.splice(index, 1);
                this.plugin.settings.rules.splice(index + 1, 0, movedRule);
                await this.plugin.saveSettings();
                this.display();
              })
          )
          .addExtraButton((button) =>
            button
              .setIcon("trash-2")
              .setTooltip(t("settings.rules.remove"))
              .onClick(async () => {
                this.plugin.settings.rules.splice(index, 1);
                await this.plugin.saveSettings();
                this.display();
              })
          );

        new Setting(containerEl)
          .setName(t("settings.rules.source.name"))
          .setDesc(t("settings.rules.source.desc"))
          .addText((text) => {
            text
              .setPlaceholder(t("settings.rules.source.placeholder"))
              .setValue(rule.sourceFolderPath)
              .onChange(async (value) => {
                rule.sourceFolderPath = this.plugin.normalizeArchiveFolderPath(value);
                await this.plugin.saveSettings();
              });

            new FolderSuggest(this.app, text.inputEl, async (folderPath) => {
              rule.sourceFolderPath = this.plugin.normalizeArchiveFolderPath(folderPath);
              text.setValue(rule.sourceFolderPath);
              await this.plugin.saveSettings();
              this.display();
            });
          });

        new Setting(containerEl)
          .setName(t("settings.rules.destination.name"))
          .setDesc(t("settings.rules.destination.desc"))
          .addText((text) => {
            text
              .setPlaceholder(t("settings.rules.destination.placeholder"))
              .setValue(rule.destinationFolderPath)
              .onChange(async (value) => {
                rule.destinationFolderPath = this.plugin.normalizeArchiveFolderPath(value);
                await this.plugin.saveSettings();
              });

            new FolderSuggest(this.app, text.inputEl, async (folderPath) => {
              rule.destinationFolderPath = this.plugin.normalizeArchiveFolderPath(folderPath);
              text.setValue(rule.destinationFolderPath);
              await this.plugin.saveSettings();
              this.display();
            });
          });

        new Setting(containerEl)
          .setName(t("settings.rules.restore.name"))
          .setDesc(t("settings.rules.restore.desc"))
          .addToggle((toggle) =>
            toggle.setValue(rule.allowRestore).onChange(async (value) => {
              rule.allowRestore = value;
              await this.plugin.saveSettings();
            })
          );
      });
    };

    new Setting(containerEl)
      .setName(t("settings.conflict.name"))
      .setDesc(t("settings.conflict.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption(CONFLICT_BEHAVIORS.SEQUENCE, t("settings.conflict.sequence"))
          .addOption(CONFLICT_BEHAVIORS.TIMESTAMP, t("settings.conflict.timestamp"))
          .addOption(CONFLICT_BEHAVIORS.SKIP, t("settings.conflict.skip"))
          .addOption(CONFLICT_BEHAVIORS.STOP, t("settings.conflict.stop"))
          .setValue(this.plugin.settings.conflictBehavior)
          .onChange(async (value) => {
            this.plugin.settings.conflictBehavior = isConflictBehavior(value) ? value : DEFAULT_SETTINGS.conflictBehavior;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.ribbon.name"))
      .setDesc(t("settings.ribbon.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showRibbonIcon).onChange(async (value) => {
          this.plugin.settings.showRibbonIcon = value;
          await this.plugin.saveSettings();
          this.plugin.updateRibbonIcon();
        })
      );

    new Setting(containerEl)
      .setName(t("settings.fileMenu.name"))
      .setDesc(t("settings.fileMenu.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showFileMenuItem).onChange(async (value) => {
          this.plugin.settings.showFileMenuItem = value;
          await this.plugin.saveSettings();
        })
      );

    renderRules();
  }
}

class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(app: App, inputEl: HTMLInputElement, private readonly onChoose: FolderChooseHandler) {
    super(app, inputEl);
  }

  getSuggestions(query: string): TFolder[] {
    const normalizedQuery = normalizePath(query.trim()).toLowerCase();
    const folders = this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder && Boolean(file.path))
      .sort((a, b) => a.path.localeCompare(b.path));

    if (!normalizedQuery) {
      return folders.slice(0, 50);
    }

    return folders.filter((folder) => folder.path.toLowerCase().includes(normalizedQuery)).slice(0, 50);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    void this.onChoose(folder.path);
    this.close();
  }
}

class ArchiveConflictError extends Error {
  constructor(path: string) {
    super(`Archive target already exists: ${path}`);
    this.name = "ArchiveConflictError";
  }
}
