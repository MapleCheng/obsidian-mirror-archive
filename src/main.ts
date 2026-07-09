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

interface MirrorArchiveSettings {
  archiveLocation: ArchiveLocation;
  archiveSubfolderName: string;
  archiveFolderPath: string;
  conflictBehavior: ConflictBehavior;
  language: LanguageSetting;
  showRibbonIcon: boolean;
  showFileMenuItem: boolean;
}

type RawMirrorArchiveSettings = Partial<MirrorArchiveSettings> & {
  archiveRoot?: string;
  allowFolderArchive?: boolean;
  useFileExplorerSelectionForHotkey?: boolean;
  showSelectedCountInMenu?: boolean;
};

type ArchiveTarget = TFile | TFolder;

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
        this.addArchiveMenuItem(menu, this.getContextTargets(target));
      })
    );

    this.registerEvent(
      this.app.workspace.on("files-menu", (menu, targets) => {
        this.addArchiveMenuItem(menu, targets);
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
      callback: () => this.archiveActiveFile(),
    });
  }

  updateRibbonIcon(): void {
    this.ribbonIconEl?.remove();
    this.ribbonIconEl = null;

    if (this.settings.showRibbonIcon) {
      this.ribbonIconEl = this.addRibbonIcon("archive", this.t("command.mirrorArchive"), () => this.archiveActiveFile());
    }
  }

  async archiveActiveFile(): Promise<void> {
    if (!this.hasArchiveDestination()) {
      this.showMissingArchiveDestinationNotice();
      return;
    }

    const selectedTargets = this.getSelectedTargets({ focusedOnly: true });
    if (selectedTargets.length > 0) {
      await this.archiveTargets(selectedTargets);
      return;
    }

    const file = this.app.workspace.getActiveFile();

    if (!file) {
      new Notice(this.t("notice.noActiveFile"));
      return;
    }

    await this.archiveTargets([file]);
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
      new Notice(this.getBatchSummary(successCount, skippedCount, conflictCount, failures.length, stoppedOnConflict));
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

  getBatchSummary(
    successCount: number,
    skippedCount: number,
    conflictCount: number,
    failureCount: number,
    stoppedOnConflict: boolean
  ): string {
    const parts: string[] = [];

    if (successCount > 0) {
      parts.push(this.t("summary.archived", { count: successCount }));
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
      prefix: stoppedOnConflict ? this.t("summary.stopped") : this.t("summary.finished"),
      parts: parts.join(this.t("summary.separator")),
    });
  }

  getContextTargets(target: unknown): ArchiveTarget[] {
    if (!this.canArchive(target)) {
      return [];
    }

    const selectedTargets = this.getSelectedTargets();
    const selectedContainsTarget = selectedTargets.some((selectedTarget) => selectedTarget.path === target.path);

    if (selectedContainsTarget && selectedTargets.length > 1) {
      return this.normalizeTargets(selectedTargets);
    }

    return this.normalizeTargets([target]);
  }

  addArchiveMenuItem(menu: Menu, targets: unknown[]): void {
    if (!this.settings.showFileMenuItem) {
      return;
    }

    const normalizedTargets = this.normalizeTargets(targets);

    if (normalizedTargets.length === 0) {
      return;
    }

    const label =
      normalizedTargets.length > 1
        ? this.t("menu.archiveSelected", { count: normalizedTargets.length })
        : this.t("command.mirrorArchive");

    menu.addItem((item) => {
      item
        .setTitle(label)
        .setIcon("archive")
        .onClick(() => {
          void this.archiveTargets(normalizedTargets);
        });
    });
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
      if (this.isSelectedFileExplorerItem(item) && this.canArchive(item.file)) {
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
      if (this.canArchive(target)) {
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
      if (this.canArchive(target)) {
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

  canArchive(target: unknown): target is ArchiveTarget {
    const isArchiveableType = target instanceof TFile || target instanceof TFolder;
    return isArchiveableType && Boolean(target.path) && !this.isArchived(target);
  }

  isAncestorPath(parentPath: string, childPath: string): boolean {
    return childPath.startsWith(`${parentPath}/`);
  }

  isArchived(target: ArchiveTarget): boolean {
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
    if (this.settings.archiveLocation === ARCHIVE_LOCATIONS.CURRENT_FOLDER_SUBFOLDER) {
      const parentPath = this.getFolderPath(target.path);
      return normalizePath([parentPath, this.getArchiveSubfolderName(), target.name].filter(Boolean).join("/"));
    }

    return normalizePath(`${this.getArchiveFolderPath()}/${target.path}`);
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
