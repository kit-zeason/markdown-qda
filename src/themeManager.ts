import * as vscode from "vscode";
import { buildEntityFrontmatter } from "./parse";
import {
	type CodeFile,
	type CodeNode,
	TAG_THEME,
	codeTooltip,
	countLabel,
	defineEntities,
	findDuplicateName,
	pickEntityFolder,
	replaceChildName,
	scanQdaWorkspace,
} from "./codeManager";
import type { LibraryProvider } from "./library";

// 主题管理视图：显示 tags 含 theme 的实体。
// 主题平铺不嵌套；theme 的 children 是它收录的编码，按下展开即列出这些编码（ADR-0007）。
export class ThemeManagerProvider implements vscode.TreeDataProvider<CodeNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<
		CodeNode | undefined | void
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private themes: CodeFile[] = [];
	private codesByName = new Map<string, CodeFile>(); // 实体名 → 编码（用于把 children 解析成编码节点）
	private childrenOf = new Map<string, CodeFile[]>(); // 主题名 → 直接收录的编码
	private codeChildren = new Map<string, number>(); // 编码名 → 它自己的子编码数（灰色参数用）
	private treeWarnings = new Map<string, string>();
	private scanChain: Promise<void> | undefined;
	private scanQueued = false;

	constructor(private readonly library: LibraryProvider) {
		// 与编码管理一致：块引用库扫描完成（= 文件集合稳定）时重建
		this.library.onDidScan(() => {
			void this.scan();
		});
	}

	get themeList(): CodeFile[] {
		return this.themes;
	}

	childCodes(theme: CodeFile): CodeFile[] {
		return this.childrenOf.get(theme.name) ?? [];
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	scan(): Promise<void> {
		if (this.scanChain) {
			this.scanQueued = true;
			return this.scanChain;
		}
		this.scanChain = this.doScan().finally(() => {
			this.scanChain = undefined;
			if (this.scanQueued) {
				this.scanQueued = false;
				void this.scan();
			}
		});
		return this.scanChain;
	}

	private async doScan(): Promise<void> {
		const { codes, themes, legacy } = await scanQdaWorkspace();
		this.themes = themes;
		this.codesByName = new Map(codes.map((c) => [c.name, c]));
		this.childrenOf = new Map();
		this.codeChildren = new Map();
		this.treeWarnings = new Map();
		// 编码自己的子编码数（灰色参数用，只统计能解析成编码的名字）
		for (const c of codes) {
			this.codeChildren.set(
				c.name,
				c.children.filter((n) => this.codesByName.has(n)).length,
			);
		}
		// theme 的 children 一律按编码解析；解析不到（主题 / 悬空 / 材料）不展开、标 ⚠
		for (const t of themes) {
			const kids: CodeFile[] = [];
			const ignored: string[] = [];
			for (const n of t.children) {
				const c = this.codesByName.get(n);
				if (c) {
					kids.push(c);
				} else {
					ignored.push(n);
				}
			}
			this.childrenOf.set(t.name, kids);
			if (ignored.length > 0) {
				this.treeWarnings.set(
					t.name,
					vscode.l10n.t(
						"Ignored (not a code): {0} — change its tags to `code`, or remove it from children",
						ignored.join(", "),
					),
				);
			}
		}
		// 旧 parent 字段残留：不静默丢层级，标 ⚠ 提示跑迁移
		const legacySet = new Set(legacy);
		for (const t of themes) {
			if (legacySet.has(t.name) && !this.treeWarnings.has(t.name)) {
				this.treeWarnings.set(
					t.name,
					vscode.l10n.t(
						"Legacy `parent` field found; run QDA: Migrate Parent to Children",
					),
				);
			}
		}
		await vscode.commands.executeCommand(
			"setContext",
			"mdqda.themeManager.hasThemes",
			this.themes.length > 0,
		);
		this.refresh();
	}

	getChildren(node?: CodeNode): CodeNode[] {
		// 主题平铺：主题之间没有层级，全部是根节点（ADR-0007）
		if (!node) {
			return this.themes.map((t) => ({
				type: "code" as const,
				code: t,
				path: t.name,
				depth: 0,
			}));
		}
		// 展开 = 该主题收录的编码；编码是叶子，不再下钻其子编码
		return (this.childrenOf.get(node.code.name) ?? []).map((c) => ({
			type: "code" as const,
			code: c,
			path: `${node.path}/${c.name}`,
			depth: node.depth + 1,
		}));
	}

	getTreeItem(node: CodeNode): vscode.TreeItem {
		const c = node.code;
		const warning = this.treeWarnings.get(c.name);
		// 主题下收录的编码：单击打开编码文件，块引用在文件里看
		if (!c.tags.includes(TAG_THEME)) {
			const item = new vscode.TreeItem(
				c.name,
				vscode.TreeItemCollapsibleState.None,
			);
			item.id = node.path;
			item.contextValue = "mdqdaCode";
			item.iconPath = new vscode.ThemeIcon("symbol-key");
			item.description = countLabel(
				c.refs.length,
				this.codeChildren.get(c.name) ?? 0,
			);
			item.tooltip = codeTooltip(c);
			item.command = {
				command: "mdqda.codeManager.openCodeFile",
				title: "",
				arguments: [node],
			};
			return item;
		}
		const kids = this.childrenOf.get(c.name) ?? [];
		const item = new vscode.TreeItem(
			c.name,
			kids.length > 0
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None,
		);
		item.id = node.path;
		item.contextValue = "mdqdaTheme";
		item.iconPath = new vscode.ThemeIcon(warning ? "warning" : "symbol-misc");
		item.description =
			vscode.l10n.t("{0} codes", kids.length) + (warning ? " ⚠" : "");
		item.tooltip = themeTooltip(c, warning, kids.length);
		// 单击 = 打开主题文件（复用编码文件的打开命令，参数同为 CodeNode）
		item.command = {
			command: "mdqda.codeManager.openCodeFile",
			title: "",
			arguments: [node],
		};
		return item;
	}
}

