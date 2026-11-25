import * as vscode from "vscode";
import * as path from "path";
import { randomUUID } from "crypto";
import { BLOCK_ID_RE, collectBlockRefs } from "./parse";
import type { ParsedBlockRef } from "./parse";
import { blockRefString } from "./blockRef";

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 跳过超过 2MB 的 md 文件
export const EXCLUDE_GLOB =
	"{**/node_modules/**,**/.git/**,**/.obsidian/**,**/.lh/**}";
const STATE_PREFIX = "mdqda.blockRefLibrary.";

export interface BlockRef extends ParsedBlockRef {
	uri: vscode.Uri;
}

export interface FolderState {
	id: string;
	name: string;
	refs: string[]; // BlockRef.key（相对路径#id）
}

interface LibraryState {
	folders: FolderState[];
}

export type LibraryNode =
	| { type: "folder"; folder: FolderState }
	| { type: "snippet"; ref: BlockRef };

// 按工作区隔离状态，避免多项目之间互相污染
function workspaceKey(): string {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
	if (folder) {
		return folder;
	}
	return vscode.workspace.workspaceFile?.toString() ?? "single-file";
}

function snippetLabel(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > 48 ? oneLine.slice(0, 48) + "…" : oneLine;
}
export { snippetLabel };

function snippetTooltip(ref: BlockRef): vscode.MarkdownString {
	const md = new vscode.MarkdownString();
	const text = ref.text.length > 300 ? ref.text.slice(0, 300) + "…" : ref.text;
	md.appendMarkdown(
		vscode.l10n.t("**{0}** line {1}", ref.file, ref.line + 1) + "\n\n",
	);
	md.appendCodeblock(text, "markdown");
	md.appendMarkdown(`\n\`${blockRefString(ref.file, ref.id)}\``);
	return md;
}

