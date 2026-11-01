# Vault Modules

Obsidian plugin that lets you turn folders of your vault on and off as modules.
Disabled folders are removed from Obsidian's index, which keeps search, graph and
file lists focused on what you currently work with.

> Designed by me, built with Claude Code (AI-assisted).

![screenshot](docs/screenshot.png)

## Features

- Enable and disable vault folders as separate modules
- Disabled modules are unloaded from the index
- Optimized for [Remotely Save](https://community.obsidian.md/plugins/remotely-save): all modules are temporarily enabled during sync, then restored to their previous state afterwards.

## Installation

Manual:
1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Put them in `<vault>/.obsidian/plugins/vault-modules/`.
3. Reload Obsidian and enable the plugin in Settings → Community plugins.

Via BRAT: add `kuumeunta/vault-modules` as a beta plugin.

## Usage

- The status bar shows how many modules are enabled (`Modules: 4/7`). Click it to open the modules window.
- In the window, toggle individual modules, use **Enable all** / **Disable all**, or pick a profile and click **Apply**.
- In the plugin settings, add the folders that should be treated as modules and configure the behavior.

## How it works

A disabled module is a folder renamed to `.off-<name>`. Obsidian does not index folders whose names start with a dot, so their contents drop out of search, the graph and the link cache. Links to notes in disabled modules become unresolved but are not rewritten. Enabling a module renames the folder back.

## Settings

- **Close tabs before unloading:** closes open notes from a folder before it is disabled.
- **Remotely Save compatibility:** all modules are temporarily enabled during sync, then restored to their previous state.
- **Unloaded folder prefix:** `.off-` by default; can only be changed while all modules are enabled.
- 
## Warning

This plugin renames folders in your vault. Back up your vault before using it.
Other sync tools (Obsidian Sync, Syncthing, git, etc.) will see the renamed folders;
Remotely Save is the only sync plugin with built-in support.
If a folder is left with the `.off-` prefix, use **Enable all** or rename it back manually.

## License

MIT
