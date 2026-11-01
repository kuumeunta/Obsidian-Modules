"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const obsidian_1 = require("obsidian");
const DEFAULT_SETTINGS = {
    modules: [],
    profiles: [],
    prefix: ".off-",
    closeOpenFiles: true,
    guardRemotelySave: true,
    pendingRestore: [],
};
const RS_ID = "remotely-save";
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* ---------- Plugin ---------- */
class VaultModulesPlugin extends obsidian_1.Plugin {
    constructor() {
        super(...arguments);
        this.settings = DEFAULT_SETTINGS;
        this.statusEl = null;
        this.queue = Promise.resolve();
        this.syncDepth = 0;
        this.syncPrep = null;
        this.unpatchers = new Map();
    }
    async onload() {
        await this.loadSettings();
        this.addRibbonIcon("blocks", "Vault modules", () => new ModulesModal(this.app, this).open());
        this.statusEl = this.addStatusBarItem();
        this.statusEl.addClass("vm-status");
        this.statusEl.addEventListener("click", () => new ModulesModal(this.app, this).open());
        this.addCommand({
            id: "open-panel",
            name: "Open modules panel",
            callback: () => new ModulesModal(this.app, this).open(),
        });
        this.addCommand({
            id: "toggle-module",
            name: "Toggle module…",
            callback: () => {
                if (!this.settings.modules.length)
                    return new obsidian_1.Notice("No modules added. See the plugin settings.");
                new ModulePicker(this.app, this).open();
            },
        });
        this.addCommand({
            id: "apply-profile",
            name: "Apply profile…",
            callback: () => {
                if (!this.settings.profiles.length)
                    return new obsidian_1.Notice("No profiles created.");
                new ProfilePicker(this.app, this).open();
            },
        });
        this.addCommand({
            id: "save-profile",
            name: "Save current state as a profile…",
            callback: () => new NameModal(this.app, "Profile name", "", async (name) => {
                await this.saveProfileFromCurrent(name);
                new obsidian_1.Notice(`Profile “${name}” saved`);
            }).open(),
        });
        this.addCommand({
            id: "enable-all",
            name: "Enable all modules",
            callback: () => this.setAll(true),
        });
        this.addCommand({
            id: "disable-all",
            name: "Disable all modules",
            callback: () => this.setAll(false),
        });
        this.addSettingTab(new VMSettingTab(this.app, this));
        this.app.workspace.onLayoutReady(async () => {
            await this.refreshStatus();
            // if Obsidian was closed in the middle of a sync, restore the modules to their previous state
            if (this.settings.pendingRestore.length && this.syncDepth === 0)
                await this.restoreAfterSync();
        });
        // Remotely Save may load after us or be enabled/reloaded on the fly —
        // so we periodically check that the hook is in place.
        this.hookRemotelySave();
        this.registerInterval(window.setInterval(() => this.hookRemotelySave(), 3000));
    }
    onunload() {
        for (const undo of this.unpatchers.values())
            undo();
        this.unpatchers.clear();
    }
    /* ----- Remotely Save integration ----- */
    hookRemotelySave() {
        var _a;
        if (!this.settings.guardRemotelySave)
            return;
        const plugins = (_a = this.app.plugins) === null || _a === void 0 ? void 0 : _a.plugins;
        const rs = plugins === null || plugins === void 0 ? void 0 : plugins[RS_ID];
        if (!rs || typeof rs.syncRun !== "function" || this.unpatchers.has(rs))
            return;
        const original = rs.syncRun;
        const hadOwn = Object.prototype.hasOwnProperty.call(rs, "syncRun");
        const wrapper = async (...args) => {
            if (!this.settings.guardRemotelySave)
                return original.apply(rs, args);
            const ok = await this.beginSync();
            try {
                if (!ok) {
                    new obsidian_1.Notice("Vault Modules: failed to enable all modules; sync cancelled to avoid deleting them on the server.", 10000);
                    return;
                }
                return await original.apply(rs, args);
            }
            finally {
                await this.endSync();
            }
        };
        rs.syncRun = wrapper;
        this.unpatchers.set(rs, () => {
            if (rs.syncRun !== wrapper)
                return;
            if (hadOwn)
                rs.syncRun = original;
            else
                delete rs.syncRun;
        });
        console.log("[vault-modules] Remotely Save hook installed");
    }
    beginSync() {
        this.syncDepth++;
        if (this.syncDepth === 1)
            this.syncPrep = this.prepareForSync();
        return this.syncPrep;
    }
    async endSync() {
        var _a;
        this.syncDepth--;
        if (this.syncDepth > 0)
            return;
        await ((_a = this.syncPrep) !== null && _a !== void 0 ? _a : Promise.resolve(true)).catch(() => undefined);
        this.syncPrep = null;
        await this.restoreAfterSync();
    }
    /** Enables all unloaded modules and waits for Obsidian to index their files */
    async prepareForSync() {
        try {
            const toEnable = [];
            for (const m of this.settings.modules) {
                if ((await this.getState(m)) === "unloaded")
                    toEnable.push(m);
            }
            if (!toEnable.length)
                return true;
            // remember in advance (and persist to disk) to survive Obsidian closing during a sync
            const pending = new Set([...this.settings.pendingRestore, ...toEnable.map((m) => m.id)]);
            this.settings.pendingRestore = [...pending];
            await this.saveData(this.settings);
            let allOk = true;
            for (const m of toEnable)
                if (!(await this.setModule(m, true)))
                    allOk = false;
            if (!allOk)
                return false;
            await this.waitForVault(toEnable);
            new obsidian_1.Notice("Vault Modules: modules enabled for the duration of the sync", 3000);
            return true;
        }
        catch (e) {
            console.error("[vault-modules]", e);
            return false;
        }
    }
    /** Switches back off everything we enabled for the sync */
    async restoreAfterSync() {
        const ids = new Set(this.settings.pendingRestore);
        if (!ids.size)
            return;
        const failed = [];
        for (const m of this.settings.modules) {
            if (!ids.has(m.id))
                continue;
            if (!(await this.setModule(m, false)))
                failed.push(m.id);
        }
        this.settings.pendingRestore = failed;
        await this.saveSettings();
        new obsidian_1.Notice(failed.length
            ? `Vault Modules: some modules could not be switched back off (${failed.length})`
            : "Vault Modules: modules restored to their previous state", failed.length ? 8000 : 3000);
    }
    /** Wait until the folders appear in Obsidian's cache and the file count stops changing */
    async waitForVault(mods) {
        const start = Date.now();
        while (Date.now() - start < 5000 && mods.some((m) => !this.app.vault.getAbstractFileByPath(m.path))) {
            await sleep(100);
        }
        let last = -1;
        let stableSince = Date.now();
        while (Date.now() - start < 20000) {
            const n = this.app.vault.getAllLoadedFiles().length;
            if (n !== last) {
                last = n;
                stableSince = Date.now();
            }
            else if (Date.now() - stableSince >= 700)
                break;
            await sleep(150);
        }
    }
    /* ----- Settings ----- */
    async loadSettings() {
        var _a, _b, _c;
        var _d, _e, _f;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        (_a = (_d = this.settings).modules) !== null && _a !== void 0 ? _a : (_d.modules = []);
        (_b = (_e = this.settings).profiles) !== null && _b !== void 0 ? _b : (_e.profiles = []);
        (_c = (_f = this.settings).pendingRestore) !== null && _c !== void 0 ? _c : (_f.pendingRestore = []);
    }
    async saveSettings() {
        await this.saveData(this.settings);
        await this.refreshStatus();
    }
    /* ----- Paths ----- */
    offPath(m) {
        const parts = m.path.split("/");
        const base = parts.pop();
        const parent = parts.join("/");
        return (0, obsidian_1.normalizePath)((parent ? parent + "/" : "") + this.settings.prefix + base);
    }
    async getState(m) {
        const a = this.app.vault.adapter;
        const [on, off] = await Promise.all([a.exists(m.path), a.exists(this.offPath(m))]);
        if (on && off)
            return "conflict";
        if (on)
            return "loaded";
        if (off)
            return "unloaded";
        return "missing";
    }
    /* ----- Queue: rename operations run strictly one at a time ----- */
    run(fn) {
        const p = this.queue.then(fn);
        this.queue = p.catch(() => undefined);
        return p;
    }
    /* ----- Enable / disable ----- */
    setModule(m, on) {
        return this.run(() => this.setModuleNow(m, on));
    }
    async setModuleNow(m, on) {
        var _a;
        const state = await this.getState(m);
        if (state === "conflict") {
            new obsidian_1.Notice(`“${m.name}”: both folders found (${m.path} and ${this.offPath(m)}). Resolve the conflict manually.`, 8000);
            return false;
        }
        if (state === "missing") {
            new obsidian_1.Notice(`“${m.name}”: folder not found in either the normal or the unloaded form.`, 6000);
            return false;
        }
        if ((on && state === "loaded") || (!on && state === "unloaded"))
            return true;
        const a = this.app.vault.adapter;
        try {
            if (on) {
                await a.rename(this.offPath(m), m.path);
            }
            else {
                if (this.settings.closeOpenFiles)
                    this.closeLeavesIn(m.path);
                await a.rename(m.path, this.offPath(m));
            }
            // give Obsidian's file watcher time to process the changes
            await sleep(150);
            return true;
        }
        catch (e) {
            console.error("[vault-modules]", e);
            new obsidian_1.Notice(`“${m.name}”: failed to rename the folder. ${(_a = e.message) !== null && _a !== void 0 ? _a : ""}`, 8000);
            return false;
        }
    }
    closeLeavesIn(folder) {
        const toClose = [];
        this.app.workspace.iterateAllLeaves((leaf) => {
            const f = leaf.view.file;
            if (f && (f.path === folder || f.path.startsWith(folder + "/")))
                toClose.push(leaf);
        });
        toClose.forEach((l) => l.detach());
    }
    async setAll(on) {
        for (const m of this.settings.modules)
            await this.setModule(m, on);
        await this.refreshStatus();
        new obsidian_1.Notice(on ? "All modules enabled" : "All modules disabled");
    }
    /* ----- Profiles ----- */
    async saveProfileFromCurrent(name) {
        const ids = [];
        for (const m of this.settings.modules) {
            if ((await this.getState(m)) === "loaded")
                ids.push(m.id);
        }
        const existing = this.settings.profiles.find((p) => p.name === name);
        if (existing)
            existing.modules = ids;
        else
            this.settings.profiles.push({ id: uid(), name, modules: ids });
        await this.saveSettings();
    }
    async applyProfile(p) {
        let ok = 0;
        let fail = 0;
        // unload first, then load — to reduce peak load on the index
        const ordered = [...this.settings.modules].sort((a, b) => Number(p.modules.includes(a.id)) - Number(p.modules.includes(b.id)));
        for (const m of ordered) {
            (await this.setModule(m, p.modules.includes(m.id))) ? ok++ : fail++;
        }
        await this.refreshStatus();
        new obsidian_1.Notice(`Profile “${p.name}” applied${fail ? `, errors: ${fail}` : ""}`);
    }
    /* ----- Status bar ----- */
    async refreshStatus() {
        if (!this.statusEl)
            return;
        const total = this.settings.modules.length;
        if (!total) {
            this.statusEl.setText("Modules: —");
            return;
        }
        let loaded = 0;
        for (const m of this.settings.modules)
            if ((await this.getState(m)) === "loaded")
                loaded++;
        this.statusEl.setText(`Modules: ${loaded}/${total}`);
        this.statusEl.setAttribute("aria-label", "Vault modules: enabled / total");
    }
}
exports.default = VaultModulesPlugin;
/* ---------- Toggle panel ---------- */
class ModulesModal extends obsidian_1.Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
    }
    onOpen() {
        this.modalEl.addClass("vm-modal");
        void this.render();
    }
    onClose() {
        this.contentEl.empty();
    }
    async render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "Vault modules" });
        const mods = this.plugin.settings.modules;
        if (!mods.length) {
            contentEl.createEl("p", { text: "No modules added. Open the plugin settings and add folders." });
            return;
        }
        const bar = contentEl.createDiv({ cls: "vm-toolbar" });
        bar.createEl("button", { text: "Enable all" }).onclick = async () => {
            await this.plugin.setAll(true);
            await this.render();
        };
        bar.createEl("button", { text: "Disable all" }).onclick = async () => {
            await this.plugin.setAll(false);
            await this.render();
        };
        const profiles = this.plugin.settings.profiles;
        if (profiles.length) {
            let selected = profiles[0].id;
            new obsidian_1.Setting(contentEl)
                .setName("Profile")
                .addDropdown((d) => {
                profiles.forEach((p) => d.addOption(p.id, p.name));
                d.setValue(selected).onChange((v) => (selected = v));
            })
                .addButton((b) => b.setButtonText("Apply").setCta().onClick(async () => {
                const p = profiles.find((x) => x.id === selected);
                if (p)
                    await this.plugin.applyProfile(p);
                await this.render();
            }));
        }
        for (const m of mods) {
            const state = await this.plugin.getState(m);
            const s = new obsidian_1.Setting(contentEl).setName(m.name).setDesc(m.path);
            s.settingEl.addClass(`vm-state-${state}`);
            if (state === "conflict" || state === "missing") {
                s.nameEl.createSpan({
                    cls: "vm-badge vm-badge-warn",
                    text: state === "conflict" ? "conflict" : "not found",
                });
                continue;
            }
            s.addToggle((t) => t.setValue(state === "loaded").onChange(async (v) => {
                t.setDisabled(true);
                await this.plugin.setModule(m, v);
                await this.plugin.refreshStatus();
                await this.render();
            }));
        }
    }
}
/* ---------- Module / profile picker from the command palette ---------- */
class ModulePicker extends obsidian_1.FuzzySuggestModal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.setPlaceholder("Which module to toggle?");
    }
    getItems() {
        return this.plugin.settings.modules;
    }
    getItemText(m) {
        return `${m.name} — ${m.path}`;
    }
    async onChooseItem(m) {
        const st = await this.plugin.getState(m);
        const ok = await this.plugin.setModule(m, st !== "loaded");
        await this.plugin.refreshStatus();
        if (ok)
            new obsidian_1.Notice(`“${m.name}”: ${st === "loaded" ? "disabled" : "enabled"}`);
    }
}
class ProfilePicker extends obsidian_1.FuzzySuggestModal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.setPlaceholder("Which profile to apply?");
    }
    getItems() {
        return this.plugin.settings.profiles;
    }
    getItemText(p) {
        return p.name;
    }
    onChooseItem(p) {
        void this.plugin.applyProfile(p);
    }
}
class FolderPicker extends obsidian_1.FuzzySuggestModal {
    constructor(app, exclude, onPick) {
        super(app);
        this.exclude = exclude;
        this.onPick = onPick;
        this.setPlaceholder("Select a module folder");
    }
    getItems() {
        return this.app.vault
            .getAllLoadedFiles()
            .filter((f) => f instanceof obsidian_1.TFolder && !f.isRoot() && !this.exclude.has(f.path));
    }
    getItemText(f) {
        return f.path;
    }
    onChooseItem(f) {
        this.onPick(f);
    }
}
class NameModal extends obsidian_1.Modal {
    constructor(app, title, initial, onSubmit) {
        super(app);
        this.title = title;
        this.initial = initial;
        this.onSubmit = onSubmit;
    }
    onOpen() {
        this.contentEl.createEl("h3", { text: this.title });
        let value = this.initial;
        const submit = () => {
            const v = value.trim();
            if (!v)
                return;
            this.close();
            void this.onSubmit(v);
        };
        new obsidian_1.Setting(this.contentEl).addText((t) => {
            t.setValue(value).onChange((v) => (value = v));
            t.inputEl.addEventListener("keydown", (e) => e.key === "Enter" && submit());
            setTimeout(() => t.inputEl.focus(), 0);
        });
        new obsidian_1.Setting(this.contentEl).addButton((b) => b.setButtonText("OK").setCta().onClick(submit));
    }
    onClose() {
        this.contentEl.empty();
    }
}
/* ---------- Settings ---------- */
class VMSettingTab extends obsidian_1.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        void this.render();
    }
    async render() {
        const { containerEl } = this;
        const s = this.plugin.settings;
        containerEl.empty();
        containerEl.createEl("p", {
            text: "A disabled module is a folder renamed to “" +
                s.prefix +
                "Name”. Obsidian does not index folders whose names start with a dot, so the contents " +
                "drop out of search, the graph and the link cache. Links to such notes will become unresolved but will not be rewritten.",
        });
        /* General */
        new obsidian_1.Setting(containerEl).setName("General").setHeading();
        new obsidian_1.Setting(containerEl)
            .setName("Close tabs before unloading")
            .setDesc("Open notes from the folder being unloaded will be closed so that no orphaned tabs are left behind.")
            .addToggle((t) => t.setValue(s.closeOpenFiles).onChange(async (v) => {
            s.closeOpenFiles = v;
            await this.plugin.saveSettings();
        }));
        new obsidian_1.Setting(containerEl)
            .setName("Remotely Save compatibility")
            .setDesc("While Remotely Save syncs (manual or automatic), temporarily enable all modules, " +
            "and after the sync switch back off those that were disabled. Without this, the sync sees the missing folders.")
            .addToggle((t) => t.setValue(s.guardRemotelySave).onChange(async (v) => {
            s.guardRemotelySave = v;
            await this.plugin.saveSettings();
        }));
        new obsidian_1.Setting(containerEl)
            .setName("Unloaded folder prefix")
            .setDesc("Must start with a dot. Can only be changed while all modules are enabled.")
            .addText((t) => t.setValue(s.prefix).onChange(async (v) => {
            if (!v.startsWith(".") || v.includes("/"))
                return;
            for (const m of s.modules) {
                if ((await this.plugin.getState(m)) !== "loaded") {
                    new obsidian_1.Notice("Enable all modules first.");
                    t.setValue(s.prefix);
                    return;
                }
            }
            s.prefix = v;
            await this.plugin.saveSettings();
        }));
        /* Modules */
        new obsidian_1.Setting(containerEl)
            .setName("Modules")
            .setHeading()
            .addButton((b) => b.setButtonText("Add folder").setCta().onClick(() => {
            const taken = new Set(s.modules.map((m) => m.path));
            new FolderPicker(this.app, taken, async (f) => {
                s.modules.push({ id: uid(), name: f.name, path: f.path });
                await this.plugin.saveSettings();
                await this.render();
            }).open();
        }));
        for (const m of s.modules) {
            const state = await this.plugin.getState(m);
            const row = new obsidian_1.Setting(containerEl)
                .setDesc(`${m.path} · ${{ loaded: "enabled", unloaded: "disabled", missing: "not found", conflict: "conflict" }[state]}`)
                .addText((t) => t.setValue(m.name).onChange(async (v) => {
                m.name = v || m.name;
                await this.plugin.saveSettings();
            }))
                .addExtraButton((b) => b
                .setIcon("trash")
                .setTooltip("Remove from list (the folder will be enabled)")
                .onClick(async () => {
                if (state === "unloaded") {
                    const ok = await this.plugin.setModule(m, true);
                    if (!ok)
                        return;
                }
                s.modules = s.modules.filter((x) => x.id !== m.id);
                s.profiles.forEach((p) => (p.modules = p.modules.filter((id) => id !== m.id)));
                await this.plugin.saveSettings();
                await this.render();
            }));
            row.nameEl.setText("");
        }
        /* Profiles */
        new obsidian_1.Setting(containerEl)
            .setName("Profiles")
            .setDesc("A profile remembers which modules are enabled. When applied, the other modules are unloaded.")
            .setHeading()
            .addButton((b) => b.setButtonText("Save current state").onClick(() => new NameModal(this.app, "Profile name", "", async (name) => {
            await this.plugin.saveProfileFromCurrent(name);
            await this.render();
        }).open()));
        for (const p of s.profiles) {
            const names = s.modules.filter((m) => p.modules.includes(m.id)).map((m) => m.name);
            new obsidian_1.Setting(containerEl)
                .setName(p.name)
                .setDesc(names.length ? names.join(", ") : "nothing enabled")
                .addButton((b) => b.setButtonText("Apply").onClick(() => this.plugin.applyProfile(p)))
                .addExtraButton((b) => b.setIcon("trash").setTooltip("Delete profile").onClick(async () => {
                s.profiles = s.profiles.filter((x) => x.id !== p.id);
                await this.plugin.saveSettings();
                await this.render();
            }));
        }
    }
}
