import * as vscode from "vscode";
import { buildCodeHierarchy } from "./parse";
import {
	type CodeFile,
	type CodeNode,
	TAG_THEME,
	defineEntities,
	findDuplicateName,
	pickEntityFolder,
	scanQdaWorkspace,
	wouldCreateCycle,
	writeEntityParent,
} from "./codeManager";
import type { LibraryProvider } from "./library";

// 主题管理视图：显示 tags 含 theme 的实体。主题与编码共用 frontmatter 的
// parent 层级机制（buildCodeHierarchy），但主题正文是自由叙述而非块引用列表。
export class ThemeManagerProvider implements vscode.TreeDataProvider<CodeNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<
		CodeNode | undefined | void
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private themes: CodeFile[] = [];
	private roots: CodeFile[] = []; // 根级主题（含悬空/成环降级）
	private childrenOf = new Map<string, CodeFile[]>(); // 父主题名 → 子主题
	private treeWarnings = new Map<string, string>(); // 主题名 → 警告说明（已本地化）
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
		const { themes } = await scanQdaWorkspace();
		this.themes = themes;
		// 与编码共用同一套层级构建：悬空/成环/超深降级为根级并记警告
		const tree = buildCodeHierarchy(this.themes);
		const byName = new Map(this.themes.map((t) => [t.name, t]));
		this.roots = tree.roots.map((n) => byName.get(n)!);
		this.childrenOf = new Map();
		for (const [p, kids] of tree.childrenOf) {
			this.childrenOf.set(
				p,
				kids.map((n) => byName.get(n)!),
			);
		}
		this.treeWarnings = new Map(
			[...tree.warnings].map(([name, w]) => [
				name,
				vscode.l10n.t(w.template, ...w.args),
			]),
		);
		await vscode.commands.executeCommand(
			"setContext",
			"mdqda.themeManager.hasThemes",
			this.themes.length > 0,
		);
		this.refresh();
	}

	getChildren(node?: CodeNode): CodeNode[] {
		if (!node) {
			return this.roots.map((t) => ({ type: "code" as const, code: t }));
		}
		if (node.type === "code") {
			return (this.childrenOf.get(node.code.name) ?? []).map((t) => ({
				type: "code" as const,
				code: t,
			}));
		}
		return [];
	}

	getTreeItem(node: CodeNode): vscode.TreeItem {
		if (node.type !== "code") {
			return new vscode.TreeItem("");
		}
		const t = node.code;
		const warning = this.treeWarnings.get(t.name);
		const kids = this.childrenOf.get(t.name) ?? [];
		const item = new vscode.TreeItem(
			t.name,
			kids.length > 0
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None,
		);
		item.contextValue = "mdqdaTheme";
		item.iconPath = new vscode.ThemeIcon(warning ? "warning" : "symbol-misc");
		if (kids.length > 0) {
			item.description = vscode.l10n.t("{0} subthemes", kids.length);
		}
		item.tooltip = themeTooltip(t, warning);
		// 单击 = 打开主题文件（复用编码文件的打开命令，参数同为 CodeNode）
		item.command = {
			command: "mdqda.codeManager.openCodeFile",
			title: "",
			arguments: [node],
		};
		return item;
	}
}

function themeTooltip(t: CodeFile, warning?: string): vscode.MarkdownString {
	const md = new vscode.MarkdownString();
	md.appendMarkdown(vscode.l10n.t("**{0}**", t.name) + "\n\n");
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
			const content = `---\ntags: [${TAG_THEME}]\ndefinition: ${definition?.trim() ?? ""}\n---\n\n`;
			await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
			await provider.scan();
		}),
		vscode.commands.registerCommand(
			"mdqda.themeManager.setThemeParent",
			async (node?: CodeNode) => {
				if (node?.type !== "code") {
					return;
				}
				const from = node.code;
				const others = provider.themeList.filter((t) => t.name !== from.name);
				if (others.length === 0) {
					vscode.window.showInformationMessage(
						vscode.l10n.t("No other themes available to set as parent"),
					);
					return;
				}
				const items: (vscode.QuickPickItem & { value: string })[] = [];
				if (from.parent) {
					items.push({
						label: "$(close) " + vscode.l10n.t("Remove from parent"),
						description: vscode.l10n.t("Current parent: {0}", from.parent),
						value: "",
					});
				}
				items.push(
					...others.map((t) => ({
						label: t.name,
						description: t.definition ?? "",
						value: t.name,
					})),
				);
				const pick = await vscode.window.showQuickPick(items, {
					title: vscode.l10n.t("Set parent theme for “{0}”", from.name),
					placeHolder: vscode.l10n.t(
						"Select a parent theme; choose “Remove from parent” to cancel the relationship",
					),
				});
				if (!pick) {
					return;
				}
				const target = pick.value;
				if (
					target &&
					wouldCreateCycle(
						from.name,
						target,
						(name) => provider.themeList.find((t) => t.name === name)?.parent,
					)
				) {
					vscode.window.showWarningMessage(
						vscode.l10n.t(
							"Cannot set “{0}” as a child of “{1}”: this would create a cycle",
							from.name,
							target,
						),
					);
					return;
				}
				await writeEntityParent(from.uri, target);
				await provider.scan();
			},
		),
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
				// 同步子主题的 parent 字段（旧名 → 新名）
				for (const kid of provider.themeList.filter(
					(t) => t.parent === oldName,
				)) {
					try {
						await writeEntityParent(kid.uri, newName);
					} catch {
						// 单个文件写入失败不中断重命名
					}
				}
				await provider.scan();
			},
		),
		vscode.commands.registerCommand(
			"mdqda.themeManager.deleteTheme",
			async (node?: CodeNode) => {
				if (node?.type !== "code") {
					return;
				}
				const kidsCount = provider.themeList.filter(
					(t) => t.parent === node.code.name,
				).length;
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
