import {
  AbstractInputSuggest,
  App,
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

type MomentGlobal = (() => { format(format: string): string }) & {
  locale?: () => string;
};

type GlobalWithMoment = typeof globalThis & {
  moment?: MomentGlobal;
};

const CONFLICT_BEHAVIORS = {
  TIMESTAMP: "timestamp",
  SKIP: "skip",
  STOP: "stop",
} as const;

type ConflictBehavior = (typeof CONFLICT_BEHAVIORS)[keyof typeof CONFLICT_BEHAVIORS];

interface MirrorArchiveSettings {
  archiveRoot: string;
  conflictBehavior: ConflictBehavior;
  language: LanguageSetting;
  showRibbonIcon: boolean;
  showFileMenuItem: boolean;
  allowFolderArchive: boolean;
  useFileExplorerSelectionForHotkey: boolean;
  showSelectedCountInMenu: boolean;
}

type ArchiveTarget = TFile | TFolder;

interface ArchiveResult {
  skipped: boolean;
  targetPath?: string;
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
  archiveRoot: "",
  conflictBehavior: CONFLICT_BEHAVIORS.TIMESTAMP,
  language: LANGUAGE_OPTIONS.SYSTEM,
  showRibbonIcon: true,
  showFileMenuItem: true,
  allowFolderArchive: true,
  useFileExplorerSelectionForHotkey: true,
  showSelectedCountInMenu: true,
};

function isConflictBehavior(value: unknown): value is ConflictBehavior {
  return Object.values(CONFLICT_BEHAVIORS).includes(value as ConflictBehavior);
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
        if (!this.settings.showFileMenuItem) {
          return;
        }

        if (this.canArchive(target)) {
          const targets = this.getContextTargets(target);
          const label =
            targets.length > 1 && this.settings.showSelectedCountInMenu
              ? this.t("menu.archiveSelected", { count: targets.length })
              : this.t("command.mirrorArchive");

          menu.addItem((item) => {
            item
              .setTitle(label)
              .setIcon("archive")
              .onClick(() => this.archiveTargets(targets));
          });
        }
      })
    );
  }

  async loadSettings(): Promise<void> {
    const loadedData = (await this.loadData()) as Partial<MirrorArchiveSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
    this.settings.archiveRoot = this.normalizeArchiveRoot(this.settings.archiveRoot);

    if (!isConflictBehavior(this.settings.conflictBehavior)) {
      this.settings.conflictBehavior = DEFAULT_SETTINGS.conflictBehavior;
    }

    if (!this.isSupportedLanguageSetting(this.settings.language)) {
      this.settings.language = DEFAULT_SETTINGS.language;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  registerCommands(): void {
    const removablePlugin = this as Plugin & { removeCommand?: (id: string) => void };
    removablePlugin.removeCommand?.("mirror-archive-active-file");

    this.addCommand({
      id: "mirror-archive-active-file",
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
    if (!this.hasArchiveRoot()) {
      this.showMissingArchiveRootNotice();
      return;
    }

    if (this.settings.useFileExplorerSelectionForHotkey) {
      const selectedTargets = this.getSelectedTargets({ focusedOnly: true });
      if (selectedTargets.length > 0) {
        await this.archiveTargets(selectedTargets);
        return;
      }
    }

    const file = this.app.workspace.getActiveFile();

    if (!file) {
      new Notice(this.t("notice.noActiveFile"));
      return;
    }

    await this.archiveTargets([file]);
  }

  async archiveTargets(targets: unknown[]): Promise<void> {
    if (!this.hasArchiveRoot()) {
      this.showMissingArchiveRootNotice();
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

          if (this.settings.conflictBehavior === CONFLICT_BEHAVIORS.STOP) {
            stoppedOnConflict = true;
            break;
          }
        } else {
          console.error(error);
          failures.push({ target, error });
        }
      }
    }

    if (stoppedOnConflict || failures.length > 0) {
      new Notice(this.getBatchSummary(successCount, skippedCount, conflictCount, failures.length, stoppedOnConflict));
      return;
    }

    if (skippedCount > 0) {
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

    const archiveRoot = this.getArchiveRoot();
    const targetPath = await this.getAvailablePath(`${archiveRoot}/${target.path}`, target instanceof TFolder);

    if (!targetPath) {
      return { skipped: true };
    }

    const targetFolder = this.getFolderPath(targetPath);

    await this.ensureFolder(targetFolder);
    await this.app.fileManager.renameFile(target, targetPath);

    return { skipped: false, targetPath };
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

    const prefix = stoppedOnConflict ? this.t("summary.stopped") : this.t("summary.finished");
    return this.t("summary.template", { prefix, parts: parts.join(this.t("summary.separator")) });
  }

  getContextTargets(target: ArchiveTarget): ArchiveTarget[] {
    const selectedTargets = this.getSelectedTargets();
    const selectedContainsTarget = selectedTargets.some((selectedTarget) => selectedTarget.path === target.path);

    if (selectedContainsTarget && selectedTargets.length > 1) {
      return this.normalizeTargets(selectedTargets);
    }

    return this.normalizeTargets([target]);
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
    const activeLeaf = this.app.workspace.activeLeaf as ({ view?: unknown } & object) | null;

    if (activeLeaf?.view === view || view.leaf === activeLeaf) {
      return true;
    }

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
    const isArchiveableType = target instanceof TFile || (this.settings.allowFolderArchive && target instanceof TFolder);
    return isArchiveableType && Boolean(target.path) && !this.isArchived(target);
  }

  isAncestorPath(parentPath: string, childPath: string): boolean {
    return childPath.startsWith(`${parentPath}/`);
  }

  isArchived(target: ArchiveTarget): boolean {
    const archiveRoot = this.getArchiveRoot();
    return target.path === archiveRoot || target.path.startsWith(`${archiveRoot}/`);
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

  getTimestamp(): string {
    const moment = (globalThis as GlobalWithMoment).moment;

    if (moment) {
      return moment().format("YYYYMMDD-HHmmss");
    }

    return new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  }

  getArchiveRoot(): string {
    return this.normalizeArchiveRoot(this.settings.archiveRoot);
  }

  hasArchiveRoot(): boolean {
    return this.getArchiveRoot().length > 0;
  }

  showMissingArchiveRootNotice(): void {
    new Notice(this.t("notice.missingArchiveRoot"));
  }

  normalizeArchiveRoot(value: unknown): string {
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
    const moment = (globalThis as GlobalWithMoment).moment;
    const candidates = [
      vaultWithConfig.getConfig?.("locale"),
      moment?.locale?.(),
      globalThis.navigator?.language,
      ...(globalThis.navigator?.languages ?? []),
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
            this.plugin.registerCommands();
            this.plugin.updateRibbonIcon();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.archiveRoot.name"))
      .setDesc(t("settings.archiveRoot.desc"))
      .addText((text) => {
        text
          .setPlaceholder(t("settings.archiveRoot.placeholder"))
          .setValue(this.plugin.settings.archiveRoot)
          .onChange(async (value) => {
            this.plugin.settings.archiveRoot = this.plugin.normalizeArchiveRoot(value);
            await this.plugin.saveSettings();
          });

        new FolderSuggest(this.app, text.inputEl, async (folderPath) => {
          this.plugin.settings.archiveRoot = this.plugin.normalizeArchiveRoot(folderPath);
          text.setValue(this.plugin.settings.archiveRoot);
          await this.plugin.saveSettings();
        });
      })
      .addExtraButton((button) =>
        button
          .setIcon("rotate-ccw")
          .setTooltip(t("settings.archiveRoot.clear"))
          .onClick(async () => {
            this.plugin.settings.archiveRoot = DEFAULT_SETTINGS.archiveRoot;
            await this.plugin.saveSettings();
            this.display();
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
      .setName(t("settings.conflict.name"))
      .setDesc(t("settings.conflict.desc"))
      .addDropdown((dropdown) =>
        dropdown
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
      .setName(t("settings.fileMenu.name"))
      .setDesc(t("settings.fileMenu.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showFileMenuItem).onChange(async (value) => {
          this.plugin.settings.showFileMenuItem = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("settings.folderArchive.name"))
      .setDesc(t("settings.folderArchive.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.allowFolderArchive).onChange(async (value) => {
          this.plugin.settings.allowFolderArchive = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("settings.hotkeySelection.name"))
      .setDesc(t("settings.hotkeySelection.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.useFileExplorerSelectionForHotkey).onChange(async (value) => {
          this.plugin.settings.useFileExplorerSelectionForHotkey = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName(t("settings.selectedCount.name"))
      .setDesc(t("settings.selectedCount.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showSelectedCountInMenu).onChange(async (value) => {
          this.plugin.settings.showSelectedCountInMenu = value;
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
