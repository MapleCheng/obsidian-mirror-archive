# Mirror Archive Plugin for Obsidian

Mirror Archive moves files and folders into a configurable archive root while preserving their original vault paths.

For example, if your archive root is `Archives`:

```text
Projects/Client A/spec.pdf
```

becomes:

```text
Archives/Projects/Client A/spec.pdf
```

## Features

- Archive the active file from the command palette.
- Archive Markdown notes, PDFs, images, Office documents, and other vault files.
- Archive selected files and folders from the file explorer context menu.
- Preserve the original vault path under the configured archive root.
- Automatically create intermediate folders.
- Configurable conflict behavior when an archive target already exists.
- Built-in language setting with English and Traditional Chinese.
- Optional ribbon icon, context menu item, folder archiving, and multi-selection command behavior.

## Setup

After enabling the plugin, open the plugin settings and set **Archive root**. You can type any vault-relative folder path, including a folder that does not exist yet, or choose an existing folder from suggestions.

The plugin does not choose an archive root by default. This keeps the plugin vault-agnostic and prevents accidental moves into an unexpected folder.

## Usage

- Run `Mirror Archive` from the command palette to archive the active file.
- Right-click a file or folder in the file explorer and choose `Mirror Archive`.
- Select multiple items in the file explorer, right-click one of the selected items, and choose `Mirror Archive N selected items`.
- Assign a hotkey to the `Mirror Archive` command in Obsidian's hotkey settings.

## Settings

- **Language**: Use the system language, English, or Traditional Chinese.
- **Archive root**: Vault-relative folder that receives mirrored archive paths. Existing folders are suggested, and new folder paths are allowed.
- **Conflict behavior**: Choose how to handle archive target collisions.
  - **Append timestamp**: Rename the archive target by appending a timestamp.
  - **Skip existing target**: Leave the source item in place and skip it.
  - **Stop on conflict**: Stop the current archive run when a collision is found.
- **Show ribbon icon**: Adds a left ribbon button.
- **Show file menu item**: Adds file explorer context menu actions.
- **Allow folder archive**: Allows moving entire folders.
- **Use file explorer selection for hotkeys**: Archives the focused file explorer selection before falling back to the active file.
- **Show selected count in menu**: Shows the number of selected items in the context menu label.

Mirror Archive does not overwrite existing files or folders.

## Localization

Localization source lives in `src/i18n.ts`. To add another language, add a language key to `TRANSLATIONS`, add it to `LANGUAGE_OPTIONS`, expose it in the Language setting, then run `npm run build`.

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

`src/main.ts` and `src/i18n.ts` are the maintainable source files. `dist/` is generated because Obsidian community plugin installation downloads `manifest.json`, `main.js`, and `styles.css` if present.

## License

MIT
