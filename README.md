# Mirror Archive Plugin for Obsidian

Mirror Archive archives and restores files and folders while preserving their original paths.

For example, if the archive folder path is `Archives`:

```text
Projects/Client A/spec.pdf
```

becomes:

```text
Archives/Projects/Client A/spec.pdf
```

Run the same action on the archived item to restore it:

```text
Archives/Projects/Client A/spec.pdf
```

becomes:

```text
Projects/Client A/spec.pdf
```

## Features

- Archive the active file from the command palette.
- Restore archived files and folders with the same command, hotkey, toolbar button, or context menu action.
- Archive Markdown notes, PDFs, images, Office documents, and other files.
- Archive or restore selected files and folders from the file explorer context menu.
- Preserve the original path under a specified archive folder.
- Or archive into a subfolder beside the original item.
- Reuse an existing parent archive location when subfolder archiving can match one.
- Automatically create intermediate folders.
- Configurable conflict behavior when an archive target already exists.
- Built-in language setting with English and Traditional Chinese.
- Optional left toolbar button and file explorer context menu actions.

## Setup

After enabling the plugin, open the plugin settings and choose **Archive location**.

You can archive into a subfolder next to the original item, or into one specified folder while preserving the original path under it. The plugin does not choose a destination by default, which prevents accidental moves into an unexpected folder.

## Usage

- Run `Mirror Archive` from the command palette to archive the active file, or restore it if it is already archived.
- Right-click a file or folder in the file explorer and choose `Mirror Archive` or `Restore from Archive`.
- Select multiple items in the file explorer, right-click one of the selected items, and choose the matching archive or restore action.
- Assign a hotkey to the `Mirror Archive` command in Obsidian's hotkey settings.
- Select only regular items or only archived items in one run. Mixed selections are ignored to avoid moving items in two directions at once.

## Settings

- **Language**: Use the system language, English, or Traditional Chinese.
- **Archive location**: Choose whether archived items stay near their original location or move into one specified folder.
- **Subfolder name**: When archiving near the original location, create this subfolder inside the current folder. If a matching archive location already exists in a parent folder, the plugin reuses it.
- **Archive folder path**: When archiving into a specified folder, use this folder as the starting point and preserve the original path under it. Existing folders are suggested, and new folder paths are allowed.
- **Conflict behavior**: Choose how to handle collisions when archiving or restoring.
  - **Append sequence number**: Rename the target by appending a number, such as `note 1.md`.
  - **Append timestamp**: Rename the target by appending a timestamp.
  - **Skip existing target**: Leave the source item in place and skip it.
  - **Stop on conflict**: Stop the current run when a collision is found.
- **Show left toolbar button**: Adds an archive button to the left toolbar.
- **Add to context menu**: Adds archive and restore actions to file, folder, and multi-selection context menus in the file explorer.

Mirror Archive does not overwrite existing files or folders.

## Localization

Localization files live in `src/locales`. To add another language, add a locale JSON file, import it from `src/i18n.ts`, add it to `LANGUAGE_OPTIONS`, expose it in the Language setting, then run `npm run build`.

## Development

Mirror Archive is developed in TypeScript and bundled with esbuild.

```bash
npm install
npm run dev
npm run check
```

If you do not want to install Node.js locally, open the repository in the included dev container. It uses Node.js 22 and runs `npm install` after the container is created.

## Release Checklist

For each release:

1. Update `manifest.json`.
2. Update `package.json`.
3. Update `versions.json`.
4. Push the release commit to `main`.
5. Create and push a Git tag that exactly matches the version in `manifest.json`.

```bash
git tag 1.0.0
git push origin 1.0.0
```

The release workflow runs `npm ci`, `npm run check`, validates the tag against `manifest.json`, `package.json`, and `versions.json`, builds `dist/`, and publishes a GitHub release with `dist/manifest.json`, `dist/main.js`, and `dist/styles.css` if a stylesheet is present.

If a release already exists for the tag, the workflow skips publishing. Bump the version before pushing a new release tag.

`src/main.ts`, `src/i18n.ts`, and `src/locales/` are the maintainable source files. `dist/` is generated because Obsidian community plugin installation downloads `manifest.json`, `main.js`, and `styles.css` if present.

## License

MIT
