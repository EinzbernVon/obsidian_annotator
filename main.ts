import {
    App,
    Plugin,
    PluginSettingTab,
    Setting,
    ItemView,
    WorkspaceLeaf,
    TFile,
    MarkdownView,
    Editor,
    Notice,
    Menu,
    Modal,
    setIcon,
    debounce,
} from "obsidian";

import {
    EditorView,
    Decoration,
    DecorationSet,
} from "@codemirror/view";

import {
    StateField,
    StateEffect,
    Range,
} from "@codemirror/state";

// ============================================================
//  Types & Interfaces
// ============================================================

interface Annotation {
    id: number;
    previewText: string;    // 纯文本（用于预览高亮匹配和反向定位）
    sourceText: string;     // 源码文本（含 wiki-link 语法）
    note: string;           // 批注内容
    sourceOffset: number;   // 源码起始偏移
    sourceEnd: number;      // 源码结束偏移
    filePath: string;       // 所属文件路径
}

interface AnnotationsData {
    version: string;
    sourceFile: string;
    annotations: Annotation[];
    exportDate: string;
}

interface AnnotatorSettings {
    sidecarFileName: string;
    enableTraceMode: boolean;
    autoLoadAnnotations: boolean;
}

const DEFAULT_SETTINGS: AnnotatorSettings = {
    sidecarFileName: ".annotations.json",
    enableTraceMode: false,
    autoLoadAnnotations: true,
};

// ============================================================
//  State Effects for CodeMirror decorations
// ============================================================

const setAnnotationsEffect = StateEffect.define<Annotation[]>();

// ============================================================
//  CodeMirror StateField for annotation decorations
// ============================================================

const annotationField = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(decorations, tr) {
        for (const effect of tr.effects) {
            if (effect.is(setAnnotationsEffect)) {
                const annos = effect.value;
                const marks: Range<Decoration>[] = [];
                const docLen = tr.state.doc.length;

                for (const anno of annos) {
                    const start = Math.max(0, anno.sourceOffset);
                    const end = Math.min(docLen, anno.sourceEnd);
                    if (start < end && start < docLen) {
                        marks.push(
                            Decoration.mark({
                                class: "cm-anno-highlight",
                                attributes: { "data-anno-id": String(anno.id) },
                            }).range(start, end)
                        );
                    }
                }

                marks.sort((a, b) => a.from - b.from);
                return Decoration.set(marks, true);
            }
        }

        if (tr.docChanged) {
            return decorations.map(tr.changes);
        }

        return decorations;
    },
    provide(field) {
        return EditorView.decorations.from(field);
    },
});

// ============================================================
//  Annotation Sidebar View
// ============================================================

const VIEW_TYPE_ANNOTATOR = "annotator-sidebar-view";

class AnnotatorSidebarView extends ItemView {
    plugin: AnnotatorPlugin;
    listEl: HTMLElement;
    countEl: HTMLElement;

