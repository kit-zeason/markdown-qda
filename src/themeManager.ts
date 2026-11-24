import * as vscode from "vscode";
import { buildEntityFrontmatter, buildEntityGraph } from "./parse";
import {
	type CodeFile,
	type CodeNode,
	TAG_THEME,
	defineEntities,
	findDuplicateName,
	pickEntityFolder,
	replaceChildName,
	scanQdaWorkspace,
} from "./codeManager";
import type { LibraryProvider } from "./library";

// 主题管理视图：显示 tags 含 theme 的实体。
// 关系与编码共用同一套 children（父端声明成员）机制，主题的成员可以是编码或子主题。
export class ThemeManagerProvider implements vscode.TreeDataProvider<CodeNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<
		CodeNode | undefined | void
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private themes: CodeFile[] = [];
	private roots: CodeFile[] = [];
	private childrenOf = new Map<string, CodeFile[]>(); // 子主题
	private codeCount = new Map<string, number>(); // 主题名 → 直接收录的编码数
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

	childThemes(theme: CodeFile): CodeFile[] {
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
		const codeNames = new Set(codes.map((c) => c.name));
		const allNames = new Set([...codeNames, ...themes.map((t) => t.name)]);
		// 主题图：成员可以是编码（不计入树）或子主题（递归展开）
		const graph = buildEntityGraph(themes, allNames);
		const byName = new Map(themes.map((t) => [t.name, t]));
		this.roots = graph.roots
			.map((n) => byName.get(n))
			.filter((t): t is CodeFile => t !== undefined);
		this.childrenOf = new Map();
		this.codeCount = new Map();
		for (const t of themes) {
			this.childrenOf.set(
				t.name,
				(t.children
					.map((n) => byName.get(n))
					.filter((x): x is CodeFile => x !== undefined)),
			);
			this.codeCount.set(
				t.name,
				t.children.filter((n) => codeNames.has(n)).length,
			);
		}
		this.treeWarnings = new Map(
			[...graph.warnings].map(([name, w]) => [
				name,
				vscode.l10n.t(w.template, ...w.args),
			]),
		);
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
		if (!node) {
			return this.roots.map((t) => ({
				type: "code" as const,
				code: t,
				path: t.name,
			}));
		}
		if (node.type !== "code") {
			return [];
		}
		return (this.childrenOf.get(node.code.name) ?? []).map((t) => ({
			type: "code" as const,
			code: t,
			path: `${node.path}/${t.name}`,
		}));
	}

	getTreeItem(node: CodeNode): vscode.TreeItem {
		if (node.type !== "code") {
			return new vscode.TreeItem("");
		}
		const t = node.code;
		const warning = this.treeWarnings.get(t.name);
		const kids = this.childrenOf.get(t.name) ?? [];
		const codes = this.codeCount.get(t.name) ?? 0;
		const item = new vscode.TreeItem(
			t.name,
			kids.length > 0
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None,
		);
		item.id = node.path;
		item.contextValue = "mdqdaTheme";
		item.iconPath = new vscode.ThemeIcon(warning ? "warning" : "symbol-misc");
		item.description =
			(kids.length > 0
				? vscode.l10n.t("{0} subthemes", kids.length) + " · "
				: "") +
			vscode.l10n.t("{0} codes", codes) +
			(warning ? " ⚠" : "");
		item.tooltip = themeTooltip(t, warning, codes);
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
				const kidsCount = provider.childThemes(node.code).length;
				const deleteLabel = vscode.l10n.t("Delete");
				const pick = await vscode.window.showWarningMessage(
					vscode.l10n.t(
						"Delete theme “{0}”? The file will be moved to the recycle bin; source materials are unaffected.",
						node.code.name,
					) +
						(kidsCount > 0
							? vscode.l10n.t(
									"Its {0} child themes will lose their parent and appear at the root level.",
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
