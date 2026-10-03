window.__ModuleLoader__.load({
	id: "dsh-prompt-forge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var __cache = new Map();
		var __modules = {
			"src/client/index.tsx": function (module, exports, require) {
			"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OptimizeButton = exports.SettingsSection = exports.InlinePanel = exports.acceptRefusal = exports.NS = exports.installLocale = exports.applyHostLocale = exports.tt = exports.draftRejection = exports.fetchModels = exports.runOptimize = exports.CONFIG_DEFAULTS = exports.bindSettings = exports.resolveConfig = exports.writeNeedsConfirm = exports.writeDraft = exports.readDraft = exports.composerFor = exports.inject = void 0;
exports.apply = apply;
const jsx_runtime_1 = __dshRequire("\u0000jsx-runtime");
/**
 * dsh-prompt-forge — browser half.
 *
 * Contributes exactly three things and nothing else:
 *   1. one compact button in the composer tool row (`conversation.input.left`);
 *   2. one settings page (`settings.section`);
 *   3. one inline optimizer panel inside the composer card
 *      (`conversation.input.overlay`), mounted only while that session has a
 *      panel open.
 *
 * The panel moved into the composer card in v2, out of the frame-wide overlay.
 * The slot's anchor is a zero-height, absolutely-positioned element inside the
 * card (`client.js:17172`), so a panel positioned against its top edge floats
 * above the composer without occupying layout: opening it never moves the
 * editor and never reflows the transcript. That anchoring is also why the panel
 * can be taller than the composer itself.
 *
 * The write-back path became simpler in the same move. A session-scope slot
 * occurrence is handed `inputActions` (including `setDraft`) as a standard prop,
 * so v1's `sessions.scope()` + `conversation.input.for()` resolution — which
 * could only ever be looked up defensively — is gone. The occurrence already
 * *is* the session, so there is no session to look up.
 *
 * Failure policy: every mount step is guarded. A plugin that throws out of
 * `apply` fails the whole web boot, so a broken surface here must degrade to a
 * missing button, never to a dead GUI.
 */
const react_1 = require("react");
const settings_ts_1 = __dshRequire("src/client/settings.ts");
const composer_ts_1 = __dshRequire("src/client/composer.ts");
const locales_ts_1 = __dshRequire("src/client/locales.ts");
const InlinePanel_tsx_1 = __dshRequire("src/client/InlinePanel.tsx");
Object.defineProperty(exports, "InlinePanel", { enumerable: true, get: function () { return InlinePanel_tsx_1.InlinePanel; } });
const OptimizeButton_tsx_1 = __dshRequire("src/client/OptimizeButton.tsx");
const SettingsSection_tsx_1 = __dshRequire("src/client/SettingsSection.tsx");
/** Services this plugin needs before it can mount anything. */
exports.inject = ['slots', 'locale', 'sessions', 'conversation'];
/** Settings page ordering within the Settings dialog's section list. */
const SETTINGS_ORDER = 62;
/** Composer tool-row ordering; after the shipped permission/plan controls. */
const BUTTON_ORDER = 20;
/**
 * Panel ordering inside the composer-card overlay slot.
 *
 * Deliberately 40, not 10: `dsh-context` registers its `context-modal` into
 * this same slot at order 10. Sharing a cell id would throw at registration and
 * take the GUI boot down with it, so this entry keeps a distinct id *and* a
 * distinct order behind the shipped one.
 */
const PANEL_ORDER = 40;
/**
 * Mount the composer button, the settings page, and the inline panel.
 * @param ctx - client root context (slots, locale, sessions, conversation).
 */
function apply(ctx) {
    ctx.effect(() => (0, locales_ts_1.installLocale)(ctx), 'dsh-prompt-forge: locale');
    const settings = (0, settings_ts_1.bindSettings)(ctx);
    ctx.effect(() => () => settings.dispose(), 'dsh-prompt-forge: settings handle');
    const slots = ctx.get('slots');
    if (slots === undefined || typeof slots.register !== 'function' || typeof slots.inject !== 'function') {
        console.warn('[dsh-prompt-forge] the slots service is unavailable; no surfaces were mounted');
        return;
    }
    /** Subscribe a component to the settings snapshot. */
    const useSettings = () => {
        const [snapshot, setSnapshot] = (0, react_1.useState)(() => settings.getSnapshot());
        (0, react_1.useEffect)(() => {
            setSnapshot(settings.getSnapshot());
            return settings.subscribe(() => { setSnapshot(settings.getSnapshot()); });
        }, []);
        return snapshot;
    };
    // --------------------------------------------------------- session-bucketed panels
    /**
     * One open panel per session, never one global singleton.
     *
     * The occurrence is already session-scoped, but the *state* still has to be
     * bucketed by session identity: a panel opened in one session must never be
     * handed a draft captured in another, and retiring one session's panel must
     * not touch another's.
     */
    const panels = new Map();
    /** Subscribers per session, so a change wakes only that session's panel. */
    const panelListeners = new Map();
    /** Global remount-key source; monotonic for the life of the plugin. */
    let panelKey = 0;
    /** Wake the subscribers of one session. */
    const notifyPanel = (sessionId) => {
        const listeners = panelListeners.get(sessionId);
        if (listeners === undefined)
            return;
        for (const listener of [...listeners])
            listener();
    };
    const panelStore = {
        /**
         * Record one open. A second open in the same session bumps the key, which
         * remounts the panel and thereby restarts its run from the newer draft.
         */
        open(sessionId, draft) {
            panels.set(sessionId, { draft, key: ++panelKey });
            notifyPanel(sessionId);
        },
        /** Retire one session's panel; the draft is untouched. */
        close(sessionId) {
            if (!panels.delete(sessionId))
                return;
            notifyPanel(sessionId);
        },
        /**
         * Drop one session's bucket without waking anyone.
         *
         * Called when the session's slot occurrence goes away — a session scope
         * disposal or an unmount. The panel component's own unmount cleanup aborts
         * whatever request it had in flight, so the bucket is the only state left
         * to release here.
         */
        forget(sessionId) {
            panels.delete(sessionId);
        },
    };
    // ------------------------------------------------------ inline panel occurrence
    /**
     * Render the panel for exactly one session.
     *
     * State is read in an effect rather than during the first render: the bucket
     * is plugin-owned mutable state, and reading it while rendering would make the
     * render impure. Session-scope entries remount on a session switch, so the
     * subscription below always describes the session this occurrence was mounted
     * for.
     *
     * `hasReferences` describes the **live** draft — the one Accept is about to
     * replace — not the draft captured at open time. A whole-draft `setDraft`
     * flattens reference chips into plain text, so the panel has to know whether
     * any are present *now*. It is computed by {@link writeNeedsConfirm}, the same
     * predicate the panel's confirm branch is built on, so the two can never
     * disagree about whether Accept has to ask first.
     */
    const PanelHost = (props) => {
        const { sessionId, useInput, inputActions } = props;
        const [current, setCurrent] = (0, react_1.useState)(() => panels.get(sessionId));
        (0, react_1.useEffect)(() => {
            // Re-sync on mount and on every change of this session's bucket. The
            // `undefined` seed above is only ever visible for the first frame of a
            // panel that was opened in a previous session — never for one opened in
            // this one, because the button's `open` runs before this entry re-renders.
            const listener = () => { setCurrent(panels.get(sessionId)); };
            let listeners = panelListeners.get(sessionId);
            if (listeners === undefined) {
                listeners = new Set();
                panelListeners.set(sessionId, listeners);
            }
            listeners.add(listener);
            listener();
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0)
                    panelListeners.delete(sessionId);
                // Scope disposal or unmount releases this session's bucket. The panel
                // component's own unmount cleanup aborts any request it had in flight.
                panelStore.forget(sessionId);
            };
        }, [sessionId]);
        // The same predicate the panel uses to decide whether Accept must ask first,
        // read from the LIVE input state: the draft Accept is about to replace is the
        // current one, not the draft frozen at open time.
        const hasReferences = useInput(state => (0, composer_ts_1.writeNeedsConfirm)(state.occurrences.length, state.attachmentIds.length)) === true;
        // Subscribed, not a one-shot read: the panel's preset roster and model
        // label must follow a settings change while it is still open.
        const config = useSettings().value;
        if (current === undefined)
            return null;
        /**
         * Write the accepted text back, reporting whether it landed.
         *
         * The draft must not be touched when this panel is no longer the live one
         * for the session, and the caller must not close as if the accept had
         * worked: the boolean is the whole contract between this host and the panel.
         *
         * Three refusal cases, not two. `setDraft` throwing is the documented one
         * (the session stopped being writable). The third is subtle and is why the
         * comparison below is on the bucket *identity* rather than the session id: a
         * re-open in the same session (`key++`) leaves the previous panel's
         * `onWrite` closure alive and callable, and that orphan would otherwise
         * write text the user never accepted, from a panel that is no longer on
         * screen.
         * @returns whether the draft was actually replaced.
         */
        const write = (text) => {
            if (panels.get(sessionId) !== current) {
                // Retired between render and click: closed, or re-opened under a new
                // key. Writing now would land text this panel no longer owns.
                console.warn('[dsh-prompt-forge] the panel was replaced before its write landed');
                return false;
            }
            try {
                inputActions.setDraft(text);
            }
            catch (error) {
                // A session that stopped being writable refuses here; the panel stays
                // expanded and reports it.
                console.warn('[dsh-prompt-forge] the composer refused the accepted draft:', error);
                return false;
            }
            return true;
        };
        return ((0, jsx_runtime_1.jsx)(InlinePanel_tsx_1.InlinePanel, { original: current.draft, config: config, sessionId: sessionId, onWrite: write, onClose: () => { panelStore.close(sessionId); }, hasReferences: hasReferences }, current.key));
    };
    /**
     * Guarded slot entry point.
     *
     * The standard kit always supplies the three props below for a session-scope
     * entry, but a composition that mounted this entry without a session binding —
     * or a check that renders it with no props at all — must render nothing rather
     * than throw. The guard is a single hook-free branch, so it cannot disturb the
     * hook order inside {@link PanelHost}.
     */
    const OverlayHost = (props) => {
        if (props.sessionId === undefined || props.inputActions === undefined || typeof props.useInput !== 'function')
            return null;
        return (0, jsx_runtime_1.jsx)(PanelHost, { sessionId: props.sessionId, useInput: props.useInput, inputActions: props.inputActions });
    };
    // -------------------------------------------------- composer tool-row button
    const ComposerButton = (props) => {
        const snapshot = useSettings();
        const open = (0, react_1.useCallback)((draft) => {
            panelStore.open(props.sessionId, draft);
        }, [props.sessionId]);
        return ((0, jsx_runtime_1.jsx)(OptimizeButton_tsx_1.OptimizeButton, { sessionId: props.sessionId, useInput: props.useInput, enabled: snapshot.value.enabled && snapshot.status !== 'unavailable', onOpen: open }));
    };
    // ------------------------------------------------------------- settings page
    const SettingsPage = (props) => ((0, jsx_runtime_1.jsx)(SettingsSection_tsx_1.SettingsSection, { close: props.close, settings: settings }));
    // ------------------------------------------------------------------- wiring
    try {
        slots.inject('conversation.input.left', () => slots.register({ name: 'conversation.input.left', id: 'prompt-forge', order: BUTTON_ORDER, label: () => (0, locales_ts_1.tt)('button.label') }, ComposerButton));
        slots.inject('settings.section', () => slots.register({ name: 'settings.section', id: 'prompt-forge', order: SETTINGS_ORDER, label: () => (0, locales_ts_1.tt)('settings.title') }, SettingsPage));
        slots.inject('conversation.input.overlay', () => slots.register({ name: 'conversation.input.overlay', id: 'prompt-forge', order: PANEL_ORDER, label: () => (0, locales_ts_1.tt)('dialog.title') }, OverlayHost));
    }
    catch (error) {
        // A slot collision or a missing declaration must not take the GUI down.
        console.warn('[dsh-prompt-forge] surface registration failed:', error);
    }
}
// Re-exported so a smoke check can drive the pure helpers without the GUI.
var composer_ts_2 = __dshRequire("src/client/composer.ts");
Object.defineProperty(exports, "composerFor", { enumerable: true, get: function () { return composer_ts_2.composerFor; } });
Object.defineProperty(exports, "readDraft", { enumerable: true, get: function () { return composer_ts_2.readDraft; } });
Object.defineProperty(exports, "writeDraft", { enumerable: true, get: function () { return composer_ts_2.writeDraft; } });
Object.defineProperty(exports, "writeNeedsConfirm", { enumerable: true, get: function () { return composer_ts_2.writeNeedsConfirm; } });
var settings_ts_2 = __dshRequire("src/client/settings.ts");
Object.defineProperty(exports, "resolveConfig", { enumerable: true, get: function () { return settings_ts_2.resolveConfig; } });
Object.defineProperty(exports, "bindSettings", { enumerable: true, get: function () { return settings_ts_2.bindSettings; } });
Object.defineProperty(exports, "CONFIG_DEFAULTS", { enumerable: true, get: function () { return settings_ts_2.CONFIG_DEFAULTS; } });
var api_ts_1 = __dshRequire("src/client/api.ts");
Object.defineProperty(exports, "runOptimize", { enumerable: true, get: function () { return api_ts_1.runOptimize; } });
Object.defineProperty(exports, "fetchModels", { enumerable: true, get: function () { return api_ts_1.fetchModels; } });
Object.defineProperty(exports, "draftRejection", { enumerable: true, get: function () { return api_ts_1.draftRejection; } });
var locales_ts_2 = __dshRequire("src/client/locales.ts");
Object.defineProperty(exports, "tt", { enumerable: true, get: function () { return locales_ts_2.tt; } });
Object.defineProperty(exports, "applyHostLocale", { enumerable: true, get: function () { return locales_ts_2.applyHostLocale; } });
Object.defineProperty(exports, "installLocale", { enumerable: true, get: function () { return locales_ts_2.installLocale; } });
Object.defineProperty(exports, "NS", { enumerable: true, get: function () { return locales_ts_2.NS; } });
// The accept gate and the panel are exported for the render check to drive
// directly: the overlay path that reaches them in production cannot be driven
// from outside the module.
var accept_guard_ts_1 = __dshRequire("src/client/accept-guard.ts");
Object.defineProperty(exports, "acceptRefusal", { enumerable: true, get: function () { return accept_guard_ts_1.acceptRefusal; } });
var SettingsSection_tsx_2 = __dshRequire("src/client/SettingsSection.tsx");
Object.defineProperty(exports, "SettingsSection", { enumerable: true, get: function () { return SettingsSection_tsx_2.SettingsSection; } });
var OptimizeButton_tsx_2 = __dshRequire("src/client/OptimizeButton.tsx");
Object.defineProperty(exports, "OptimizeButton", { enumerable: true, get: function () { return OptimizeButton_tsx_2.OptimizeButton; } });

			},
			"\u0000jsx-runtime": function (module, exports, require) {
			"use strict";
const React = require("react");
function jsx(type, props, key) {
  if (key === undefined) return React.createElement(type, props);
  return React.createElement(type, Object.assign({}, props, { key: key }));
}
exports.jsx = jsx;
exports.jsxs = jsx;
exports.Fragment = React.Fragment;
			},
			"src/client/settings.ts": function (module, exports, require) {
			"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFIG_DEFAULTS = void 0;
exports.resolveConfig = resolveConfig;
exports.asConfigForms = asConfigForms;
exports.bindSettings = bindSettings;
const dsh_client_store_1 = require("@deepseek-ai/dsh-client-store");
const protocol_ts_1 = __dshRequire("src/protocol.ts");
const prompts_ts_1 = __dshRequire("src/prompts.ts");
/** Defaults mirroring the host schema, so a disconnected UI still renders. */
exports.CONFIG_DEFAULTS = {
    enabled: true,
    provider: 'ofox',
    model: 'deepseek/deepseek-v4.1-flash',
    temperature: 0.3,
    maxTokens: 0,
    mainSystemPrompt: '',
    presets: prompts_ts_1.BUILTIN_PRESETS,
    activePresetId: '',
};
/**
 * Merge a stored section over the defaults.
 * @param stored - the namespace section as the host reported it.
 * @returns a complete config value.
 */
function resolveConfig(stored) {
    const value = stored ?? {};
    const presets = Array.isArray(value.presets) && value.presets.length > 0
        ? value.presets
            .filter(preset => typeof preset?.id === 'string' && preset.id !== '')
            .map(preset => ({
            id: preset.id,
            name: typeof preset.name === 'string' && preset.name.trim() !== '' ? preset.name : preset.id,
            system: typeof preset.system === 'string' ? preset.system : '',
        }))
        : exports.CONFIG_DEFAULTS.presets;
    return {
        enabled: value.enabled !== false,
        provider: typeof value.provider === 'string' ? value.provider : exports.CONFIG_DEFAULTS.provider,
        model: typeof value.model === 'string' ? value.model : exports.CONFIG_DEFAULTS.model,
        temperature: typeof value.temperature === 'number' && Number.isFinite(value.temperature)
            ? value.temperature
            : exports.CONFIG_DEFAULTS.temperature,
        maxTokens: typeof value.maxTokens === 'number' && Number.isFinite(value.maxTokens) ? value.maxTokens : 0,
        mainSystemPrompt: typeof value.mainSystemPrompt === 'string' ? value.mainSystemPrompt : '',
        presets,
        activePresetId: typeof value.activePresetId === 'string' ? value.activePresetId : '',
    };
}
/** Narrow an unknown service handle to the config-forms surface. */
function asConfigForms(value) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const candidate = value;
    if (typeof candidate.get !== 'function' || typeof candidate.describe !== 'function')
        return undefined;
    return candidate;
}
/**
 * Bind the plugin's settings.
 *
 * Preference order: the official shared form (works with live reload and the
 * host's own write queue), then a direct `remote.settings` view, then defaults.
 * The fallback is deliberately last-resort: it renders a working page in a
 * composition that replaced the settings provider, at the cost of no live
 * invalidation.
 * @param ctx - client root context.
 * @returns the bound handle.
 */
function bindSettings(ctx) {
    const store = (0, dsh_client_store_1.createSnapshotStore)({
        status: 'loading',
        value: exports.CONFIG_DEFAULTS,
        revision: undefined,
        writable: false,
        transport: 'defaults',
    });
    const forms = asConfigForms(ctx.get('configForms'));
    const disposers = [];
    let disposed = false;
    let boundEntryId;
    /** Publish one accepted section. */
    const accept = (transport, status, stored, revision, writable) => {
        if (disposed)
            return;
        store.set({
            status,
            value: resolveConfig(stored),
            revision,
            writable,
            transport,
        });
    };
    if (forms !== undefined) {
        const describeFace = forms.describe();
        /**
         * Resolve (and cache) the namespace this plugin's settings live under.
         *
         * The managed-forms host keys sections by the Loader entry id, which is not
         * simply the package name: a cordis `insert` row lands under
         * `include:<rowId>`, so the row in cordis.patch.yml produces the namespace
         * `include:prompt-forge` while the row's own id stays `prompt-forge`.
         * The resolution below therefore tries the exact declared id first, then the
         * row-id suffix, and finally a fingerprint of the Config's own field names.
         * Getting this wrong would show an empty page and silently drop every write,
         * so all three checks run in order of how directly they identify the plugin.
         */
        const entryIdOf = () => {
            if (boundEntryId !== undefined)
                return boundEntryId;
            const namespaces = describeFace.getSnapshot().view?.namespaces ?? [];
            const exact = namespaces.find(row => row.ns === protocol_ts_1.PROMPT_FORGE_NAMESPACE);
            if (exact !== undefined) {
                boundEntryId = exact.ns;
                return boundEntryId;
            }
            // The `include:`/`<any-prefix>:` form the loader gives an inserted row.
            const suffix = namespaces.find(row => row.ns.endsWith(`:${protocol_ts_1.PROMPT_FORGE_NAMESPACE}`));
            if (suffix !== undefined) {
                boundEntryId = suffix.ns;
                console.info(`[dsh-prompt-forge] settings namespace resolved by row-id suffix: "${suffix.ns}"`);
                return boundEntryId;
            }
            // Last resort: recognize the section by fields only this Config declares.
            const shapeOf = (schema) => JSON.stringify(schema ?? null);
            const fingerprint = namespaces.find(row => protocol_ts_1.CONFIG_FINGERPRINT_FIELDS.every(field => shapeOf(row.schema).includes(`"${field}"`)));
            if (fingerprint !== undefined) {
                boundEntryId = fingerprint.ns;
                console.info(`[dsh-prompt-forge] settings namespace resolved by fingerprint: "${fingerprint.ns}"`);
            }
            return boundEntryId;
        };
        const form = () => {
            const entryId = entryIdOf();
            return entryId === undefined ? undefined : forms.get(entryId);
        };
        /** Fold the shared form's current answer into the snapshot. */
        const sync = () => {
            const current = form();
            if (current === undefined)
                return;
            const snapshot = current.getSnapshot();
            if (snapshot.status === 'loading') {
                // A pending read must not wipe the values already on screen.
                store.update(draft => {
                    draft.status = 'loading';
                    draft.revision = snapshot.revision;
                    draft.writable = snapshot.writable;
                    draft.transport = 'configForms';
                });
                return;
            }
            accept('configForms', snapshot.status, snapshot.value, snapshot.revision, snapshot.writable);
        };
        void describeFace.ensure().then(() => {
            if (disposed)
                return;
            const current = form();
            if (current === undefined) {
                // The host does not serve this namespace (plugin disabled at the
                // profile level, or a settings provider without it). Defaults stay.
                accept('defaults', 'ready', undefined, undefined, false);
                return;
            }
            disposers.push(current.subscribe(sync));
            disposers.push(describeFace.subscribe(sync));
            sync();
        }).catch(() => {
            accept('defaults', 'unavailable', undefined, undefined, false);
        });
        return {
            getSnapshot: () => store.getSnapshot(),
            subscribe: listener => store.subscribe(listener),
            apply: async (ops) => {
                const current = form();
                if (current === undefined)
                    return false;
                try {
                    return await current.mutate(ops, store.getSnapshot().revision);
                }
                catch {
                    sync();
                    return false;
                }
            },
            reload: async () => {
                try {
                    await describeFace.ensure();
                    sync();
                }
                catch {
                    accept('defaults', 'unavailable', undefined, undefined, false);
                }
            },
            dispose: () => {
                disposed = true;
                for (const dispose of disposers.splice(0))
                    dispose();
            },
        };
    }
    // No official settings provider: report defaults instead of inventing a wire.
    accept('defaults', 'unavailable', undefined, undefined, false);
    return {
        getSnapshot: () => store.getSnapshot(),
        subscribe: listener => store.subscribe(listener),
        apply: async () => false,
        reload: async () => { },
        dispose: () => { disposed = true; },
    };
}

			},
			"src/client/composer.ts": function (module, exports, require) {
			"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.composerFor = composerFor;
exports.readDraft = readDraft;
exports.writeDraft = writeDraft;
exports.writeNeedsConfirm = writeNeedsConfirm;
/**
 * Resolve the composer facade for one session.
 *
 * @param ctx - client root context.
 * @param sessionId - the session whose composer is addressed.
 * @returns the composer facade, or undefined when this session has none.
 */
function composerFor(ctx, sessionId) {
    const conversation = ctx.get('conversation');
    if (conversation === undefined || typeof conversation.input?.for !== 'function')
        return undefined;
    const sessions = ctx.get('sessions');
    if (sessions === undefined || typeof sessions.scope !== 'function')
        return undefined;
    let scope;
    try {
        scope = sessions.scope(sessionId);
    }
    catch {
        return undefined;
    }
    // `for()` refuses an absent scope, so short-circuit before calling it.
    if (scope === undefined || scope === null)
        return undefined;
    try {
        return conversation.input.for(scope);
    }
    catch {
        // "requires a retained Session scope" is the expected refusal for a session
        // that stopped being retained between open and accept.
        return undefined;
    }
}
/**
 * Read the current draft of one composer.
 * @param input - the composer facade.
 * @returns the draft text, or an empty string when unreadable.
 */
function readDraft(input) {
    try {
        const draft = input.state.getSnapshot().draft;
        return typeof draft === 'string' ? draft : '';
    }
    catch {
        return '';
    }
}
/**
 * Write accepted text into one composer and return focus to it.
 *
 * The caller is responsible for having already confirmed the composer exists;
 * this returns whether the write landed so a failed accept can be reported
 * instead of appearing to succeed.
 * @param input - the composer facade.
 * @param text - the accepted prompt.
 * @returns whether the draft was replaced.
 */
function writeDraft(input, text) {
    try {
        input.setDraft(text);
    }
    catch {
        return false;
    }
    // Focus is best-effort: the text is already in place, and a shell without the
    // verb should not turn a successful accept into a failure.
    try {
        input.focus?.();
    }
    catch {
        // Ignored on purpose.
    }
    return true;
}
/**
 * Whether replacing the whole draft would damage structured content in it.
 *
 * `setDraft` clears the editor document and rewrites it as plain text, so every
 * `@` reference chip degrades to its clipboard projection and any draft
 * attachment is left without matching text. Neither leaves a separate undo
 * step. When this returns true the panel must ask before writing, rather than
 * silently flattening the user's draft.
 *
 * Non-finite counts are treated as absent: a `NaN` from an upstream projection
 * must not be read as "has references" and nag the user on every accept.
 * @param occurrences - the number of `@` reference chips in the live draft.
 * @param attachmentIds - the number of attachment drafts in the live draft.
 * @returns whether the write needs a confirmation step.
 */
function writeNeedsConfirm(occurrences, attachmentIds) {
    const references = Number.isFinite(occurrences) && occurrences > 0;
    const attachments = Number.isFinite(attachmentIds) && attachmentIds > 0;
    return references || attachments;
}

			},
			"src/client/locales.ts": function (module, exports, require) {
			"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.en = exports.zh = exports.NS = void 0;
exports.tt = tt;
exports.applyHostLocale = applyHostLocale;
exports.installLocale = installLocale;
/** Locale namespace this plugin owns. */
exports.NS = 'dsh-prompt-forge';
/** Chinese copy (also the built-in fallback). */
exports.zh = {
    'button.label': '优化',
    'button.tooltip': '优化输入框里的提示词',
    'button.disabledEmpty': '输入框是空的，先写点内容',
    'button.disabledOff': '提示词优化插件已关闭（设置 → 提示词优化）',
    'dialog.title': '提示词优化',
    'dialog.optimized': '优化版',
    'dialog.accept': '采纳',
    'dialog.acceptFailed': '没能写入输入框：该会话已不可写。内容仍在这里，请手动复制。',
    'dialog.copy': '复制',
    'dialog.copied': '已复制',
    'dialog.refinePlaceholder': '再说一句要求，例如：再短一点 / 补上输出格式 / 强调不要改动既有行为',
    'dialog.refine': '继续微调',
    'dialog.preset': '预设',
    'dialog.mainPreset': '主提示词',
    'dialog.thinking': '正在优化…',
    'dialog.empty': '（等待模型输出）',
    'dialog.edited': '已手动编辑',
    'dialog.noModel': '未配置模型（设置 → 提示词优化）',
    'dialog.tooLong': '草稿过长，已超过上限',
    // Inline panel (v2). There is deliberately no shortcut hint anywhere: the
    // panel binds no key at all, because the shipped composer already claims
    // Ctrl/Cmd+Enter for "deliver now" (client.js:16704-16716).
    'panel.close': '关闭面板',
    'panel.stop': '停止',
    'panel.retry': '重新优化',
    'panel.showOriginal': '查看原文',
    'panel.hideOriginal': '收起原文',
    'panel.confirmTitle': '采纳将替换整段草稿',
    'panel.confirmBody': '当前草稿含 @引用或附件。整替写入会把这些引用降级为纯文本、附件也会失去对应文本，且不产生独立的撤销步骤。',
    'panel.confirmOk': '仍然采纳',
    'panel.confirmCancel': '取消',
    'panel.statusRefs': '含引用，采纳前会先确认',
    'panel.regionLabel': '提示词优化面板',
    'settings.title': '提示词优化',
    'settings.description': '在输入框旁加一个按钮，用你配置的模型渠道把草稿改写成更清晰的提示词。只有点击「采纳」才会写回输入框。',
    'settings.enabled': '启用插件',
    'settings.enabledHint': '关闭后按钮不再出现，优化请求也会被拒绝',
    'settings.channel': '渠道',
    'settings.model': '模型',
    'settings.temperature': '温度',
    'settings.temperatureHint': '越低越稳，建议 0.3；调高会更发散',
    'settings.maxTokens': '输出上限 token',
    'settings.maxTokensHint': '0 表示用模型默认值',
    'settings.catalogLoad': '读取渠道与模型…',
    'settings.catalogFailed': '读取模型列表失败',
    'settings.catalogRetry': '重新读取',
    'settings.noProviders': '宿主没有报告任何可用渠道',
    'settings.noModels': '该渠道没有可选模型',
    'settings.scopeLoading': '正在读取设置…',
    'settings.scopeUnavailable': '设置不可用：当前页面连不上宿主设置文档，插件将使用默认值',
    'settings.mainPrompt': '主提示词',
    'settings.mainPromptHint': '没有选中预设时使用这一段',
    'settings.resetMain': '恢复默认',
    'settings.presets': '预设',
    'settings.presetsHint': '多套提示词，可在弹窗里切换',
    'settings.presetName': '名称',
    'settings.presetSystem': '系统提示词',
    'settings.addPreset': '新增预设',
    'settings.removePreset': '删除',
    'settings.activePreset': '默认使用的预设',
    'settings.noPreset': '（使用主提示词）',
    'settings.save': '保存',
    'settings.saved': '已保存',
    'settings.saveFailed': '保存失败',
    'settings.writable': '只读：当前设置文档不接受写入',
};
/** English copy. */
exports.en = {
    'button.label': 'Optimize',
    'button.tooltip': 'Rewrite the composer draft into a clearer prompt',
    'button.disabledEmpty': 'The composer is empty — write something first',
    'button.disabledOff': 'Prompt optimizer is disabled (Settings → Prompt Optimizer)',
    'dialog.title': 'Prompt optimizer',
    'dialog.optimized': 'Optimized',
    'dialog.accept': 'Accept',
    'dialog.acceptFailed': 'Could not write to the composer: this session is no longer writable. The text is still here, copy it manually.',
    'dialog.copy': 'Copy',
    'dialog.copied': 'Copied',
    'dialog.refinePlaceholder': 'Add one more requirement, e.g. shorter / specify the output format',
    'dialog.refine': 'Refine',
    'dialog.preset': 'Preset',
    'dialog.mainPreset': 'Main prompt',
    'dialog.thinking': 'Optimizing…',
    'dialog.empty': '(waiting for the model)',
    'dialog.edited': 'manually edited',
    'dialog.noModel': 'No model configured (Settings → Prompt Optimizer)',
    'dialog.tooLong': 'The draft exceeds the length limit',
    'panel.close': 'Close panel',
    'panel.stop': 'Stop',
    'panel.retry': 'Run again',
    'panel.showOriginal': 'Show original',
    'panel.hideOriginal': 'Hide original',
    'panel.confirmTitle': 'Accept replaces the whole draft',
    'panel.confirmBody': 'This draft contains @ references or attachments. Replacing it will flatten those references into plain text, leave attachments without matching text, and create no separate undo step.',
    'panel.confirmOk': 'Accept anyway',
    'panel.confirmCancel': 'Cancel',
    'panel.statusRefs': 'Contains references; you will be asked first',
    'panel.regionLabel': 'Prompt optimizer panel',
    'settings.title': 'Prompt optimizer',
    'settings.description': 'Adds a button beside the composer that rewrites your draft through a configured model channel. The draft is replaced only when you press Accept.',
    'settings.enabled': 'Enable plugin',
    'settings.enabledHint': 'When off, the button disappears and optimize requests are refused',
    'settings.channel': 'Channel',
    'settings.model': 'Model',
    'settings.temperature': 'Temperature',
    'settings.temperatureHint': 'Lower is steadier; 0.3 is recommended',
    'settings.maxTokens': 'Output token limit',
    'settings.maxTokensHint': '0 uses the model default',
    'settings.catalogLoad': 'Reading channels and models…',
    'settings.catalogFailed': 'Could not read the model list',
    'settings.catalogRetry': 'Retry',
    'settings.noProviders': 'The host reported no usable channel',
    'settings.noModels': 'This channel offers no selectable model',
    'settings.scopeLoading': 'Reading settings…',
    'settings.scopeUnavailable': 'Settings unavailable: this page cannot reach the host settings document, so defaults apply',
    'settings.mainPrompt': 'Main prompt',
    'settings.mainPromptHint': 'Used when no preset is selected',
    'settings.resetMain': 'Restore default',
    'settings.presets': 'Presets',
    'settings.presetsHint': 'Several prompts, switchable from the dialog',
    'settings.presetName': 'Name',
    'settings.presetSystem': 'System prompt',
    'settings.addPreset': 'Add preset',
    'settings.removePreset': 'Remove',
    'settings.activePreset': 'Preset used by default',
    'settings.noPreset': '(use the main prompt)',
    'settings.save': 'Save',
    'settings.saved': 'Saved',
    'settings.saveFailed': 'Save failed',
    'settings.writable': 'Read-only: the settings document refuses writes',
};
/** Active dictionary, swapped by {@link applyHostLocale}. */
let active = exports.zh;
/** Interpolate `{name}` params into one string. */
function interpolate(text, params) {
    if (params === undefined)
        return text;
    return text.replace(/\{(\w+)\}/g, (match, name) => {
        const value = params[name];
        return value === undefined ? match : String(value);
    });
}
/** Translate one key from the active dictionary. */
function tt(key, params) {
    return interpolate(active[key] ?? exports.zh[key] ?? key, params);
}
/** Switch the active dictionary; `zh` is the fallback for unknown languages. */
function applyHostLocale(locale) {
    active = locale !== undefined && locale.toLowerCase().startsWith('en') ? exports.en : exports.zh;
}
/**
 * Register the dictionaries and follow the host language.
 *
 * Every step degrades silently: a composition without the locale plugin must
 * keep working, and a duplicate registration must not take the GUI down.
 * @param ctx - client root context.
 * @returns a disposer releasing the locale subscription.
 */
function installLocale(ctx) {
    const disposers = [];
    const locale = ctx.get('locale');
    if (locale === undefined) {
        applyHostLocale(undefined);
        return () => { };
    }
    try {
        const dispose = locale.register?.(exports.NS, { zh: { ...exports.zh }, en: { ...exports.en } });
        if (typeof dispose === 'function')
            disposers.push(dispose);
    }
    catch (error) {
        // A duplicate namespace registration is a composition fact, not a failure.
        console.warn('[dsh-prompt-forge] locale dictionary not registered:', error);
    }
    const sync = () => {
        try {
            applyHostLocale(locale.getLocale?.().active);
        }
        catch {
            applyHostLocale(undefined);
        }
    };
    sync();
    try {
        const dispose = locale.subscribe?.(sync);
        if (typeof dispose === 'function')
            disposers.push(dispose);
    }
    catch {
        // A locale service without subscribe is still usable for the initial read.
    }
    return () => { for (const dispose of disposers.splice(0))
        dispose(); };
}

			},
			"src/client/InlinePanel.tsx": function (module, exports, require) {
			"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InlinePanel = InlinePanel;
const jsx_runtime_1 = __dshRequire("\u0000jsx-runtime");
/**
 * The inline optimization panel.
 *
 * This is the v2 surface: instead of a frame-wide modal, one panel is mounted
 * inside the composer card (slot `conversation.input.overlay`) and floats just
 * above the composer's top edge. It occupies **no** layout: the anchor is a
 * zero-height absolutely-positioned element and the panel is positioned against
 * it, so opening and closing the panel never moves the composer, never reflows
 * the transcript, and leaves the editor exactly where the user left it.
 *
 * The write-back contract is unchanged from v1 and is still the point of this
 * component: the composer is only ever touched by Accept. Closing, stopping,
 * retrying, or refining leaves the draft exactly as the user left it.
 *
 * Deliberate v2 change — no keyboard shortcuts at all. v1 bound Escape and
 * Ctrl+Enter on `document` in the capture phase. Inline, that collides with the
 * shipped composer: the official Lexical keymap treats Ctrl/Cmd+Enter as
 * "deliver now" and submits (`client.js:16704-16716`), and the panel's own
 * handler did not stop propagation, so both would fire — the panel would accept
 * *and* the composer would send. Every action here is a visible button instead.
 * The only Enter key this component reacts to is the one inside its own refine
 * input, which is that input's own submit key and not a global shortcut.
 */
const react_1 = require("react");
const api_ts_1 = __dshRequire("src/client/api.ts");
const locales_ts_1 = __dshRequire("src/client/locales.ts");
const prompts_ts_1 = __dshRequire("src/prompts.ts");
// The mid-stream accept gate lives in its own module so the retired modal and
// this panel cannot drift apart: one predicate, used by both the button's
// disabled state and the accept handler, so the two can never disagree about
// whether writing back is allowed.
const accept_guard_ts_1 = __dshRequire("src/client/accept-guard.ts");
/**
 * Render the inline optimization panel.
 * @param props - the captured draft, config, and callbacks.
 * @returns the panel element tree.
 */
function InlinePanel(props) {
    const { original, config, onWrite, onClose, hasReferences } = props;
    const [run, setRun] = (0, react_1.useState)({ phase: 'running', text: '', edited: false, error: undefined });
    const [instruction, setInstruction] = (0, react_1.useState)('');
    const [presetId, setPresetId] = (0, react_1.useState)(config.activePresetId);
    const [copied, setCopied] = (0, react_1.useState)(false);
    const [confirming, setConfirming] = (0, react_1.useState)(false);
    const [showOriginal, setShowOriginal] = (0, react_1.useState)(false);
    const abortRef = (0, react_1.useRef)(undefined);
    /** The system prompt for the currently selected preset. */
    const system = (0, react_1.useMemo)(() => (0, prompts_ts_1.resolveSystemPrompt)(config.presets.find(candidate => candidate.id === presetId)?.system, config.mainSystemPrompt), [config.presets, config.mainSystemPrompt, presetId]);
    /**
     * Latest resolved system prompt, read without changing `start`'s identity.
     *
     * The panel must re-run when the *user* switches preset, and must not re-run
     * merely because plugin settings finished loading. Both events change the
     * resolved prompt string, so the effect below keys on the preset id and reads
     * the prompt through this ref instead.
     */
    const systemRef = (0, react_1.useRef)(system);
    systemRef.current = system;
    /** Run one pass; `previous` and `directive` are set only for a refine. */
    const start = (0, react_1.useCallback)((previous, directive) => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setConfirming(false);
        setRun(current => ({ phase: 'running', text: previous, edited: current.edited, error: undefined }));
        void (0, api_ts_1.runOptimize)({
            text: original,
            system: systemRef.current,
            ...previous === '' ? {} : { previous },
            ...directive === '' ? {} : { instruction: directive },
            signal: controller.signal,
        }, delta => { setRun(current => ({ ...current, text: current.text + delta })); }).then(outcome => {
            if (controller.signal.aborted && outcome.kind !== 'error') {
                setRun(current => ({ ...current, phase: 'settled' }));
                return;
            }
            if (outcome.kind === 'error') {
                setRun(current => ({ ...current, phase: 'settled', error: outcome.message }));
                return;
            }
            setRun({ phase: 'settled', text: outcome.text === '' ? previous : outcome.text, edited: false, error: undefined });
        });
    }, [original]);
    // First run on mount, and a re-run when the user switches preset. Keyed on
    // `presetId` rather than the resolved prompt: settings arriving late
    // (loading → ready) also changes the resolved prompt, and re-running for that
    // would spend a second model call the user never asked for. Unmount aborts
    // whatever run is in flight.
    (0, react_1.useEffect)(() => {
        start('', '');
        return () => { abortRef.current?.abort(); };
    }, [start, presetId]);
    const busy = run.phase === 'running';
    /** Whether the pane holds anything worth copying — true mid-stream too. */
    const hasText = run.text.trim() !== '';
    /** Accept is stricter: a running pass would write back a prefix, not an answer. */
    const canAccept = (0, accept_guard_ts_1.acceptRefusal)(run.phase, run.text) === undefined;
    const modelLabel = config.provider !== '' && config.model !== ''
        ? `${config.provider} / ${config.model}`
        : (0, locales_ts_1.tt)('dialog.noModel');
    /**
     * Commit the result to the composer — the only path that touches the draft.
     *
     * The write is guarded by the same predicate the Accept button's disabled
     * state uses, and a refused write keeps the panel expanded with a visible
     * reason instead of collapsing as if it had worked.
     */
    function commit() {
        if ((0, accept_guard_ts_1.acceptRefusal)(run.phase, run.text) !== undefined)
            return;
        if (!onWrite(run.text.trim())) {
            setRun(current => ({ ...current, error: (0, locales_ts_1.tt)('dialog.acceptFailed') }));
            return;
        }
        onClose();
    }
    /** Accept: ask first when the draft carries references or attachments. */
    function accept() {
        if ((0, accept_guard_ts_1.acceptRefusal)(run.phase, run.text) !== undefined)
            return;
        if (hasReferences) {
            setConfirming(true);
            return;
        }
        commit();
    }
    /**
     * Collapse the panel, aborting any run first.
     *
     * The unmount cleanup would abort anyway, but stopping the upstream call
     * *before* handing control back keeps the contract literal: the moment the
     * panel is asked to close, no model call of its is still burning.
     */
    function close() {
        abortRef.current?.abort();
        onClose();
    }
    /** Copy the current result to the clipboard. */
    async function copy() {
        try {
            await navigator.clipboard.writeText(run.text);
            setCopied(true);
            window.setTimeout(() => { setCopied(false); }, 1600);
        }
        catch {
            // Clipboard permission is a browser policy, not a plugin failure.
            setCopied(false);
        }
    }
    return ((0, jsx_runtime_1.jsxs)("div", { className: inline_module_css_1.default.panel, role: "region", "aria-label": (0, locales_ts_1.tt)('panel.regionLabel'), "data-session": String(props.sessionId), children: [(0, jsx_runtime_1.jsxs)("header", { className: inline_module_css_1.default.head, children: [(0, jsx_runtime_1.jsx)("span", { className: inline_module_css_1.default.title, children: (0, locales_ts_1.tt)('dialog.title') }), (0, jsx_runtime_1.jsx)("span", { className: inline_module_css_1.default.model, title: modelLabel, children: modelLabel }), (0, jsx_runtime_1.jsxs)("div", { className: inline_module_css_1.default.headRight, children: [(0, jsx_runtime_1.jsxs)("select", { className: inline_module_css_1.default.select, value: presetId, disabled: busy, "aria-label": (0, locales_ts_1.tt)('dialog.preset'), onChange: event => { setPresetId(event.target.value); }, children: [(0, jsx_runtime_1.jsx)("option", { value: "", children: (0, locales_ts_1.tt)('dialog.mainPreset') }), config.presets.map(preset => ((0, jsx_runtime_1.jsx)("option", { value: preset.id, children: preset.name }, preset.id)))] }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: inline_module_css_1.default.iconButton, "aria-label": (0, locales_ts_1.tt)('panel.close'), title: (0, locales_ts_1.tt)('panel.close'), onClick: close, children: "\u2715" })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: inline_module_css_1.default.body, children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", className: inline_module_css_1.default.fold, onClick: () => { setShowOriginal(current => !current); }, children: [showOriginal ? '▾ ' : '▸ ', showOriginal ? (0, locales_ts_1.tt)('panel.hideOriginal') : (0, locales_ts_1.tt)('panel.showOriginal'), "\uFF08", original.length, "\uFF09"] }), showOriginal ? (0, jsx_runtime_1.jsx)("div", { className: inline_module_css_1.default.originalBox, children: original }) : null, (0, jsx_runtime_1.jsxs)("div", { className: inline_module_css_1.default.paneHead, children: [(0, jsx_runtime_1.jsx)("span", { className: inline_module_css_1.default.paneTitle, children: (0, locales_ts_1.tt)('dialog.optimized') }), (0, jsx_runtime_1.jsxs)("span", { className: inline_module_css_1.default.counter, children: [run.text.length, run.edited ? ` · ${(0, locales_ts_1.tt)('dialog.edited')}` : ''] })] }), (0, jsx_runtime_1.jsx)("textarea", { className: inline_module_css_1.default.resultBox, value: run.text, spellCheck: false, readOnly: busy, placeholder: busy ? (0, locales_ts_1.tt)('dialog.thinking') : (0, locales_ts_1.tt)('dialog.empty'), onChange: event => {
                            setRun(current => ({ ...current, text: event.target.value, edited: true }));
                        } }), busy ? (0, jsx_runtime_1.jsx)("div", { className: inline_module_css_1.default.progress, role: "presentation", children: (0, jsx_runtime_1.jsx)("i", {}) }) : null, run.error === undefined ? null : (0, jsx_runtime_1.jsx)("p", { className: inline_module_css_1.default.error, children: run.error })] }), (0, jsx_runtime_1.jsxs)("footer", { className: inline_module_css_1.default.foot, children: [(0, jsx_runtime_1.jsxs)("div", { className: inline_module_css_1.default.refineRow, children: [(0, jsx_runtime_1.jsx)("input", { className: inline_module_css_1.default.refineInput, value: instruction, placeholder: (0, locales_ts_1.tt)('dialog.refinePlaceholder'), disabled: busy, onChange: event => { setInstruction(event.target.value); }, 
                                // This is the input's own submit key, not a global shortcut: it only
                                // fires while the refine field itself has focus.
                                onKeyDown: event => {
                                    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && instruction.trim() !== '' && !busy) {
                                        event.preventDefault();
                                        start(run.text, instruction.trim());
                                    }
                                } }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: inline_module_css_1.default.button, disabled: busy || instruction.trim() === '' || run.text.trim() === '', onClick: () => { start(run.text, instruction.trim()); }, children: (0, locales_ts_1.tt)('dialog.refine') }), busy
                                ? (0, jsx_runtime_1.jsx)("button", { type: "button", className: inline_module_css_1.default.button, onClick: () => { abortRef.current?.abort(); }, children: (0, locales_ts_1.tt)('panel.stop') })
                                : (0, jsx_runtime_1.jsx)("button", { type: "button", className: inline_module_css_1.default.button, disabled: !canAccept, onClick: () => { start('', ''); }, children: (0, locales_ts_1.tt)('panel.retry') })] }), (0, jsx_runtime_1.jsxs)("div", { className: inline_module_css_1.default.actions, children: [(0, jsx_runtime_1.jsx)("span", { className: inline_module_css_1.default.status, children: hasReferences ? (0, locales_ts_1.tt)('panel.statusRefs') : '' }), (0, jsx_runtime_1.jsx)("span", { className: inline_module_css_1.default.spacer }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: inline_module_css_1.default.button, disabled: !hasText, onClick: () => { void copy(); }, children: copied ? (0, locales_ts_1.tt)('dialog.copied') : (0, locales_ts_1.tt)('dialog.copy') }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: inline_module_css_1.default.primary, disabled: !canAccept, onClick: accept, children: (0, locales_ts_1.tt)('dialog.accept') })] })] }), confirming
                ? ((0, jsx_runtime_1.jsx)("div", { className: inline_module_css_1.default.confirmBackdrop, children: (0, jsx_runtime_1.jsxs)("div", { className: inline_module_css_1.default.confirm, role: "alertdialog", "aria-modal": "true", "aria-label": (0, locales_ts_1.tt)('panel.confirmTitle'), children: [(0, jsx_runtime_1.jsx)("h3", { className: inline_module_css_1.default.confirmTitle, children: (0, locales_ts_1.tt)('panel.confirmTitle') }), (0, jsx_runtime_1.jsx)("p", { className: inline_module_css_1.default.confirmBody, children: (0, locales_ts_1.tt)('panel.confirmBody') }), (0, jsx_runtime_1.jsxs)("div", { className: inline_module_css_1.default.confirmActions, children: [(0, jsx_runtime_1.jsx)("button", { type: "button", className: inline_module_css_1.default.button, onClick: () => { setConfirming(false); }, children: (0, locales_ts_1.tt)('panel.confirmCancel') }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: inline_module_css_1.default.primary, onClick: commit, children: (0, locales_ts_1.tt)('panel.confirmOk') })] })] }) }))
                : null] }));
}
const inline_module_css_1 = __importDefault(__dshRequire("src/client/inline.module.css"));

			},
			"src/client/OptimizeButton.tsx": function (module, exports, require) {
			"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OptimizeButton = OptimizeButton;
const jsx_runtime_1 = __dshRequire("\u0000jsx-runtime");
/**
 * The composer tool-row button.
 *
 * Registering into `conversation.input.left` (scope `session`) means the
 * framework already resolved this session's scope and hands the component
 * `sessionId` plus the `useInput` selector hook. That is the entire reason this
 * plugin does not have to guess which session it is acting on.
 *
 * The button is disabled — never hidden — while the composer is empty or the
 * plugin is off, so the control's position stays stable and the tooltip can
 * explain why.
 */
const react_1 = require("react");
const locales_ts_1 = __dshRequire("src/client/locales.ts");
const protocol_ts_1 = __dshRequire("src/protocol.ts");
/**
 * Render the optimize button.
 * @param props - session identity, input hook, and the open callback.
 * @returns the button element.
 */
function OptimizeButton(props) {
    const { sessionId, useInput, enabled, onOpen } = props;
    const draft = useInput(state => state.draft);
    const phase = useInput(state => state.phase);
    const [hovered, setHovered] = (0, react_1.useState)(false);
    const empty = draft.trim() === '';
    const tooLong = draft.length > protocol_ts_1.MAX_DRAFT_CHARS;
    const busy = phase !== 'plain';
    const disabled = !enabled || empty || tooLong || busy;
    const reason = !enabled
        ? (0, locales_ts_1.tt)('button.disabledOff')
        : empty
            ? (0, locales_ts_1.tt)('button.disabledEmpty')
            : tooLong
                ? (0, locales_ts_1.tt)('dialog.tooLong')
                : (0, locales_ts_1.tt)('button.tooltip');
    const open = (0, react_1.useCallback)(() => {
        if (disabled)
            return;
        onOpen(draft);
    }, [disabled, draft, onOpen]);
    // Keep the tooltip honest without pulling in a tooltip primitive the plugin
    // does not otherwise need: a native title plus an accessible label is enough
    // for a single compact control.
    (0, react_1.useEffect)(() => {
        // Session switches remount this entry; nothing to clean up beyond state.
    }, [sessionId]);
    return ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: optimizer_module_css_1.default.toolButton, "data-active": hovered && !disabled ? 'true' : undefined, "aria-label": (0, locales_ts_1.tt)('button.label'), title: reason, disabled: disabled, 
        // Keep the composer focus: clicking a tool-row control must not blur the
        // editor, exactly like the shipped buttons in this row.
        onMouseDown: event => { event.preventDefault(); }, onMouseEnter: () => { setHovered(true); }, onMouseLeave: () => { setHovered(false); }, onClick: open, children: [(0, jsx_runtime_1.jsx)(IconSparkle, {}), (0, jsx_runtime_1.jsx)("span", { className: optimizer_module_css_1.default.toolLabel, children: (0, locales_ts_1.tt)('button.label') })] }));
}
/** Inline glyph: avoids depending on an icon package for one button. */
function IconSparkle() {
    return ((0, jsx_runtime_1.jsxs)("svg", { viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": "true", focusable: "false", children: [(0, jsx_runtime_1.jsx)("path", { d: "M8 1.6l1.32 3.42L12.8 6.4l-3.48 1.38L8 11.2 6.68 7.78 3.2 6.4l3.48-1.38L8 1.6z", fill: "currentColor" }), (0, jsx_runtime_1.jsx)("path", { d: "M12.4 10.4l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6.6-1.6z", fill: "currentColor", opacity: "0.7" })] }));
}
const optimizer_module_css_1 = __importDefault(__dshRequire("src/client/optimizer.module.css"));

			},
			"src/client/SettingsSection.tsx": function (module, exports, require) {
			"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettingsSection = SettingsSection;
const jsx_runtime_1 = __dshRequire("\u0000jsx-runtime");
/**
 * The plugin's settings page.
 *
 * Registered into `settings.section`, so it lives in the official Settings
 * dialog beside every other feature page. The page is a staged editor: local
 * state holds the working copy, and Save writes one atomic set of path
 * operations, which is what keeps a half-finished preset from reaching the
 * stored config.
 */
const react_1 = require("react");
const prompts_ts_1 = __dshRequire("src/prompts.ts");
const locales_ts_1 = __dshRequire("src/client/locales.ts");
const api_ts_1 = __dshRequire("src/client/api.ts");
const settings_ts_1 = __dshRequire("src/client/settings.ts");
/** Subscribe a component to the settings snapshot. */
function useSettingsSnapshot(settings) {
    const [snapshot, setSnapshot] = (0, react_1.useState)(() => settings.getSnapshot());
    (0, react_1.useEffect)(() => {
        setSnapshot(settings.getSnapshot());
        return settings.subscribe(() => { setSnapshot(settings.getSnapshot()); });
    }, [settings]);
    return snapshot;
}
/** Project a resolved config into an editable draft. */
function toDraft(value) {
    return {
        enabled: value.enabled,
        provider: value.provider,
        model: value.model,
        temperature: value.temperature,
        maxTokens: value.maxTokens,
        mainSystemPrompt: value.mainSystemPrompt === '' ? prompts_ts_1.DEFAULT_MAIN_PROMPT : value.mainSystemPrompt,
        presets: value.presets.map(preset => ({ ...preset })),
        activePresetId: value.activePresetId,
    };
}
/**
 * Render the settings page.
 * @param props - the settings shell owner share plus the bound handle.
 * @returns the page element tree.
 */
function SettingsSection(props) {
    const snapshot = useSettingsSnapshot(props.settings);
    const [draft, setDraft] = (0, react_1.useState)(() => toDraft(snapshot.value));
    const [dirty, setDirty] = (0, react_1.useState)(false);
    const [saving, setSaving] = (0, react_1.useState)(false);
    const [status, setStatus] = (0, react_1.useState)('idle');
    const [groups, setGroups] = (0, react_1.useState)(undefined);
    const [catalogError, setCatalogError] = (0, react_1.useState)(undefined);
    const [catalogLoading, setCatalogLoading] = (0, react_1.useState)(false);
    const adopted = (0, react_1.useRef)(undefined);
    // Adopt host values whenever the stored section changes and the user has no
    // unsaved edits; a dirty draft is never silently overwritten.
    (0, react_1.useEffect)(() => {
        if (dirty)
            return;
        setDraft(toDraft(snapshot.value));
    }, [snapshot.value, dirty]);
    const loadCatalog = (0, react_1.useCallback)(() => {
        const controller = new AbortController();
        setCatalogLoading(true);
        setCatalogError(undefined);
        void (0, api_ts_1.fetchModels)(controller.signal).then(result => {
            setCatalogLoading(false);
            if (!result.ok) {
                setCatalogError(result.message ?? (0, locales_ts_1.tt)('settings.catalogFailed'));
                return;
            }
            setGroups(result.providers);
        });
        return () => { controller.abort(); };
    }, []);
    (0, react_1.useEffect)(() => loadCatalog(), [loadCatalog]);
    /** The provider rows the pickers render, with the stored values kept visible. */
    const providers = (0, react_1.useMemo)(() => {
        const rows = groups ?? [];
        // A stored provider the host no longer advertises must stay selectable,
        // otherwise opening the page would silently rewrite the user's choice.
        if (draft.provider !== '' && !rows.some(row => row.id === draft.provider)) {
            return [{ id: draft.provider, name: `${draft.provider} (${(0, locales_ts_1.tt)('settings.noModels')})`, models: [] }, ...rows];
        }
        return rows;
    }, [groups, draft.provider]);
    const models = (0, react_1.useMemo)(() => {
        const row = providers.find(candidate => candidate.id === draft.provider);
        const list = row?.models ?? [];
        if (draft.model !== '' && !list.some(model => model.id === draft.model)) {
            return [{ id: draft.model, name: `${draft.model} (${(0, locales_ts_1.tt)('settings.noModels')})` }, ...list];
        }
        return list;
    }, [providers, draft.provider, draft.model]);
    const update = (0, react_1.useCallback)((change) => {
        setDraft(current => ({ ...current, ...change }));
        setDirty(true);
        setStatus('idle');
    }, []);
    /** Persist the working copy as one revision-fenced mutation. */
    const save = (0, react_1.useCallback)(() => {
        setSaving(true);
        setStatus('idle');
        const ops = [
            { op: 'set', path: ['enabled'], value: draft.enabled },
            { op: 'set', path: ['provider'], value: draft.provider },
            { op: 'set', path: ['model'], value: draft.model },
            { op: 'set', path: ['temperature'], value: draft.temperature },
            { op: 'set', path: ['maxTokens'], value: draft.maxTokens },
            { op: 'set', path: ['mainSystemPrompt'], value: draft.mainSystemPrompt },
            // Array fields are written wholesale: path operations cannot reach
            // inside an array, so a partial edit is not expressible.
            { op: 'set', path: ['presets'], value: draft.presets.map(preset => ({ ...preset })) },
            { op: 'set', path: ['activePresetId'], value: draft.activePresetId },
        ];
        void props.settings.apply(ops).then(ok => {
            setSaving(false);
            if (ok) {
                setDirty(false);
                setStatus('saved');
                window.setTimeout(() => { setStatus(current => current === 'saved' ? 'idle' : current); }, 2000);
                return;
            }
            setStatus('failed');
        });
    }, [draft, props.settings]);
    const addPreset = (0, react_1.useCallback)(() => {
        const id = `preset-${Date.now().toString(36)}`;
        update({ presets: [...draft.presets, { id, name: '新预设', system: '' }] });
    }, [draft.presets, update]);
    const removePreset = (0, react_1.useCallback)((id) => {
        update({
            presets: draft.presets.filter(preset => preset.id !== id),
            activePresetId: draft.activePresetId === id ? '' : draft.activePresetId,
        });
    }, [draft.presets, draft.activePresetId, update]);
    const editPreset = (0, react_1.useCallback)((id, change) => {
        update({ presets: draft.presets.map(preset => preset.id === id ? { ...preset, ...change } : preset) });
    }, [draft.presets, update]);
    const writable = snapshot.writable;
    const transportNote = snapshot.status === 'loading'
        ? (0, locales_ts_1.tt)('settings.scopeLoading')
        : snapshot.status === 'unavailable' || !writable
            ? (0, locales_ts_1.tt)('settings.scopeUnavailable')
            : undefined;
    return ((0, jsx_runtime_1.jsxs)("div", { className: optimizer_module_css_1.default.section, children: [(0, jsx_runtime_1.jsx)("p", { className: optimizer_module_css_1.default.sectionDescription, children: (0, locales_ts_1.tt)('settings.description') }), transportNote === undefined ? null : (0, jsx_runtime_1.jsx)("p", { className: optimizer_module_css_1.default.notice, children: transportNote }), (0, jsx_runtime_1.jsx)("section", { className: optimizer_module_css_1.default.fieldset, children: (0, jsx_runtime_1.jsxs)("label", { className: optimizer_module_css_1.default.checkboxRow, children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: draft.enabled, disabled: !writable, onChange: event => { update({ enabled: event.target.checked }); } }), (0, jsx_runtime_1.jsxs)("span", { children: [(0, jsx_runtime_1.jsx)("span", { className: optimizer_module_css_1.default.fieldLabel, children: (0, locales_ts_1.tt)('settings.enabled') }), (0, jsx_runtime_1.jsx)("br", {}), (0, jsx_runtime_1.jsx)("span", { className: optimizer_module_css_1.default.fieldHint, children: (0, locales_ts_1.tt)('settings.enabledHint') })] })] }) }), (0, jsx_runtime_1.jsxs)("section", { className: optimizer_module_css_1.default.fieldset, children: [(0, jsx_runtime_1.jsx)("h3", { className: optimizer_module_css_1.default.fieldsetTitle, children: (0, locales_ts_1.tt)('settings.channel') }), catalogError === undefined ? null : ((0, jsx_runtime_1.jsxs)("p", { className: `${optimizer_module_css_1.default.notice} ${optimizer_module_css_1.default.noticeError}`, children: [catalogError, (0, jsx_runtime_1.jsx)("button", { type: "button", className: optimizer_module_css_1.default.button, onClick: loadCatalog, style: { marginLeft: 8 }, children: (0, locales_ts_1.tt)('settings.catalogRetry') })] })), catalogLoading ? (0, jsx_runtime_1.jsx)("p", { className: optimizer_module_css_1.default.notice, children: (0, locales_ts_1.tt)('settings.catalogLoad') }) : null, (0, jsx_runtime_1.jsxs)("div", { className: optimizer_module_css_1.default.row, children: [(0, jsx_runtime_1.jsxs)("label", { className: `${optimizer_module_css_1.default.field} ${optimizer_module_css_1.default.grow}`, children: [(0, jsx_runtime_1.jsx)("span", { className: optimizer_module_css_1.default.fieldLabel, children: (0, locales_ts_1.tt)('settings.channel') }), (0, jsx_runtime_1.jsxs)("select", { className: optimizer_module_css_1.default.select, value: draft.provider, disabled: !writable, onChange: event => {
                                            const provider = event.target.value;
                                            const first = providers.find(row => row.id === provider)?.models[0]?.id ?? '';
                                            update({ provider, model: first });
                                        }, children: [providers.length === 0 ? (0, jsx_runtime_1.jsx)("option", { value: draft.provider, children: (0, locales_ts_1.tt)('settings.noProviders') }) : null, providers.map(row => (0, jsx_runtime_1.jsx)("option", { value: row.id, children: row.name }, row.id))] })] }), (0, jsx_runtime_1.jsxs)("label", { className: `${optimizer_module_css_1.default.field} ${optimizer_module_css_1.default.grow}`, children: [(0, jsx_runtime_1.jsx)("span", { className: optimizer_module_css_1.default.fieldLabel, children: (0, locales_ts_1.tt)('settings.model') }), (0, jsx_runtime_1.jsxs)("select", { className: optimizer_module_css_1.default.select, value: draft.model, disabled: !writable, onChange: event => { update({ model: event.target.value }); }, children: [models.length === 0 ? (0, jsx_runtime_1.jsx)("option", { value: draft.model, children: (0, locales_ts_1.tt)('settings.noModels') }) : null, models.map(model => (0, jsx_runtime_1.jsx)("option", { value: model.id, children: model.name }, model.id))] })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: optimizer_module_css_1.default.row, children: [(0, jsx_runtime_1.jsxs)("label", { className: `${optimizer_module_css_1.default.field} ${optimizer_module_css_1.default.grow}`, children: [(0, jsx_runtime_1.jsx)("span", { className: optimizer_module_css_1.default.fieldLabel, children: (0, locales_ts_1.tt)('settings.temperature') }), (0, jsx_runtime_1.jsx)("input", { className: optimizer_module_css_1.default.input, type: "number", min: 0, max: 2, step: 0.1, value: draft.temperature, disabled: !writable, onChange: event => {
                                            const next = Number(event.target.value);
                                            update({ temperature: Number.isFinite(next) ? next : settings_ts_1.CONFIG_DEFAULTS.temperature });
                                        } }), (0, jsx_runtime_1.jsx)("span", { className: optimizer_module_css_1.default.fieldHint, children: (0, locales_ts_1.tt)('settings.temperatureHint') })] }), (0, jsx_runtime_1.jsxs)("label", { className: `${optimizer_module_css_1.default.field} ${optimizer_module_css_1.default.grow}`, children: [(0, jsx_runtime_1.jsx)("span", { className: optimizer_module_css_1.default.fieldLabel, children: (0, locales_ts_1.tt)('settings.maxTokens') }), (0, jsx_runtime_1.jsx)("input", { className: optimizer_module_css_1.default.input, type: "number", min: 0, step: 256, value: draft.maxTokens, disabled: !writable, onChange: event => {
                                            const next = Math.floor(Number(event.target.value));
                                            update({ maxTokens: Number.isFinite(next) && next > 0 ? next : 0 });
                                        } }), (0, jsx_runtime_1.jsx)("span", { className: optimizer_module_css_1.default.fieldHint, children: (0, locales_ts_1.tt)('settings.maxTokensHint') })] })] })] }), (0, jsx_runtime_1.jsxs)("section", { className: optimizer_module_css_1.default.fieldset, children: [(0, jsx_runtime_1.jsx)("h3", { className: optimizer_module_css_1.default.fieldsetTitle, children: (0, locales_ts_1.tt)('settings.mainPrompt') }), (0, jsx_runtime_1.jsx)("span", { className: optimizer_module_css_1.default.fieldHint, children: (0, locales_ts_1.tt)('settings.mainPromptHint') }), (0, jsx_runtime_1.jsx)("textarea", { className: optimizer_module_css_1.default.promptArea, value: draft.mainSystemPrompt, disabled: !writable, onChange: event => { update({ mainSystemPrompt: event.target.value }); } }), (0, jsx_runtime_1.jsx)("div", { className: optimizer_module_css_1.default.actions, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: optimizer_module_css_1.default.button, disabled: !writable, onClick: () => { update({ mainSystemPrompt: prompts_ts_1.DEFAULT_MAIN_PROMPT }); }, children: (0, locales_ts_1.tt)('settings.resetMain') }) })] }), (0, jsx_runtime_1.jsxs)("section", { className: optimizer_module_css_1.default.fieldset, children: [(0, jsx_runtime_1.jsx)("h3", { className: optimizer_module_css_1.default.fieldsetTitle, children: (0, locales_ts_1.tt)('settings.presets') }), (0, jsx_runtime_1.jsx)("span", { className: optimizer_module_css_1.default.fieldHint, children: (0, locales_ts_1.tt)('settings.presetsHint') }), (0, jsx_runtime_1.jsxs)("label", { className: optimizer_module_css_1.default.field, children: [(0, jsx_runtime_1.jsx)("span", { className: optimizer_module_css_1.default.fieldLabel, children: (0, locales_ts_1.tt)('settings.activePreset') }), (0, jsx_runtime_1.jsxs)("select", { className: optimizer_module_css_1.default.select, value: draft.activePresetId, disabled: !writable, onChange: event => { update({ activePresetId: event.target.value }); }, children: [(0, jsx_runtime_1.jsx)("option", { value: "", children: (0, locales_ts_1.tt)('settings.noPreset') }), draft.presets.map(preset => (0, jsx_runtime_1.jsx)("option", { value: preset.id, children: preset.name }, preset.id))] })] }), draft.presets.map(preset => ((0, jsx_runtime_1.jsxs)("div", { className: optimizer_module_css_1.default.presetCard, children: [(0, jsx_runtime_1.jsxs)("div", { className: optimizer_module_css_1.default.presetHead, children: [(0, jsx_runtime_1.jsx)("input", { className: `${optimizer_module_css_1.default.input} ${optimizer_module_css_1.default.grow}`, value: preset.name, disabled: !writable, "aria-label": (0, locales_ts_1.tt)('settings.presetName'), onChange: event => { editPreset(preset.id, { name: event.target.value }); } }), (0, jsx_runtime_1.jsx)("button", { type: "button", className: optimizer_module_css_1.default.button, disabled: !writable, onClick: () => { removePreset(preset.id); }, children: (0, locales_ts_1.tt)('settings.removePreset') })] }), (0, jsx_runtime_1.jsx)("textarea", { className: optimizer_module_css_1.default.promptArea, value: preset.system, disabled: !writable, "aria-label": (0, locales_ts_1.tt)('settings.presetSystem'), onChange: event => { editPreset(preset.id, { system: event.target.value }); } })] }, preset.id))), (0, jsx_runtime_1.jsx)("div", { className: optimizer_module_css_1.default.actions, children: (0, jsx_runtime_1.jsx)("button", { type: "button", className: optimizer_module_css_1.default.button, disabled: !writable, onClick: addPreset, children: (0, locales_ts_1.tt)('settings.addPreset') }) })] }), (0, jsx_runtime_1.jsxs)("div", { className: optimizer_module_css_1.default.actions, children: [status === 'saved' ? (0, jsx_runtime_1.jsx)("span", { className: optimizer_module_css_1.default.statusLine, children: (0, locales_ts_1.tt)('settings.saved') }) : null, status === 'failed' ? (0, jsx_runtime_1.jsx)("span", { className: `${optimizer_module_css_1.default.notice} ${optimizer_module_css_1.default.noticeError}`, children: (0, locales_ts_1.tt)('settings.saveFailed') }) : null, (0, jsx_runtime_1.jsx)("button", { type: "button", className: optimizer_module_css_1.default.primary, disabled: !writable || saving || !dirty, onClick: save, children: saving ? '…' : (0, locales_ts_1.tt)('settings.save') })] })] }));
}
const optimizer_module_css_1 = __importDefault(__dshRequire("src/client/optimizer.module.css"));

			},
			"src/client/api.ts": function (module, exports, require) {
			"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchModels = fetchModels;
exports.draftRejection = draftRejection;
exports.runOptimize = runOptimize;
/**
 * Browser-side transport for the plugin's loopback routes.
 *
 * One module owns both endpoints so the request shapes, the SSE parser, and
 * the abort discipline live in exactly one place.
 */
const protocol_ts_1 = __dshRequire("src/protocol.ts");
/**
 * Read the host's provider and chat-model roster.
 * @param signal - caller cancellation.
 * @returns the roster, or an `ok: false` result carrying a readable reason.
 */
async function fetchModels(signal) {
    let response;
    try {
        response = await fetch(protocol_ts_1.OPTIMIZER_API.models, { headers: { accept: 'application/json' }, ...signal === undefined ? {} : { signal } });
    }
    catch (error) {
        return { ok: false, providers: [], message: error instanceof Error ? error.message : String(error) };
    }
    if (!response.ok)
        return { ok: false, providers: [], message: `HTTP ${response.status}` };
    let body;
    try {
        body = await response.json();
    }
    catch {
        return { ok: false, providers: [], message: 'the model route returned non-JSON' };
    }
    if (body.ok !== true || !Array.isArray(body.providers)) {
        return { ok: false, providers: [], message: body.message ?? 'the model route refused the request' };
    }
    return { ok: true, providers: body.providers };
}
/**
 * Refusal reasons the client can decide before spending a round trip.
 * @param text - the draft.
 * @returns the limit message, or undefined when the draft is acceptable.
 */
function draftRejection(text) {
    if (text.trim() === '')
        return 'empty';
    if (text.length > protocol_ts_1.MAX_DRAFT_CHARS)
        return 'too-long';
    return undefined;
}
/**
 * Run one optimization, streaming deltas through `onDelta`.
 *
 * Resolves with the terminal outcome rather than throwing: a model failure is a
 * normal result the dialog renders, not an exception the caller has to catch.
 * @param input - the request.
 * @param onDelta - called for every visible text fragment.
 * @returns the terminal outcome.
 */
async function runOptimize(input, onDelta) {
    let response;
    try {
        response = await fetch(protocol_ts_1.OPTIMIZER_API.optimize, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
            body: JSON.stringify({
                text: input.text,
                system: input.system,
                ...input.previous === undefined ? {} : { previous: input.previous },
                ...input.instruction === undefined ? {} : { instruction: input.instruction },
            }),
            ...input.signal === undefined ? {} : { signal: input.signal },
        });
    }
    catch (error) {
        if (input.signal?.aborted === true)
            return { kind: 'aborted', text: '' };
        return { kind: 'error', code: 'network', message: error instanceof Error ? error.message : String(error) };
    }
    if (!response.ok) {
        // The route answers refusals (empty draft, over-long draft, unavailable
        // LLM service) as JSON before the stream opens, so surface that message.
        const message = await readErrorMessage(response);
        return { kind: 'error', code: `http-${response.status}`, message };
    }
    if (response.body === null)
        return { kind: 'error', code: 'no-body', message: 'The optimize route returned no stream' };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let assembled = '';
    let outcome;
    const handleFrame = (payload) => {
        let event;
        try {
            event = JSON.parse(payload);
        }
        catch {
            return;
        }
        if (event.type === 'delta') {
            assembled += event.text;
            onDelta(event.text);
            return;
        }
        if (event.type === 'done') {
            outcome = event.aborted === true ? { kind: 'aborted', text: assembled } : { kind: 'done', text: assembled };
            return;
        }
        if (event.type === 'error') {
            outcome = { kind: 'error', code: event.code, message: event.message };
        }
    };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            // Frames are `data: <json>` separated by a blank line; tolerate CRLF.
            let boundary = findFrameBoundary(buffer);
            while (boundary !== undefined) {
                const raw = buffer.slice(0, boundary.index);
                buffer = buffer.slice(boundary.index + boundary.length);
                for (const line of raw.split(/\r?\n/)) {
                    if (line.startsWith('data:'))
                        handleFrame(line.slice(5).trim());
                }
                boundary = findFrameBoundary(buffer);
            }
        }
        // A final frame without its trailing blank line still counts.
        for (const line of buffer.split(/\r?\n/)) {
            if (line.startsWith('data:'))
                handleFrame(line.slice(5).trim());
        }
    }
    catch (error) {
        if (input.signal?.aborted === true)
            return { kind: 'aborted', text: assembled };
        return { kind: 'error', code: 'stream', message: error instanceof Error ? error.message : String(error) };
    }
    if (outcome !== undefined)
        return outcome;
    if (input.signal?.aborted === true)
        return { kind: 'aborted', text: assembled };
    // The stream closed without a terminal frame: report what arrived rather
    // than pretending the run succeeded.
    return assembled === ''
        ? { kind: 'error', code: 'no-output', message: 'The model returned nothing' }
        : { kind: 'done', text: assembled };
}
/** Locate the next SSE frame boundary in a buffer. */
function findFrameBoundary(buffer) {
    const lf = buffer.indexOf('\n\n');
    const crlf = buffer.indexOf('\r\n\r\n');
    if (lf < 0 && crlf < 0)
        return undefined;
    if (crlf >= 0 && (lf < 0 || crlf < lf))
        return { index: crlf, length: 4 };
    return { index: lf, length: 2 };
}
/** Read a refusal body's message, falling back to the status line. */
async function readErrorMessage(response) {
    try {
        const body = await response.json();
        if (typeof body.message === 'string' && body.message !== '')
            return body.message;
        if (typeof body.error === 'string' && body.error !== '')
            return body.error;
    }
    catch {
        // Non-JSON refusals keep the generic text.
    }
    return `HTTP ${response.status}`;
}

			},
			"src/client/accept-guard.ts": function (module, exports, require) {
			"use strict";
/**
 * The accept gate: the one rule that protects the user's draft.
 *
 * Pure and isolated on purpose. v1 kept this next to the modal component, which
 * was fine while the modal was the only surface; in v2 the panel is the surface
 * and the modal is retired, so the rule lives in its own module rather than
 * being inherited from a component that no longer exists.
 *
 * Why it is a named export instead of an inline `if`: the mid-stream refusal is
 * the difference between writing the model's *answer* into the composer and
 * writing a *prefix* of it. A rule that only lives inside an event handler is a
 * rule nothing can regression-test without a browser.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.acceptRefusal = acceptRefusal;
/**
 * Why an accept must be refused, or undefined when the write may proceed.
 * @param phase - the current run's phase.
 * @param text - the text the result pane currently holds.
 * @returns the refusal reason, or undefined to allow the write.
 */
function acceptRefusal(phase, text) {
    if (phase === 'running')
        return 'busy';
    if (text.trim() === '')
        return 'empty';
    return undefined;
}

			},
			"src/protocol.ts": function (module, exports, require) {
			"use strict";
/**
 * Shared wire contract between the two halves of dsh-prompt-forge.
 *
 * The host half owns the LLM channel: the browser never sees an API key, a
 * base URL, or the provider SDK — it posts a draft to a loopback route and
 * reads a server-sent event stream back. Everything both halves must agree on
 * (route paths, request/response shapes, limits) lives here.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_DRAFT_CHARS = exports.DEFAULT_TEMPERATURE = exports.DEFAULT_MODEL = exports.DEFAULT_PROVIDER = exports.OPTIMIZER_API = exports.CONFIG_FINGERPRINT_FIELDS = exports.PROMPT_FORGE_NAMESPACE = void 0;
/**
 * Settings namespace the host half registers, as declared in cordis.patch.yml.
 *
 * The managed-forms settings provider keys every namespace by Loader entry id,
 * and an **inserted** row's entry id is `include:<rowId>`. So this plugin's
 * live namespace is `include:prompt-forge`, not this bare value: the
 * constant names the row, and the browser half resolves the concrete string at
 * runtime (exact id → `:<rowId>` suffix → schema fingerprint). Keeping the row
 * id and this constant identical is what makes that resolution unambiguous.
 */
exports.PROMPT_FORGE_NAMESPACE = 'prompt-forge';
/**
 * Field names unique to this plugin's Config, used to recognize its settings
 * section if the entry id ever stops matching {@link PROMPT_FORGE_NAMESPACE}
 * (a renamed patch row, or a host that keys sections differently).
 */
exports.CONFIG_FINGERPRINT_FIELDS = ['mainSystemPrompt', 'activePresetId'];
/** Route family, all loopback-fenced same-origin POST/GET endpoints. */
exports.OPTIMIZER_API = {
    /** GET: the configured provider roster with each route's model catalog. */
    models: '/api/dsh-prompt-forge/models',
    /** POST: one optimization run, answered as an SSE stream. */
    optimize: '/api/dsh-prompt-forge/optimize',
};
/**
 * Default model route. `ofox` is the provider id the desktop profile declares;
 * the model is the flash tier, which is fast enough for interactive rewriting.
 */
exports.DEFAULT_PROVIDER = 'ofox';
exports.DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash';
/** Default sampling temperature: low, because rewriting must not invent intent. */
exports.DEFAULT_TEMPERATURE = 0.3;
/**
 * Draft length ceiling. The route refuses anything longer instead of silently
 * truncating: a user who pasted a whole file deserves a readable refusal.
 */
exports.MAX_DRAFT_CHARS = 20000;

			},
			"src/prompts.ts": function (module, exports, require) {
			"use strict";
/**
 * Prompt copy owned by the plugin: one default main system prompt and the
 * built-in preset roster.
 *
 * Every prompt here obeys the same three rules, because they are what keeps an
 * optimizer from becoming a rewriter: preserve the user's intent and language,
 * invent no facts, and emit the prompt and nothing else.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUILTIN_PRESETS = exports.WRITING_PRESET_PROMPT = exports.CODING_PRESET_PROMPT = exports.DEFAULT_MAIN_PROMPT = void 0;
exports.resolveSystemPrompt = resolveSystemPrompt;
/** Shared closing instruction: the model must return the prompt alone. */
const OUTPUT_ONLY = '只输出改写后的提示词本身。不要解释你做了什么，不要加标题、前言、说明、Markdown 代码块包裹，也不要加「优化后的提示词：」这类标签。';
/** The prompt applied when the user selects no preset. */
exports.DEFAULT_MAIN_PROMPT = `你是一名提示词工程师。用户会给你一段写给 AI 模型的草稿，可能属于编码、问答、写作、分析等任何任务。你的工作是在完全保留原意的前提下，把它改写成一段更清晰、更可执行的提示词。

改写要求：
1. 保留原始意图、事实、约束、语言和语气。不要新增用户没有提出的需求，不要把任务换成另一类任务。
2. 补足可执行性：写清任务目标、必要的背景与上下文、输出要求（格式、长度、语言）。原文没给的信息，用最保守的合理默认补齐，绝不编造具体事实、数据、文件路径或接口名。
3. 消除歧义与冗余：合并重复表述，把「这个」「那个」「弄一下」这类模糊指代替换成明确指代。
4. 原文中的代码、报错信息、路径、命令、专有名词、专业术语一律原样保留，不要改写或翻译。
5. 跟随原文语言：中文草稿输出中文，英文草稿输出英文。

${OUTPUT_ONLY}`;
/** The coding preset: same discipline, weighted toward implementable specs. */
exports.CODING_PRESET_PROMPT = `你是一名提示词工程师。用户会给你一段和软件开发有关的草稿。请在不改变原意的前提下，把它改写成一段工程上可直接执行的提示词。

改写要求：
1. 保留原始意图、技术栈、既有约束和语言。不要替换技术选型，不要新增用户没要求的功能。
2. 明确以下要素（原文已有的保持不动，缺失的只在能从原文合理推断时补上，否则留空而不编造）：要改动的范围与文件、期望行为、必须保持不变的既有行为、边界与错误处理、验收标准。
3. 涉及代码、报错、日志、路径、命令、API 名称、版本号时，一律原样保留。
4. 去掉空泛表述（「优化一下」「看着改」），换成可判断是否完成的具体要求。
5. 跟随原文语言。

${OUTPUT_ONLY}`;
/** The writing preset: same discipline, weighted toward prose outcomes. */
exports.WRITING_PRESET_PROMPT = `你是一名提示词工程师。用户会给你一段写作、改写或内容创作相关的草稿。请在不改变原意的前提下，把它改写成一段结果可控的提示词。

改写要求：
1. 保留原始意图、事实、观点立场、语言和语气。不要替用户改立场，不要新增事实或数据。
2. 明确写作要素：文体与用途、目标读者、语气、篇幅或结构、必须包含与必须避免的内容。原文没说的不要臆造，只做最保守的默认。
3. 把「写得好一点」「专业一些」这类空泛要求，换成可判断的具体标准。
4. 原文提到的人名、术语、专有名词、引用一律保留原样。
5. 跟随原文语言。

${OUTPUT_ONLY}`;
/**
 * The presets a fresh install starts with. Ids are stable so an upgrade never
 * duplicates rows; a user deletion is remembered because the stored array
 * replaces this default wholesale.
 */
exports.BUILTIN_PRESETS = [
    { id: 'general', name: '通用优化', system: exports.DEFAULT_MAIN_PROMPT },
    { id: 'coding', name: '编码任务', system: exports.CODING_PRESET_PROMPT },
    { id: 'writing', name: '写作改写', system: exports.WRITING_PRESET_PROMPT },
];
/**
 * Resolve the system prompt one request should use: a selected preset wins,
 * the main prompt is the fallback, and the built-in default is the last
 * resort (an empty stored value must never send an empty system prompt).
 * @param preset - the preset body chosen by the caller.
 * @param main - the stored main prompt.
 * @returns the non-empty system prompt to send.
 */
function resolveSystemPrompt(preset, main) {
    const chosen = typeof preset === 'string' ? preset.trim() : '';
    if (chosen !== '')
        return chosen;
    const stored = typeof main === 'string' ? main.trim() : '';
    return stored === '' ? exports.DEFAULT_MAIN_PROMPT : stored;
}

			},
			"src/client/inline.module.css": function (module, exports, require) {
			"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const css = "/*\n * Inline optimization panel styles.\n *\n * Every color reads a shipped `--dsw-alias-*` token so the panel follows the\n * active light/dark theme instead of hard-coding a palette.\n *\n * Sizing rule that matters: the panel fills its slot's anchor width (the\n * composer card, 712px at the shipped default) and floats *above* the card via\n * `bottom: 100%`. The host anchor is zero-height and absolutely positioned, so\n * nothing here can move the composer, the editor, or the transcript.\n */\n\n.inline_panel {\n  position: absolute;\n  left: 0;\n  right: 0;\n  /* Float above the composer's top edge with a small gap. */\n  bottom: calc(100% + 8px);\n  display: flex;\n  flex-direction: column;\n  height: min(42vh, 360px);\n  max-height: calc(100vh - 120px);\n  border: 1px solid var(--dsw-alias-border-l1);\n  border-radius: var(--dsw-radius-lg);\n  /*\n   * `--dsw-specific-menu` is deliberately translucent (it is the shipped menu\n   * surface), and the panel sits on top of the transcript, so without a blur\n   * the message text behind it bleeds straight through and the result becomes\n   * unreadable — very visible in the light theme. The shipped menu panels pair\n   * this background with the menu backdrop filter for exactly that reason.\n   */\n  background: var(--dsw-specific-menu, var(--dsw-alias-bg-overlay));\n  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(12px));\n  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter, blur(12px));\n  color: var(--dsw-alias-label-primary);\n  box-shadow: 0 18px 44px color-mix(in srgb, #000 42%, transparent);\n  overflow: hidden;\n  /*\n   * Deliberately LOW. The panel lives inside the composer seat, which is itself\n   * an elevated sticky layer (`z-index: 7`, bumped to 9 while the model trigger\n   * menu is open), so the seat's stacking context already puts this panel above\n   * the transcript regardless of the value here. What z-index matters *inside*\n   * the seat is the official model dropdown: it opens upward from the bottom of\n   * the card and therefore crosses the panel's footprint. Keeping the panel low\n   * lets that menu paint over the panel instead of being buried by it.\n   */\n  z-index: 1;\n}\n\n.inline_head {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: 8px 10px 8px 12px;\n  border-bottom: 1px solid var(--dsw-alias-border-l1);\n}\n\n.inline_title {\n  flex: none;\n  font-size: 12px;\n  font-weight: 600;\n}\n\n.inline_model {\n  flex: 1 1 auto;\n  min-width: 0;\n  overflow: hidden;\n  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary));\n  font-size: 11px;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.inline_headRight {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 6px;\n}\n\n.inline_select {\n  height: 24px;\n  border: 1px solid var(--dsw-alias-border-l1);\n  border-radius: var(--dsw-radius-sm);\n  background: var(--dsw-alias-bg-layer-1);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 11px;\n  padding: 0 4px;\n}\n\n.inline_select:focus-visible {\n  outline: 2px solid var(--dsw-alias-brand-primary);\n  outline-offset: 1px;\n}\n\n.inline_iconButton {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 24px;\n  height: 24px;\n  border: 1px solid transparent;\n  border-radius: var(--dsw-radius-sm);\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  font-size: 12px;\n}\n\n.inline_iconButton:hover {\n  background: var(--dsw-alias-bg-layer-2);\n  color: var(--dsw-alias-label-primary);\n}\n\n.inline_body {\n  flex: 1 1 auto;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  padding: 10px 12px;\n  overflow: auto;\n}\n\n.inline_fold {\n  flex: none;\n  align-self: flex-start;\n  padding: 0;\n  border: none;\n  background: none;\n  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));\n  font: inherit;\n  font-size: 11px;\n  cursor: pointer;\n}\n\n.inline_fold:hover {\n  color: var(--dsw-alias-label-secondary);\n}\n\n.inline_originalBox {\n  flex: none;\n  max-height: 72px;\n  overflow: auto;\n  padding: 8px 10px;\n  border: 1px solid var(--dsw-alias-border-l1);\n  border-radius: var(--dsw-radius-md);\n  background: var(--dsw-alias-bg-layer-1);\n  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));\n  font-size: 12px;\n  line-height: 1.6;\n  white-space: pre-wrap;\n  word-break: break-word;\n}\n\n.inline_paneHead {\n  flex: none;\n  display: flex;\n  align-items: baseline;\n  justify-content: space-between;\n  gap: 8px;\n}\n\n.inline_paneTitle {\n  color: var(--dsw-alias-label-secondary);\n  font-size: 11px;\n  font-weight: 600;\n}\n\n.inline_counter {\n  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary));\n  font-size: 10px;\n  font-variant-numeric: tabular-nums;\n}\n\n.inline_resultBox {\n  flex: 1 1 auto;\n  min-height: 96px;\n  max-height: 100%;\n  width: 100%;\n  overflow: auto;\n  resize: none;\n  padding: 9px 10px;\n  border: 1px solid var(--dsw-alias-border-l1);\n  border-radius: var(--dsw-radius-md);\n  background: var(--dsw-alias-bg-layer-1);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12.5px;\n  line-height: 1.7;\n  white-space: pre-wrap;\n  word-break: break-word;\n}\n\n.inline_resultBox:focus-visible {\n  outline: 2px solid var(--dsw-alias-brand-primary);\n  outline-offset: 1px;\n}\n\n.inline_progress {\n  flex: none;\n  height: 2px;\n  border-radius: 2px;\n  background: var(--dsw-alias-bg-layer-2);\n  overflow: hidden;\n}\n\n.inline_progress i {\n  display: block;\n  height: 100%;\n  width: 34%;\n  background: var(--dsw-alias-brand-primary);\n  animation: pf-slide 1.1s ease-in-out infinite;\n}\n\n@keyframes pf-slide {\n  0% { margin-left: -34%; }\n  100% { margin-left: 100%; }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .inline_progress i { animation: none; margin-left: 0; width: 100%; opacity: .5; }\n}\n\n.inline_error {\n  flex: none;\n  margin: 0;\n  color: var(--dsw-alias-state-error-primary);\n  font-size: 11.5px;\n}\n\n.inline_foot {\n  flex: none;\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  padding: 9px 12px 10px;\n  border-top: 1px solid var(--dsw-alias-border-l1);\n  background: var(--dsw-alias-bg-layer-1);\n}\n\n.inline_refineRow {\n  display: flex;\n  gap: 8px;\n}\n\n.inline_refineInput {\n  flex: 1 1 auto;\n  min-width: 0;\n  height: 28px;\n  padding: 0 8px;\n  border: 1px solid var(--dsw-alias-border-l1);\n  border-radius: var(--dsw-radius-sm);\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n}\n\n.inline_refineInput:focus-visible {\n  outline: 2px solid var(--dsw-alias-brand-primary);\n  outline-offset: 1px;\n}\n\n.inline_actions {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  flex-wrap: wrap;\n}\n\n.inline_spacer {\n  flex: 1 1 auto;\n}\n\n.inline_status {\n  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary));\n  font-size: 11px;\n}\n\n.inline_button,\n.inline_primary {\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  height: 28px;\n  padding: 0 12px;\n  border: 1px solid var(--dsw-alias-border-l1);\n  border-radius: var(--dsw-radius-sm);\n  background: var(--dsw-alias-bg-layer-2);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  cursor: pointer;\n}\n\n.inline_button:hover:not(:disabled) {\n  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));\n}\n\n.inline_primary {\n  border-color: transparent;\n  background: var(--dsw-alias-brand-primary);\n  color: #fff;\n  font-weight: 600;\n}\n\n.inline_primary:hover:not(:disabled) {\n  filter: brightness(1.08);\n}\n\n.inline_button:disabled,\n.inline_primary:disabled {\n  opacity: 0.42;\n  cursor: not-allowed;\n}\n\n.inline_button:focus-visible,\n.inline_primary:focus-visible {\n  outline: 2px solid var(--dsw-alias-brand-primary);\n  outline-offset: 1px;\n}\n\n.inline_confirmBackdrop {\n  position: absolute;\n  inset: 0;\n  z-index: 30;\n  display: grid;\n  place-items: center;\n  padding: 12px;\n  background: color-mix(in srgb, #000 44%, transparent);\n}\n\n.inline_confirm {\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n  width: min(420px, 100%);\n  padding: 14px 16px;\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: var(--dsw-radius-lg);\n  background: var(--dsw-alias-bg-overlay);\n  box-shadow: 0 18px 48px color-mix(in srgb, #000 50%, transparent);\n}\n\n.inline_confirmTitle {\n  margin: 0;\n  font-size: 13px;\n  font-weight: 600;\n}\n\n.inline_confirmBody {\n  margin: 0;\n  color: var(--dsw-alias-label-secondary);\n  font-size: 12px;\n  line-height: 1.7;\n}\n\n.inline_confirmActions {\n  display: flex;\n  justify-content: flex-end;\n  gap: 8px;\n}\n";
const tagId = "dsh-prompt-forge/inline";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
  const style = document.createElement("style");
  style.setAttribute("data-plugin-css", tagId);
  style.textContent = css;
  document.head.appendChild(style);
}
exports.default = {"panel":"inline_panel","head":"inline_head","title":"inline_title","model":"inline_model","headRight":"inline_headRight","select":"inline_select","iconButton":"inline_iconButton","body":"inline_body","fold":"inline_fold","originalBox":"inline_originalBox","paneHead":"inline_paneHead","paneTitle":"inline_paneTitle","counter":"inline_counter","resultBox":"inline_resultBox","progress":"inline_progress","error":"inline_error","foot":"inline_foot","refineRow":"inline_refineRow","refineInput":"inline_refineInput","actions":"inline_actions","spacer":"inline_spacer","status":"inline_status","button":"inline_button","primary":"inline_primary","confirmBackdrop":"inline_confirmBackdrop","confirm":"inline_confirm","confirmTitle":"inline_confirmTitle","confirmBody":"inline_confirmBody","confirmActions":"inline_confirmActions"};
			},
			"src/client/optimizer.module.css": function (module, exports, require) {
			"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const css = "/*\n * dsh-prompt-forge — button and settings-page styles.\n *\n * The v2 inline panel has its own stylesheet (`inline.module.css`) because it\n * lives inside the composer card and needs its own layout rules. What remains\n * here is what the two surviving surfaces use:\n *   - `.toolButton` / `.toolLabel` — the composer tool-row button;\n *   - `.section` and everything below it — the settings page;\n *   - `.optimizer_select` / `.optimizer_input` / `.optimizer_button` / `.optimizer_primary` / `.optimizer_actions` — shared by the\n *     settings page, which is the only remaining consumer.\n *\n * Every color reads a shipped `--dsw-alias-*` token so the surfaces follow the\n * active light/dark theme instead of hard-coding a palette. Nothing here uses\n * `!important`.\n */\n\n/* ------------------------------------------------------------ composer button */\n\n.optimizer_toolButton {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  height: 24px;\n  padding: 0 8px;\n  border: 1px solid transparent;\n  border-radius: 6px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary);\n  font-size: 12px;\n  line-height: 1;\n  cursor: pointer;\n  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;\n}\n\n.optimizer_toolButton:hover:not(:disabled),\n.optimizer_toolButton[data-active='true'] {\n  background: var(--dsw-alias-bg-layer-2);\n  border-color: var(--dsw-alias-border-l1);\n  color: var(--dsw-alias-label-primary);\n}\n\n.optimizer_toolButton:disabled {\n  opacity: 0.45;\n  cursor: not-allowed;\n}\n\n.optimizer_toolButton:focus-visible {\n  outline: 2px solid var(--dsw-alias-brand-primary);\n  outline-offset: 1px;\n}\n\n.optimizer_toolLabel {\n  white-space: nowrap;\n}\n\n/* -------------------------------------------------- shared form controls */\n\n.optimizer_select,\n.optimizer_input {\n  border: 1px solid var(--dsw-alias-border-l1);\n  border-radius: 6px;\n  background: var(--dsw-alias-bg-layer-1);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  padding: 4px 6px;\n}\n\n.optimizer_select:focus-visible,\n.optimizer_input:focus-visible {\n  outline: 2px solid var(--dsw-alias-brand-primary);\n  outline-offset: 1px;\n}\n\n.optimizer_actions {\n  display: flex;\n  justify-content: flex-end;\n  gap: 8px;\n}\n\n.optimizer_button,\n.optimizer_primary {\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  height: 30px;\n  padding: 0 12px;\n  border: 1px solid var(--dsw-alias-border-l1);\n  border-radius: 6px;\n  background: var(--dsw-alias-bg-layer-1);\n  color: var(--dsw-alias-label-primary);\n  font-size: 12px;\n  cursor: pointer;\n}\n\n.optimizer_button:hover:not(:disabled) {\n  background: var(--dsw-alias-bg-layer-2);\n}\n\n.optimizer_primary {\n  border-color: transparent;\n  background: var(--dsw-alias-brand-primary);\n  color: #fff;\n  font-weight: 600;\n}\n\n.optimizer_primary:hover:not(:disabled) {\n  filter: brightness(1.06);\n}\n\n.optimizer_button:disabled,\n.optimizer_primary:disabled {\n  opacity: 0.45;\n  cursor: not-allowed;\n}\n\n/* -------------------------------------------------------- settings page */\n\n.optimizer_section {\n  display: flex;\n  flex-direction: column;\n  gap: 16px;\n  padding: 4px 2px 24px;\n}\n\n.optimizer_sectionDescription {\n  margin: 0;\n  color: var(--dsw-alias-label-secondary);\n  font-size: 12px;\n  line-height: 1.6;\n}\n\n.optimizer_fieldset {\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n  padding: 12px;\n  border: 1px solid var(--dsw-alias-border-l1);\n  border-radius: 10px;\n  background: var(--dsw-alias-bg-layer-1);\n}\n\n.optimizer_fieldsetTitle {\n  margin: 0;\n  font-size: 13px;\n  font-weight: 600;\n}\n\n.optimizer_field {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n}\n\n.optimizer_fieldLabel {\n  font-size: 12px;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.optimizer_fieldHint {\n  font-size: 11px;\n  color: var(--dsw-alias-label-secondary);\n  opacity: 0.85;\n}\n\n.optimizer_row {\n  display: flex;\n  gap: 10px;\n  align-items: flex-end;\n  flex-wrap: wrap;\n}\n\n.optimizer_grow {\n  flex: 1 1 220px;\n  min-width: 0;\n}\n\n.optimizer_promptArea {\n  width: 100%;\n  min-height: 130px;\n  resize: vertical;\n  padding: 8px 10px;\n  border: 1px solid var(--dsw-alias-border-l1);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  font-size: 12px;\n  line-height: 1.6;\n}\n\n.optimizer_presetCard {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  padding: 10px;\n  border: 1px solid var(--dsw-alias-border-l1);\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base);\n}\n\n.optimizer_presetHead {\n  display: flex;\n  gap: 8px;\n  align-items: center;\n}\n\n.optimizer_notice {\n  margin: 0;\n  padding: 8px 10px;\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-layer-2);\n  color: var(--dsw-alias-label-secondary);\n  font-size: 12px;\n}\n\n.optimizer_noticeError {\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.optimizer_statusLine {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  font-size: 12px;\n  color: var(--dsw-alias-state-success-primary);\n}\n\n.optimizer_checkboxRow {\n  display: flex;\n  align-items: flex-start;\n  gap: 8px;\n}\n\n.optimizer_checkboxRow input {\n  margin-top: 2px;\n}\n";
const tagId = "dsh-prompt-forge/optimizer";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
  const style = document.createElement("style");
  style.setAttribute("data-plugin-css", tagId);
  style.textContent = css;
  document.head.appendChild(style);
}
exports.default = {"select":"optimizer_select","input":"optimizer_input","button":"optimizer_button","primary":"optimizer_primary","actions":"optimizer_actions","toolButton":"optimizer_toolButton","toolLabel":"optimizer_toolLabel","section":"optimizer_section","sectionDescription":"optimizer_sectionDescription","fieldset":"optimizer_fieldset","fieldsetTitle":"optimizer_fieldsetTitle","field":"optimizer_field","fieldLabel":"optimizer_fieldLabel","fieldHint":"optimizer_fieldHint","row":"optimizer_row","grow":"optimizer_grow","promptArea":"optimizer_promptArea","presetCard":"optimizer_presetCard","presetHead":"optimizer_presetHead","notice":"optimizer_notice","noticeError":"optimizer_noticeError","statusLine":"optimizer_statusLine","checkboxRow":"optimizer_checkboxRow"};
			},
		};
		function __dshRequire(id) {
			var cached = __cache.get(id);
			if (cached !== undefined) return cached.exports;
			var factory = __modules[id];
			if (factory === undefined) throw new Error("dsh-prompt-forge: unknown bundled module " + id);
			var record = { exports: {} };
			__cache.set(id, record);
			factory(record, record.exports, __dshModuleRequire);
			return record.exports;
		}
		// A bundled factory calling require() must reach the platform table for
		// seeded specifiers and the internal registry for everything bundled.
		function __dshModuleRequire(id) {
			if (__modules[id] !== undefined) return __dshRequire(id);
			return require(id);
		}
		// The entry module owns the bundle's public exports. Dispatching it with
		// THIS module object (rather than a fresh record) is what makes the
		// loader see the real export surface.
		var __entryFactory = __modules["src/client/index.tsx"];
		if (__entryFactory === undefined) throw new Error("dsh-prompt-forge: entry module src/client/index.tsx is missing from the bundle");
		__cache.set("src/client/index.tsx", module);
		__entryFactory(module, exports, __dshModuleRequire);
		return module.exports;
	}
});