export class LibraryProvider implements vscode.TreeDataProvider<LibraryNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<
		LibraryNode | undefined | void
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	// 每次扫描完成时触发（供编码管理等依赖块解析结果的功能使用）
	private readonly _onDidScan = new vscode.EventEmitter<void>();
	readonly onDidScan = this._onDidScan.event;

	private refs = new Map<string, BlockRef>();
	private byBasename = new Map<string, BlockRef[]>(); // 文件名（去扩展名）→ 块
	private state: LibraryState;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.state = this.context.globalState.get<LibraryState>(
			STATE_PREFIX + workspaceKey(),
		) ?? { folders: [] };
	}

	get folders(): FolderState[] {
		return this.state.folders;
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	saveState(): void {
		void this.context.globalState.update(
			STATE_PREFIX + workspaceKey(),
			this.state,
		);
	}

	// 扫描工作区全部 Markdown 文件，收集行尾带 ^id 的块
	async scan(): Promise<void> {
		const map = new Map<string, BlockRef>();
		const roots = vscode.workspace.workspaceFolders;
		if (roots && roots.length > 0) {
			const files = await vscode.workspace.findFiles(
				"**/*.md",
				EXCLUDE_GLOB,
				10000,
			);
			for (const uri of files) {
				try {
					const stat = await vscode.workspace.fs.stat(uri);
					if (stat.size > MAX_FILE_BYTES) {
						continue;
					}
					const bytes = await vscode.workspace.fs.readFile(uri);
					const rel = vscode.workspace.asRelativePath(uri, false);
					for (const r of collectBlockRefs(
						Buffer.from(bytes).toString("utf8"),
						rel,
					)) {
						map.set(r.key, { ...r, uri });
					}
				} catch {
					// 忽略无法读取的文件
				}
			}
		}
		this.refs = map;
		// 按文件名建立索引（Obsidian 块引用用的是不带路径的文件名）
		const byBasename = new Map<string, BlockRef[]>();
		for (const ref of this.refs.values()) {
			const base = path.basename(ref.file, ".md");
			const list = byBasename.get(base);
			if (list) {
				list.push(ref);
			} else {
				byBasename.set(base, [ref]);
			}
		}
		this.byBasename = byBasename;
		// 清理文件夹中已失效的引用（文件被删除或块 ID 消失）
		let dirty = false;
		for (const folder of this.state.folders) {
			const next = folder.refs.filter((k) => this.refs.has(k));
			if (next.length !== folder.refs.length) {
				folder.refs = next;
				dirty = true;
			}
		}
		if (dirty) {
			this.saveState();
		}
		await vscode.commands.executeCommand(
			"setContext",
			"mdqda.blockRefLibrary.hasRefs",
			this.refs.size > 0,
		);
		this.refresh();
		this._onDidScan.fire();
	}

	// 按 Obsidian 文件名（去扩展名）查找块；重名时取全部，由调用方决定用哪个
	findRefsByBasename(note: string): BlockRef[] {
		return this.byBasename.get(note) ?? [];
	}

	// 文件重命名时同步文件夹成员（相对路径#id → 新路径#id）
	onRename(event: vscode.FileRenameEvent): void {
		let changed = false;
		for (const f of event.files) {
			if (path.extname(f.oldUri.fsPath).toLowerCase() !== ".md") {
				continue;
			}
			const oldRel = vscode.workspace.asRelativePath(f.oldUri, false);
			const newRel = vscode.workspace.asRelativePath(f.newUri, false);
			if (oldRel === newRel) {
				continue;
			}
			for (const folder of this.state.folders) {
				const next = folder.refs.map((k) =>
					k.startsWith(oldRel + "#") ? newRel + k.slice(oldRel.length) : k,
				);
				if (next.some((k, i) => k !== folder.refs[i])) {
					folder.refs = next;
					changed = true;
				}
			}
		}
		if (changed) {
			this.saveState();
		}
	}

	addFolder(name: string): void {
		this.state.folders.push({ id: randomUUID(), name, refs: [] });
		this.saveState();
		this.refresh();
	}

	renameFolder(id: string, name: string): void {
		const folder = this.state.folders.find((f) => f.id === id);
		if (folder) {
			folder.name = name;
			this.saveState();
			this.refresh();
		}
	}

	deleteFolder(id: string): void {
		this.state.folders = this.state.folders.filter((f) => f.id !== id);
		this.saveState();
		this.refresh();
	}

	// folderId 为 undefined 时移回未分类
	assignSnippet(key: string, folderId: string | undefined): void {
		for (const folder of this.state.folders) {
			folder.refs = folder.refs.filter((k) => k !== key);
		}
		if (folderId) {
			const target = this.state.folders.find((f) => f.id === folderId);
			if (target && !target.refs.includes(key)) {
				target.refs.push(key);
			}
		}
		this.saveState();
		this.refresh();
	}

	// 从源文件中去掉行尾的块 ID（块从库中消失，引用它的 [[…]] 将失效）
	// 返回是否成功；行内已无块 ID（内容被改过）时返回 false。两种情况都会刷新列表。
	async deleteSnippet(ref: BlockRef): Promise<boolean> {
		const doc = await vscode.workspace.openTextDocument(ref.uri);
		const line = doc.lineAt(Math.min(ref.line, doc.lineCount - 1));
		const m = line.text.match(BLOCK_ID_RE);
		if (m) {
			// 删除范围：块文本结束位置 → 行尾（去掉整个 " ^id" 及尾部空白）
			const textEnd = line.text.slice(0, m.index).replace(/\s+$/, "").length;
			const wsEdit = new vscode.WorkspaceEdit();
			wsEdit.delete(
				ref.uri,
				new vscode.Range(
					new vscode.Position(line.lineNumber, textEnd),
					line.range.end,
				),
			);
			await vscode.workspace.applyEdit(wsEdit);
			this.assignSnippet(ref.key, undefined); // 从所有文件夹移除
		}
		await this.scan();
		return !!m;
	}

	getChildren(node?: LibraryNode): LibraryNode[] {
		if (!node) {
			return this.topLevel();
		}
		if (node.type === "folder") {
			return node.folder.refs
				.map((k) => this.refs.get(k))
				.filter((r): r is BlockRef => !!r)
				.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
				.map((ref) => ({ type: "snippet" as const, ref }));
		}
		return [];
	}

	private topLevel(): LibraryNode[] {
		const used = new Set(this.state.folders.flatMap((f) => f.refs));
		const unassigned = [...this.refs.values()]
			.filter((r) => !used.has(r.key))
			.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
			.map((ref) => ({ type: "snippet" as const, ref }));
		const folders: LibraryNode[] = this.state.folders.map((folder) => ({
			type: "folder",
			folder,
		}));
		return [...folders, ...unassigned];
	}

	getTreeItem(node: LibraryNode): vscode.TreeItem {
		if (node.type === "folder") {
			const count = node.folder.refs.filter((k) => this.refs.has(k)).length;
			const item = new vscode.TreeItem(
				node.folder.name,
				vscode.TreeItemCollapsibleState.Collapsed,
			);
			item.contextValue = "mdqdaFolder";
			item.iconPath = new vscode.ThemeIcon("folder");
			item.description = String(count);
			item.tooltip = vscode.l10n.t(
				"“{0}” · {1} snippets",
				node.folder.name,
				count,
			);
			return item;
		}
		const ref = node.ref;
		const item = new vscode.TreeItem(
			snippetLabel(ref.text),
			vscode.TreeItemCollapsibleState.None,
		);
		item.contextValue = "mdqdaSnippet";
		item.iconPath = new vscode.ThemeIcon("quote");
		item.description = `^${ref.id}`;
		item.tooltip = snippetTooltip(ref);
		item.command = {
			command: "mdqda.blockRefLibrary.revealSnippet",
			title: "",
			arguments: [node],
		};
		return item;
	}
}