    constructor(leaf: WorkspaceLeaf, plugin: AnnotatorPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string { return VIEW_TYPE_ANNOTATOR; }
    getDisplayText(): string { return "批注面板"; }
    getIcon(): string { return "message-square"; }

    async onOpen() {
        this.contentEl.empty();
        this.contentEl.addClass("annotator-sidebar");

        const header = this.contentEl.createDiv({ cls: "annotator-sidebar-header" });
        header.createSpan({ text: "💬 批注" });
        this.countEl = header.createSpan({ cls: "count-badge", text: "0" });

        const actions = this.contentEl.createDiv({
            style: "display:flex; gap:4px; padding:6px 8px; border-bottom:1px solid var(--background-modifier-border);"
        });

        const addBtn = actions.createEl("button", { text: "+ 批注", cls: "mod-cta" });
        addBtn.style.cssText = "flex:1; font-size:12px; padding:4px 8px;";
        addBtn.addEventListener("click", () => this.plugin.addAnnotationFromSelection());

        const traceBtn = actions.createEl("button", { text: "🔗 追踪", cls: "" });
        traceBtn.style.cssText = "flex:1; font-size:12px; padding:4px 8px;";
        traceBtn.addEventListener("click", () => {
            this.plugin.toggleTraceMode();
            traceBtn.toggleClass("mod-cta", this.plugin.traceMode);
        });

        this.listEl = this.contentEl.createDiv({ cls: "annotator-anno-list" });
        this.renderList();
    }

    async onClose() { this.contentEl.empty(); }

    renderList() {
        if (!this.listEl) return;
        this.listEl.empty();

        const annos = this.plugin.getAnnotationsForCurrentFile();
        this.countEl.textContent = String(annos.length);

        if (annos.length === 0) {
            this.listEl.createDiv({
                cls: "annotator-empty",
                text: "暂无批注\n\n选中文本后点击\"+ 批注\"\n或使用命令面板"
            });
            return;
        }

        for (const anno of annos) {
            const item = this.listEl.createDiv({ cls: "annotator-anno-item" });
            item.dataset.annoId = String(anno.id);

            const srcText = item.createDiv({ cls: "anno-source-text" });
            srcText.textContent = anno.sourceText.length > 80 ? anno.sourceText.slice(0, 80) + "..." : anno.sourceText;

            const note = item.createDiv({ cls: "anno-note" });
            note.textContent = anno.note;

            const delBtn = item.createEl("button", { cls: "anno-delete", text: "✕" });
            delBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.plugin.deleteAnnotation(anno.id);
            });

            item.addEventListener("click", () => this.plugin.focusAnnotation(anno.id));
            item.addEventListener("mouseenter", () => this.plugin.highlightAnnoInEditor(anno.id, true));
            item.addEventListener("mouseleave", () => this.plugin.highlightAnnoInEditor(anno.id, false));
        }
    }
}

// ============================================================
//  Annotation Modal
// ============================================================

class AnnotationModal extends Modal {
    plugin: AnnotatorPlugin;
    previewText: string;
    sourceText: string;
    sourceOffset: number;
    sourceEnd: number;
    noteInput: HTMLTextAreaElement;

    constructor(app: App, plugin: AnnotatorPlugin, previewText: string, sourceText: string, sourceOffset: number, sourceEnd: number) {
        super(app);
        this.plugin = plugin;
        this.previewText = previewText;
        this.sourceText = sourceText;
        this.sourceOffset = sourceOffset;
        this.sourceEnd = sourceEnd;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("annotator-modal");

        contentEl.createEl("h3", { text: "📌 添加批注" });

        contentEl.createEl("label", { text: "选中的文本：" });
        const selDiv = contentEl.createDiv({ cls: "selected-text" });
        selDiv.textContent = this.previewText.length > 200 ? this.previewText.slice(0, 200) + "..." : this.previewText;

        contentEl.createEl("label", { text: "批注内容：" });
        this.noteInput = contentEl.createEl("textarea");
        this.noteInput.placeholder = "输入你的批注...";
        setTimeout(() => this.noteInput.focus(), 100);

        const actions = contentEl.createDiv({ cls: "modal-actions" });
        const cancelBtn = actions.createEl("button", { text: "取消", cls: "btn-cancel" });
        cancelBtn.addEventListener("click", () => this.close());

        const confirmBtn = actions.createEl("button", { text: "确认 (Ctrl+Enter)", cls: "btn-confirm" });
        confirmBtn.addEventListener("click", () => this.confirm());

        this.noteInput.addEventListener("keydown", (e) => {
            if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); this.confirm(); }
            if (e.key === "Escape") this.close();
        });
    }

    confirm() {
        const note = this.noteInput.value.trim() || "(无批注内容)";
        this.plugin.confirmAnnotation({
            previewText: this.previewText,
            sourceText: this.sourceText,
            sourceOffset: this.sourceOffset,
            sourceEnd: this.sourceEnd,
            note,
        });
        this.close();
    }

    onClose() { this.contentEl.empty(); }
}

// ============================================================
//  Main Plugin Class
// ============================================================

export default class AnnotatorPlugin extends Plugin {
    settings: AnnotatorSettings = DEFAULT_SETTINGS;
    annotations: Map<string, Annotation[]> = new Map();
    nextId: number = 1;
    traceMode: boolean = false;
    lastActiveMarkdownView: MarkdownView | null = null;
    
    // ★ 新增：防抖保存函数
    debouncedSave: () => void;

    // 源码 ↔ 预览字符映射
    sourceToPreviewMap: number[] = [];
    previewToSourceMap: number[] = [];
    previewPlainText: string = "";