function themeTooltip(
	t: CodeFile,
	warning: string | undefined,
	codes: number,
): vscode.MarkdownString {
	const md = new vscode.MarkdownString();
	md.appendMarkdown(
		vscode.l10n.t("**{0}** · {1} codes", t.name, codes) + "\n\n",
	);
	md.appendMarkdown(
		t.definition ? t.definition : vscode.l10n.t("_(no definition)_"),
	);
	if (warning) {
		md.appendMarkdown(`\n\n⚠ ${warning}`);
	}
	return md;
}

export function registerThemeManagerCommands(
	context: vscode.ExtensionContext,
	provider: ThemeManagerProvider,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand("mdqda.themeManager.refresh", () =>
			provider.scan(),
		),
		vscode.commands.registerCommand("mdqda.themeManager.newTheme", async () => {
			const roots = vscode.workspace.workspaceFolders;
			if (!roots || roots.length === 0) {
				vscode.window.showWarningMessage(
					vscode.l10n.t("No workspace folder is open"),
				);
				return;
			}
			const name = await vscode.window.showInputBox({
				title: vscode.l10n.t("QDA: New Theme"),
				placeHolder: vscode.l10n.t("Theme name (e.g. technology acceptance)"),
				validateInput: (v) =>
					v && v.trim().length
						? undefined
						: vscode.l10n.t("Name cannot be empty"),
			});
			if (!name) {
				return;
			}
			const newName = name.trim();
			// 全工作区查重：文件名是块引用的主键，跨目录同名会导致解析歧义
			const dup = await findDuplicateName(newName);
			if (dup) {
				vscode.window.showWarningMessage(
					vscode.l10n.t("Theme “{0}” already exists: {1}", newName, dup),
				);
				return;
			}
			const definition = await vscode.window.showInputBox({
				title: vscode.l10n.t("Definition for theme “{0}”", newName),
				placeHolder: vscode.l10n.t("One-line definition (optional)"),
			});
			const folder = await pickEntityFolder(vscode.l10n.t("QDA: New Theme"));
			if (folder === undefined) {
				return;
			}
			const uri = vscode.Uri.joinPath(
				roots[0].uri,
				...(folder ? folder.split("/") : []),
				newName + ".md",
			);
			const content = buildEntityFrontmatter(TAG_THEME, definition);
			await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
			await provider.scan();
		}),
		vscode.commands.registerCommand(
			"mdqda.themeManager.renameTheme",
			async (node?: CodeNode) => {
				if (node?.type !== "code") {
					return;
				}
				const oldName = node.code.name;
				const name = await vscode.window.showInputBox({
					title: vscode.l10n.t("QDA: Rename Theme"),
					value: oldName,
					validateInput: (v) =>
						v && v.trim().length
							? undefined
							: vscode.l10n.t("Name cannot be empty"),
				});
				if (!name || name.trim() === oldName) {
					return;
				}
				const newName = name.trim();
				const newUri = vscode.Uri.joinPath(
					node.code.uri,
					"..",
					newName + ".md",
				);
				try {
					await vscode.workspace.fs.stat(newUri);
					vscode.window.showWarningMessage(
						vscode.l10n.t("Theme “{0}” already exists", newName),
					);
					return;
				} catch {
					// 目标不存在
				}
				const wsEdit = new vscode.WorkspaceEdit();
				wsEdit.renameFile(node.code.uri, newUri);
				await vscode.workspace.applyEdit(wsEdit);
				// 同步其它实体 children 里的旧名
				await replaceChildName(oldName, newName);
				await provider.scan();
			},
		),
		vscode.commands.registerCommand(
			"mdqda.themeManager.deleteTheme",
			async (node?: CodeNode) => {
				if (node?.type !== "code") {
					return;
				}
				const kidsCount = provider.childCodes(node.code).length;
				const deleteLabel = vscode.l10n.t("Delete");
				const pick = await vscode.window.showWarningMessage(
					vscode.l10n.t(
						"Delete theme “{0}”? The file will be moved to the recycle bin; source materials are unaffected.",
						node.code.name,
					) +
						(kidsCount > 0
							? vscode.l10n.t(
									"Its {0} codes stay untouched; they just leave this theme.",
									kidsCount,
								)
							: ""),
					{ modal: true },
					deleteLabel,
				);
				if (pick !== deleteLabel) {
					return;
				}
				await vscode.workspace.fs.delete(node.code.uri, {
					useTrash: true,
				});
				await provider.scan();
			},
		),
		vscode.commands.registerCommand("mdqda.themeManager.markAsThemeBulk", () =>
			defineEntities(TAG_THEME),
		),
	);
}