export function registerLibraryCommands(
	context: vscode.ExtensionContext,
	provider: LibraryProvider,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand("mdqda.blockRefLibrary.focus", () => {
			void vscode.commands.executeCommand("workbench.view.extension.mdqda");
		}),
		vscode.commands.registerCommand("mdqda.blockRefLibrary.refresh", () =>
			provider.scan(),
		),
		vscode.commands.registerCommand(
			"mdqda.blockRefLibrary.newFolder",
			async () => {
				const name = await vscode.window.showInputBox({
					title: vscode.l10n.t("QDA: New Reference Folder"),
					placeHolder: vscode.l10n.t("Folder name"),
					validateInput: (v) =>
						v && v.trim().length
							? undefined
							: vscode.l10n.t("Name cannot be empty"),
				});
				if (name) {
					provider.addFolder(name.trim());
				}
			},
		),
		vscode.commands.registerCommand(
			"mdqda.blockRefLibrary.renameFolder",
			async (node?: LibraryNode) => {
				if (node?.type !== "folder") {
					return;
				}
				const name = await vscode.window.showInputBox({
					title: vscode.l10n.t("QDA: Rename Reference Folder"),
					value: node.folder.name,
					validateInput: (v) =>
						v && v.trim().length
							? undefined
							: vscode.l10n.t("Name cannot be empty"),
				});
				if (name) {
					provider.renameFolder(node.folder.id, name.trim());
				}
			},
		),
		vscode.commands.registerCommand(
			"mdqda.blockRefLibrary.deleteFolder",
			async (node?: LibraryNode) => {
				if (node?.type !== "folder") {
					return;
				}
				const deleteLabel = vscode.l10n.t("Delete");
				const pick = await vscode.window.showWarningMessage(
					vscode.l10n.t(
						"Delete folder “{0}”? Snippets inside will not be deleted; they will return to unassigned.",
						node.folder.name,
					),
					{ modal: true },
					deleteLabel,
				);
				if (pick === deleteLabel) {
					provider.deleteFolder(node.folder.id);
				}
			},
		),
		vscode.commands.registerCommand(
			"mdqda.blockRefLibrary.moveSnippet",
			async (node?: LibraryNode) => {
				if (node?.type !== "snippet") {
					return;
				}
				const folders = provider.folders;
				const options: vscode.QuickPickItem[] = folders.map((f) => ({
					label: f.name,
					description: vscode.l10n.t("{0} snippets", f.refs.length),
				}));
				options.push({
					label: vscode.l10n.t("(No folder)"),
					description: vscode.l10n.t("Move back to unassigned"),
					alwaysShow: true,
				});
				const pick = await vscode.window.showQuickPick(options, {
					title: vscode.l10n.t("QDA: Move Snippet"),
					placeHolder: vscode.l10n.t("Select a target folder"),
				});
				if (!pick) {
					return;
				}
				const target = folders.find((f) => f.name === pick.label);
				provider.assignSnippet(node.ref.key, target?.id);
			},
		),
		vscode.commands.registerCommand(
			"mdqda.blockRefLibrary.copySnippetRef",
			async (node?: LibraryNode) => {
				if (node?.type !== "snippet") {
					return;
				}
				const ref = blockRefString(node.ref.file, node.ref.id);
				await vscode.env.clipboard.writeText(ref);
				vscode.window.showInformationMessage(
					vscode.l10n.t("Copied block reference: {0}", ref),
				);
			},
		),
		// 删除块引用：从源文件中去掉行尾的 ^id 文本（需二次确认）
		vscode.commands.registerCommand(
			"mdqda.blockRefLibrary.deleteSnippet",
			async (node?: LibraryNode) => {
				if (node?.type !== "snippet") {
					return;
				}
				const ref = node.ref;
				const deleteLabel = vscode.l10n.t("Delete Block Reference");
				const pick = await vscode.window.showWarningMessage(
					vscode.l10n.t(
						"Remove block ID “^{1}” from source file {0}?\n\nThe block ID at the end of that line will be removed, and references to `{2}` will stop working.",
						ref.file,
						ref.id,
						blockRefString(ref.file, ref.id),
					),
					{ modal: true },
					deleteLabel,
				);
				if (pick !== deleteLabel) {
					return;
				}
				const ok = await provider.deleteSnippet(ref);
				if (ok) {
					vscode.window.showInformationMessage(
						vscode.l10n.t("Deleted block reference: ^{0}", ref.id),
					);
				} else {
					vscode.window.showInformationMessage(
						vscode.l10n.t(
							"The line no longer has a block ID (content may have been modified); the list has been refreshed",
						),
					);
				}
			},
		),
		vscode.commands.registerCommand(
			"mdqda.blockRefLibrary.revealSnippet",
			async (node?: LibraryNode) => {
				if (node?.type !== "snippet") {
					return;
				}
				const doc = await vscode.workspace.openTextDocument(node.ref.uri);
				const editor = await vscode.window.showTextDocument(doc, {
					preview: true,
				});
				const line = node.ref.line;
				const rng = doc.lineAt(line).range;
				editor.revealRange(rng, vscode.TextEditorRevealType.InCenter);
				editor.selection = new vscode.Selection(rng.start, rng.end);
			},
		),
	);
}