    async onload() {
        await this.loadSettings();

        // 初始化防抖保存 (300ms)
        this.debouncedSave = debounce(() => this.saveAnnotations(), 300, true);

        this.registerView(VIEW_TYPE_ANNOTATOR, (leaf) => new AnnotatorSidebarView(leaf, this));
        this.registerEditorExtension([annotationField]);

        const initialLeaf = this.app.workspace.getMostRecentLeaf();
        if (initialLeaf && initialLeaf.view instanceof MarkdownView) {
            this.lastActiveMarkdownView = initialLeaf.view;
        }

        // ---- 命令 ----
        this.addCommand({ id: "add-annotation", name: "添加批注 (选中文本)", editorCallback: () => this.addAnnotationFromSelection() });
        this.addCommand({ id: "toggle-trace-mode", name: "切换追踪模式", callback: () => this.toggleTraceMode() });
        this.addCommand({ id: "open-annotator-sidebar", name: "打开批注面板", callback: () => this.activateSidebar() });
        this.addCommand({ id: "save-annotations", name: "保存批注到 JSON", callback: () => this.saveAnnotations() });
        this.addCommand({ id: "load-annotations", name: "从 JSON 加载批注", callback: () => this.loadAnnotationsFromFile() });
        this.addCommand({ id: "delete-all-annotations", name: "删除当前文件的所有批注", callback: () => this.deleteAllAnnotations() });

        this.addRibbonIcon("message-square", "批注面板", () => this.activateSidebar());

        // 编辑器右键菜单
        this.registerEvent(
            this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
                if (editor.getSelection()) {
                    menu.addItem((item) => item.setTitle("📌 添加批注").setIcon("message-square").onClick(() => this.addAnnotationFromSelection()));
                }
            })
        );

        // ★ 核心修复：监听全局 mouseup，支持阅读模式下的选区批注
        this.registerDomEvent(document, "mouseup", (e: MouseEvent) => {
            // 忽略点击悬浮工具栏本身的事件
            if ((e.target as HTMLElement).closest(".annotator-floating-toolbar")) return;
            
            // 移除已存在的悬浮工具栏
            document.querySelectorAll(".annotator-floating-toolbar").forEach(el => el.remove());

            const selection = window.getSelection();
            if (!selection || selection.isCollapsed || !selection.toString().trim()) return;

            const range = selection.getRangeAt(0);
            const container = range.commonAncestorContainer;
            
            // 检查选区是否在 Reading View (阅读模式) 中
            const readingViewEl = (container.nodeType === Node.TEXT_NODE ? container.parentElement : container as HTMLElement)?.closest(".markdown-reading-view");
            
            if (readingViewEl) {
                this.showFloatingToolbar(selection.toString().trim(), range);
            }
        });

        // 监听活动视图变化
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", async (leaf) => {
                if (leaf && leaf.view instanceof MarkdownView) {
                    this.lastActiveMarkdownView = leaf.view;
                }
                if (this.settings.autoLoadAnnotations) {
                    await this.autoLoadAnnotations();
                }
                this.refreshEditorDecorations();
                this.refreshSidebar();
            })
        );

        this.registerMarkdownPostProcessor((el, ctx) => this.processReadingView(el, ctx));

        const statusEl = this.addStatusBarItem();
        statusEl.addClass("annotator-status");
        this.updateStatusBar(statusEl);

        this.addSettingTab(new AnnotatorSettingTab(this.app, this));
        console.log("MD Annotator plugin loaded");
    }

    onunload() {
        document.querySelectorAll(".annotator-floating-toolbar").forEach(el => el.remove());
        console.log("MD Annotator plugin unloaded");
    }

    // ============================================================
    //  ★ 阅读模式悬浮工具栏
    // ============================================================

    showFloatingToolbar(selectedText: string, range: Range) {
        const rect = range.getBoundingClientRect();
        const toolbar = document.createElement("div");
        toolbar.className = "annotator-floating-toolbar";
        
        const btn = toolbar.createEl("button", { text: "📌 添加批注" });
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            toolbar.remove();
            this.handleReadingViewSelection(selectedText);
        });

        document.body.appendChild(toolbar);
        
        // 定位在选区上方
        const top = rect.top - toolbar.offsetHeight - 8;
        const left = rect.left + (rect.width / 2) - (toolbar.offsetWidth / 2);
        toolbar.style.top = `${Math.max(10, top)}px`;
        toolbar.style.left = `${Math.max(10, left)}px`;
    }

    handleReadingViewSelection(previewText: string) {
        const mdView = this.getActiveMarkdownView();
        if (!mdView || !mdView.file) {
            new Notice("无法获取当前文件");
            return;
        }

        // 在阅读模式下，我们没有源码偏移量，所以传入 -1
        // 稍后在 repositionAnnotations 中会通过 previewText 反向查找源码位置
        new AnnotationModal(
            this.app,
            this,
            previewText,
            previewText, // sourceText 暂时用 previewText 代替
            -1,
            -1
        ).open();
    }

    // ============================================================
    //  智能获取 MarkdownView
    // ============================================================

    getActiveMarkdownView(): MarkdownView | null {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
            this.lastActiveMarkdownView = activeView;
            return activeView;
        }
        
        if (this.lastActiveMarkdownView) {
            const leaves = this.app.workspace.getLeavesOfType("markdown");
            if (leaves.some(leaf => leaf.view === this.lastActiveMarkdownView)) {
                return this.lastActiveMarkdownView;
            } else {
                this.lastActiveMarkdownView = null;
            }
        }
        
        const recentLeaf = this.app.workspace.getMostRecentLeaf();
        if (recentLeaf && recentLeaf.view instanceof MarkdownView) {
            this.lastActiveMarkdownView = recentLeaf.view;
            return recentLeaf.view;
        }
        
        return null;
    }

    // ============================================================
    //  Settings & Sidebar
    // ============================================================

    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
    async saveSettings() { await this.saveData(this.settings); }

    async activateSidebar() {
        const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATOR);
        if (existing.length > 0) { this.app.workspace.revealLeaf(existing[0]); return; }
        const leaf = this.app.workspace.getRightLeaf(false);
        if (leaf) {
            await leaf.setViewState({ type: VIEW_TYPE_ANNOTATOR });
            this.app.workspace.revealLeaf(leaf);
        }
    }

    refreshSidebar() {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATOR);
        for (const leaf of leaves) {
            const view = leaf.view as AnnotatorSidebarView;
            if (view && view.renderList) view.renderList();
        }
    }

    // ============================================================
    //  Annotation Data Management
    // ============================================================

    getCurrentFilePath(): string {
        const view = this.getActiveMarkdownView();
        if (view && view.file) return view.file.path;
        const file = this.app.workspace.getActiveFile();
        return file ? file.path : "";
    }

    getAnnotationsForCurrentFile(): Annotation[] { return this.annotations.get(this.getCurrentFilePath()) || []; }
    getAnnotationsForFile(filePath: string): Annotation[] { return this.annotations.get(filePath) || []; }
    setAnnotationsForFile(filePath: string, annos: Annotation[]) { this.annotations.set(filePath, annos); }

    // ============================================================
    //  源码 ↔ 预览字符映射
    // ============================================================

    buildCharMapping(sourceText: string) {
        const map = new Array(sourceText.length).fill(-1);
        let previewIdx = 0;
        let srcIdx = 0;

        while (srcIdx < sourceText.length) {
            const wikiMatch = this.matchWikiLinkAt(sourceText, srcIdx);
            if (wikiMatch) {
                const { fullEnd, displayStart, displayEnd } = wikiMatch;
                for (let i = displayStart; i < displayEnd; i++) map[i] = previewIdx++;
                srcIdx = fullEnd;
            } else {
                map[srcIdx] = previewIdx++;
                srcIdx++;
            }
        }

        this.sourceToPreviewMap = map;
        this.previewToSourceMap = new Array(previewIdx).fill(-1);
        for (let i = 0; i < map.length; i++) {
            if (map[i] >= 0) this.previewToSourceMap[map[i]] = i;
        }

        let plain = "";
        for (let i = 0; i < map.length; i++) {
            if (map[i] >= 0) plain += sourceText[i];
        }
        this.previewPlainText = plain;
    }

    matchWikiLinkAt(text: string, pos: number): { fullEnd: number; displayStart: number; displayEnd: number } | null {
        if (text[pos] !== "[" || text[pos + 1] !== "[") return null;
        const end = text.indexOf("]]", pos + 2);
        if (end === -1) return null;
        const inner = text.slice(pos + 2, end);
        const pipeIdx = inner.indexOf("|");
        let displayStart: number, displayEnd: number;
        if (pipeIdx !== -1) {
            displayStart = pos + 2 + pipeIdx + 1;
            displayEnd = end;
        } else {
            displayStart = pos + 2;
            displayEnd = end;
        }
        return { fullEnd: end + 2, displayStart, displayEnd };
    }

    getPreviewTextForSourceRange(sourceText: string, start: number, end: number): string {
        let result = "";
        for (let i = start; i < end && i < this.sourceToPreviewMap.length; i++) {
            if (this.sourceToPreviewMap[i] >= 0) result += sourceText[i];
        }
        return result;
    }

    // ============================================================
    //  Add & Delete Annotation (★ 增加自动保存)
    // ============================================================

    addAnnotationFromSelection() {
        const mdView = this.getActiveMarkdownView();
        if (!mdView) { new Notice("请先打开一个 Markdown 文件"); return; }

        const editor = mdView.editor;
        const selection = editor.getSelection();
        if (!selection || !selection.trim()) { new Notice("请先选中文本！"); return; }

        const from = editor.getCursor("from");
        const to = editor.getCursor("to");
        const sourceOffset = editor.posToOffset(from);
        const sourceEnd = editor.posToOffset(to);
        const sourceText = selection;

        const fullSource = editor.getValue();
        this.buildCharMapping(fullSource);
        const previewText = this.getPreviewTextForSourceRange(fullSource, sourceOffset, sourceEnd);

        if (!previewText.trim()) { new Notice("选中的内容在预览中没有对应文本"); return; }

        new AnnotationModal(this.app, this, previewText, sourceText, sourceOffset, sourceEnd).open();
    }

    confirmAnnotation(data: { previewText: string; sourceText: string; sourceOffset: number; sourceEnd: number; note: string }) {
        const filePath = this.getCurrentFilePath();
        if (!filePath) return;

        const anno: Annotation = {
            id: this.nextId++,
            previewText: data.previewText,
            sourceText: data.sourceText,
            note: data.note,
            sourceOffset: data.sourceOffset,
            sourceEnd: data.sourceEnd,
            filePath,
        };

        const annos = this.getAnnotationsForCurrentFile();
        annos.push(anno);
        this.setAnnotationsForFile(filePath, annos);

        this.refreshEditorDecorations();
        this.refreshSidebar();
        
        // ★ 自动保存
        this.debouncedSave();
        new Notice(`✅ 已添加批注 #${anno.id}`);
    }

    deleteAnnotation(id: number) {
        const filePath = this.getCurrentFilePath();
        if (!filePath) return;

        let annos = this.getAnnotationsForCurrentFile();
        annos = annos.filter((a) => a.id !== id);
        this.setAnnotationsForFile(filePath, annos);

        this.refreshEditorDecorations();
        this.refreshSidebar();
        
        // ★ 自动保存
        this.debouncedSave();
        new Notice(`🗑️ 已删除批注 #${id}`);
    }

    deleteAllAnnotations() {
        const filePath = this.getCurrentFilePath();
        if (!filePath) return;
        if (!confirm("确定删除当前文件的所有批注？")) return;

        this.setAnnotationsForFile(filePath, []);
        this.refreshEditorDecorations();
        this.refreshSidebar();
        
        // ★ 自动保存
        this.debouncedSave();
        new Notice("🗑️ 已删除所有批注");
    }

    // ============================================================
    //  Focus & Highlight
    // ============================================================

    focusAnnotation(id: number) {
        const mdView = this.getActiveMarkdownView();
        if (!mdView) return;

        const annos = this.getAnnotationsForCurrentFile();
        const anno = annos.find((a) => a.id === id);
        if (!anno || anno.sourceOffset < 0) return;

        const editor = mdView.editor;
        const from = editor.offsetToPos(anno.sourceOffset);
        const to = editor.offsetToPos(anno.sourceEnd);

        mdView.setEphemeralState({ line: from.line });
        setTimeout(() => {
            editor.setSelection(from, to);
            editor.scrollIntoView({ from, to }, true);
        }, 100);

        this.highlightAnnoInEditor(id, true);
        setTimeout(() => this.highlightAnnoInEditor(id, false), 2000);
        new Notice(`↗️ 跳转到批注 #${id}`);
    }

    highlightAnnoInEditor(id: number, on: boolean) {
        const mdView = this.getActiveMarkdownView();
        if (!mdView) return;
        const cmEditor = (mdView.editor as any).cm as EditorView;
        if (!cmEditor) return;

        const elements = cmEditor.dom.querySelectorAll(`.cm-anno-highlight[data-anno-id="${id}"]`);
        elements.forEach((el: Element) => {
            if (on) el.addClass("cm-anno-active");
            else el.removeClass("cm-anno-active");
        });
    }

    // ============================================================
    //  Trace Mode
    // ============================================================

    toggleTraceMode() {
        this.traceMode = !this.traceMode;
        new Notice(this.traceMode ? "🔗 追踪模式已开启" : "🔗 追踪模式已关闭");
        if (this.traceMode) this.registerTraceClickHandlers();
    }

    registerTraceClickHandlers() {
        this.registerDomEvent(document, "click", (e: MouseEvent) => {
            if (!this.traceMode) return;
            const cmAnno = (e.target as HTMLElement).closest(".cm-anno-highlight") as HTMLElement;
            if (cmAnno) {
                const annoId = parseInt(cmAnno.dataset.annoId || "0");
                if (annoId) { e.preventDefault(); this.focusAnnotationInSidebar(annoId); return; }
            }
            const previewAnno = (e.target as HTMLElement).closest(".anno-highlight") as HTMLElement;
            if (previewAnno) {
                const annoId = parseInt(previewAnno.dataset.annoId || "0");
                if (annoId) { e.preventDefault(); this.jumpToSourceFromPreview(annoId); return; }
            }
        });
    }

    focusAnnotationInSidebar(id: number) {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATOR);
        for (const leaf of leaves) {
            const view = leaf.view as AnnotatorSidebarView;
            if (view && view.listEl) {
                view.listEl.querySelectorAll(".annotator-anno-item").forEach((el) => {
                    el.removeClass("active");
                    if ((el as HTMLElement).dataset.annoId === String(id)) {
                        el.addClass("active");
                        el.scrollIntoView({ behavior: "smooth", block: "nearest" });
                    }
                });
            }
        }
    }

    jumpToSourceFromPreview(id: number) {
        const mdView = this.getActiveMarkdownView();
        if (!mdView) return;
        const annos = this.getAnnotationsForCurrentFile();
        const anno = annos.find((a) => a.id === id);
        if (!anno) return;

        mdView.setMode({ type: "source", source: false });
        setTimeout(() => {
            const editor = mdView.editor;
            const from = editor.offsetToPos(anno.sourceOffset);
            const to = editor.offsetToPos(anno.sourceEnd);
            editor.setSelection(from, to);
            editor.scrollIntoView({ from, to }, true);
            this.focusAnnotationInSidebar(id);
        }, 200);
    }

    // ============================================================
    //  Editor Decorations & Repositioning (★ 增强反向查找)
    // ============================================================

    refreshEditorDecorations() {
        const mdView = this.getActiveMarkdownView();
        if (!mdView) return;
        const cmEditor = (mdView.editor as any).cm as EditorView;
        if (!cmEditor) return;

        const annos = this.getAnnotationsForCurrentFile();
        this.repositionAnnotations(mdView.editor.getValue());

        cmEditor.dispatch({ effects: setAnnotationsEffect.of(annos) });

        const statusEl = document.querySelector(".annotator-status") as HTMLElement;
        if (statusEl) this.updateStatusBar(statusEl);
    }

    repositionAnnotations(sourceText: string) {
        const filePath = this.getCurrentFilePath();
        const annos = this.getAnnotationsForFile(filePath);
        this.buildCharMapping(sourceText);

        for (const anno of annos) {
            // 策略1: 用 sourceText 直接匹配
            if (anno.sourceText && anno.sourceOffset >= 0) {
                const idx = sourceText.indexOf(anno.sourceText);
                if (idx !== -1) {
                    anno.sourceOffset = idx;
                    anno.sourceEnd = idx + anno.sourceText.length;
                    anno.previewText = this.getPreviewTextForSourceRange(sourceText, idx, idx + anno.sourceText.length);
                    continue;
                }
            }

            // 策略2: ★ 用 previewText 在 previewPlainText 中查找 (解决阅读模式添加的批注)
            if (anno.previewText) {
                const prevIdx = this.previewPlainText.indexOf(anno.previewText);
                if (prevIdx !== -1) {
                    const srcStart = this.previewToSourceMap[prevIdx];
                    const srcEndIdx = prevIdx + anno.previewText.length - 1;
                    const srcEnd = srcEndIdx < this.previewToSourceMap.length ? this.previewToSourceMap[srcEndIdx] : -1;
                    
                    if (srcStart >= 0 && srcEnd >= 0) {
                        anno.sourceOffset = srcStart;
                        anno.sourceEnd = srcEnd + 1;
                        // 补全 sourceText
                        anno.sourceText = sourceText.slice(srcStart, srcEnd + 1);
                        continue;
                    }
                }
            }

            anno.sourceOffset = -1;
            anno.sourceEnd = -1;
        }

        this.setAnnotationsForFile(filePath, annos);
    }

    // ============================================================
    //  Reading View Post Processor
    // ============================================================

    processReadingView(el: HTMLElement, ctx: any) {
        const filePath = this.getCurrentFilePath();
        const annos = this.getAnnotationsForFile(filePath);
        if (annos.length === 0) return;

        const textNodes = this.collectTextNodes(el);
        if (textNodes.length === 0) return;

        let fullText = "";
        const entries: { node: Text; startInFull: number }[] = [];
        for (const tn of textNodes) {
            entries.push({ node: tn, startInFull: fullText.length });
            fullText += tn.textContent || "";
        }

        for (const anno of annos) {
            if (!anno.previewText) continue;
            this.highlightTextInDOM(fullText, entries, anno.previewText, anno.id);
        }
    }

    highlightTextInDOM(fullText: string, entries: { node: Text; startInFull: number }[], targetText: string, annoId: number) {
        let searchFrom = 0;
        while (true) {
            const idx = fullText.indexOf(targetText, searchFrom);
            if (idx === -1) break;
            const matchEnd = idx + targetText.length;

            const affected: { node: Text; localStart: number; localEnd: number }[] = [];
            for (const entry of entries) {
                const nodeLen = (entry.node.textContent || "").length;
                const nodeStart = entry.startInFull;
                const nodeEnd = nodeStart + nodeLen;
                if (nodeEnd <= idx || nodeStart >= matchEnd) continue;
                affected.push({
                    node: entry.node,
                    localStart: Math.max(0, idx - nodeStart),
                    localEnd: Math.min(nodeLen, matchEnd - nodeStart),
                });
            }

            if (affected.length === 0) { searchFrom = idx + 1; continue; }

            for (let i = affected.length - 1; i >= 0; i--) {
                const { node, localStart, localEnd } = affected[i];
                if (localStart >= localEnd) continue;
                const parent = node.parentNode;
                if (!parent) continue;
                if (parent instanceof HTMLElement && parent.classList.contains("anno-highlight")) continue;

                const text = node.textContent || "";
                const before = text.slice(0, localStart);
                const match = text.slice(localStart, localEnd);
                const after = text.slice(localEnd);

                const frag = document.createDocumentFragment();
                if (before) frag.appendChild(document.createTextNode(before));

                const mark = document.createElement("mark");
                mark.className = "anno-highlight";
                mark.dataset.annoId = String(annoId);
                mark.textContent = match;
                frag.appendChild(mark);

                if (after) frag.appendChild(document.createTextNode(after));
                parent.replaceChild(frag, node);
            }

            searchFrom = idx + targetText.length;
        }
    }

    collectTextNodes(root: HTMLElement): Text[] {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        const nodes: Text[] = [];
        let node: Node | null;
        while ((node = walker.nextNode())) nodes.push(node as Text);
        return nodes;
    }

    // ============================================================
    //  File I/O (Save / Load Annotations)
    // ============================================================

    async getAnnotationFilePath(): Promise<string | null> {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
            const view = this.getActiveMarkdownView();
            if (view && view.file) {
                return view.file.path.replace(/\.[^.]+$/, "") + this.settings.sidecarFileName;
            }
            return null;
        }
        return file.path.replace(/\.[^.]+$/, "") + this.settings.sidecarFileName;
    }

    async saveAnnotations() {
        const filePath = this.getCurrentFilePath();
        if (!filePath) return;

        const annos = this.getAnnotationsForCurrentFile();
        const jsonPath = await this.getAnnotationFilePath();
        if (!jsonPath) return;

        const data: AnnotationsData = {
            version: "1.0.0",
            sourceFile: filePath,
            annotations: annos,
            exportDate: new Date().toISOString(),
        };

        try {
            await this.app.vault.adapter.write(jsonPath, JSON.stringify(data, null, 2));
            // 静默保存，不弹 Notice 避免打扰
        } catch (err) {
            new Notice("保存批注失败: " + (err as Error).message);
        }
    }

    async loadAnnotationsFromFile() {
        const jsonPath = await this.getAnnotationFilePath();
        if (!jsonPath) { new Notice("没有打开的文件"); return; }

        try {
            const exists = await this.app.vault.adapter.exists(jsonPath);
            if (!exists) { new Notice("未找到批注文件"); return; }
            const raw = await this.app.vault.adapter.read(jsonPath);
            const data: AnnotationsData = JSON.parse(raw);
            if (data.annotations) {
                this.setAnnotationsForFile(this.getCurrentFilePath(), data.annotations);
                this.nextId = Math.max(...data.annotations.map((a) => a.id), 0) + 1;
                this.refreshEditorDecorations();
                this.refreshSidebar();
                new Notice(`📥 已加载 ${data.annotations.length} 条批注`);
            }
        } catch (err) {
            new Notice("加载失败: " + (err as Error).message);
        }
    }

    async autoLoadAnnotations() {
        const filePath = this.getCurrentFilePath();
        if (!filePath) return;

        const file = this.app.workspace.getActiveFile();
        let basePath = "";
        if (file) {
            basePath = file.path.replace(/\.[^.]+$/, "");
        } else {
            const view = this.getActiveMarkdownView();
            if (view && view.file) basePath = view.file.path.replace(/\.[^.]+$/, "");
            else return;
        }
        
        const jsonPath = basePath + this.settings.sidecarFileName;

        try {
            const exists = await this.app.vault.adapter.exists(jsonPath);
            if (!exists) return;
            const raw = await this.app.vault.adapter.read(jsonPath);
            const data: AnnotationsData = JSON.parse(raw);
            if (data.annotations) {
                this.setAnnotationsForFile(filePath, data.annotations);
                this.nextId = Math.max(...data.annotations.map((a) => a.id), this.nextId) + 1;
            }
        } catch (err) { /* 静默失败 */ }
    }

    // ============================================================
    //  Status Bar & Settings Tab
    // ============================================================

    updateStatusBar(el: HTMLElement) {
        const annos = this.getAnnotationsForCurrentFile();
        if (annos.length > 0) {
            el.textContent = `💬 ${annos.length} 批注`;
            el.addClass("has-annos");
        } else {
            el.textContent = "💬 无批注";
            el.removeClass("has-annos");
        }
    }
}

class AnnotatorSettingTab extends PluginSettingTab {
    plugin: AnnotatorPlugin;
    constructor(app: App, plugin: AnnotatorPlugin) { super(app, plugin); this.plugin = plugin; }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl("h2", { text: "MD Annotator 设置" });

        new Setting(containerEl)
            .setName("批注文件后缀")
            .setDesc("批注 JSON 文件的后缀名。例如 '.annotations.json'")
            .addText((text) => text.setPlaceholder(".annotations.json").setValue(this.plugin.settings.sidecarFileName).onChange(async (value) => {
                this.plugin.settings.sidecarFileName = value || ".annotations.json";
                await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName("自动加载批注")
            .setDesc("打开文件时自动加载对应的批注 JSON 文件")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.autoLoadAnnotations).onChange(async (value) => {
                this.plugin.settings.autoLoadAnnotations = value;
                await this.plugin.saveSettings();
            }));

        new Setting(containerEl)
            .setName("默认开启追踪模式")
            .setDesc("启动插件时默认开启追踪模式")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.enableTraceMode).onChange(async (value) => {
                this.plugin.settings.enableTraceMode = value;
                this.plugin.traceMode = value;
                await this.plugin.saveSettings();
            }));
    }
}