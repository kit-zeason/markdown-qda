import * as vscode from "vscode";
import * as path from "path";
import {
	buildCodeHierarchy,
	extractRefs,
	parseFrontmatter,
	setFrontmatterField,
} from "./parse";
import type { ParsedRef } from "./parse";
import { EXCLUDE_GLOB, snippetLabel } from "./library";
import type { BlockRef, LibraryProvider } from "./library";

export type CodeRef = ParsedRef; // [[note#^id]] 块引用

export interface CodeFile {
	name: string; // 编码名 = 文件名去 .md
	uri: vscode.Uri;
	definition?: string; // YAML frontmatter 的 definition
	parent?: string; // YAML frontmatter 的 parent（父编码名，无 = 根级）
	refs: CodeRef[]; // 去重后的块引用
	notes: Set<string>; // 覆盖的材料（去重）
}

export type CodeNode =
	| { type: "code"; code: CodeFile }
	| { type: "segment"; code: CodeFile; ref: CodeRef };

// ---- 编码文件夹解析（mdqda.codingFolder，留空 = 工作区根目录） ----
function codingFolderUri(): vscode.Uri | undefined {
	const roots = vscode.workspace.workspaceFolders;
	if (!roots || roots.length === 0) {
		return undefined;
	}
	const cfg =
		vscode.workspace
			.getConfiguration("mdqda")
			.get<string>("codingFolder")
			?.trim() ?? "";
	if (!cfg) {
		return roots[0].uri;
	}
	return vscode.Uri.joinPath(roots[0].uri, ...cfg.split("/"));
}

async function readText(uri: vscode.Uri): Promise<string> {
	return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
}

// 选择编码文件夹时跳过的无关目录（与 EXCLUDE_GLOB 保持一致）
const FOLDER_SKIP_DIRS = new Set([".git", "node_modules", ".obsidian"]);

// 递归收集工作区内全部文件夹（含子文件夹），候选值为相对路径
async function collectDirs(
	base: vscode.Uri,
	out: (vscode.QuickPickItem & { value: string })[],
): Promise<void> {
	const queue: { uri: vscode.Uri; rel: string }[] = [{ uri: base, rel: "" }];
	let head = 0;
	while (head < queue.length) {
		const { uri, rel } = queue[head++];
		let entries: [string, vscode.FileType][];
		try {
			entries = await vscode.workspace.fs.readDirectory(uri);
		} catch {
			continue; // 无法读取的目录跳过
		}
		for (const [name, type] of entries) {
			// 仅收普通目录；符号链接跳过以免循环
			if (type !== vscode.FileType.Directory || FOLDER_SKIP_DIRS.has(name)) {
				continue;
			}
			const childRel = rel ? `${rel}/${name}` : name;
			out.push({
				label: `$(folder) ${name}`,
				description: childRel,
				value: childRel,
			});
			queue.push({ uri: vscode.Uri.joinPath(uri, name), rel: childRel });
		}
	}
}

export class CodeManagerProvider implements vscode.TreeDataProvider<CodeNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<
		CodeNode | undefined | void
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private codes: CodeFile[] = [];
	private roots: CodeFile[] = []; // 根级编码（含悬空/成环降级）
	private childrenOf = new Map<string, CodeFile[]>(); // 父编码名 → 子编码
	private treeWarnings = new Map<string, string>(); // 编码名 → 警告说明（已本地化）
	private scanChain: Promise<void> | undefined;
	private scanQueued = false;

	constructor(private readonly library: LibraryProvider) {
		// 依赖块引用库的扫描结果来解析片段内容；库扫描完成时重建
		this.library.onDidScan(() => {
			void this.scan();
		});
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	get codeList(): CodeFile[] {
		return this.codes;
	}

	get currentFolder(): string {
		const folder = codingFolderUri();
		return folder
			? vscode.workspace.asRelativePath(folder, false)
			: vscode.l10n.t("(no workspace open)");
	}

	// 层级树的只读入口（导出编码本等使用）
	get rootCodes(): CodeFile[] {
		return this.roots;
	}

	childCodes(code: CodeFile): CodeFile[] {
		return this.childrenOf.get(code.name) ?? [];
	}

	treeWarning(code: CodeFile): string | undefined {
		return this.treeWarnings.get(code.name);
	}

	// 写编码文件的 parent 字段（空字符串 = 移出父级）
	async writeParent(code: CodeFile, parentName: string): Promise<void> {
		const content = await readText(code.uri);
		const updated = setFrontmatterField(content, "parent", parentName);
		if (updated === content) {
			return;
		}
		const doc = await vscode.workspace.openTextDocument(code.uri);
		const full = new vscode.Range(
			doc.positionAt(0),
			doc.positionAt(doc.getText().length),
		);
		const wsEdit = new vscode.WorkspaceEdit();
		wsEdit.replace(code.uri, full, updated);
		await vscode.workspace.applyEdit(wsEdit);
	}

	// 扫描编码文件夹：每个 md 文件 = 一个编码，解析 frontmatter 与块引用。
	// 串行化：并发触发时只排队补扫一次，避免旧扫描与本次扫描各自 append 造成重复条目
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
		this.codes = [];
		const folder = codingFolderUri();
		if (folder) {
			try {
				const files = await vscode.workspace.findFiles(
					new vscode.RelativePattern(folder, "*.md"),
					EXCLUDE_GLOB,
					5000,
				);
				for (const uri of files) {
					try {
						const content = await readText(uri);
						const { definition, parent, bodyStart } = parseFrontmatter(content);
						const refs = extractRefs(content, bodyStart);
						this.codes.push({
							name: path.basename(uri.fsPath, ".md"),
							uri,
							definition,
							parent,
							refs,
							notes: new Set(refs.map((r) => r.note)),
						});
					} catch {
						// 跳过无法读取的文件
					}
				}
			} catch {
				// 编码文件夹不存在
			}
		}
		this.codes.sort((a, b) => a.name.localeCompare(b.name));
		// 构建父子层级：悬空/成环/超深的编码降级为根级并记警告
		const tree = buildCodeHierarchy(this.codes);
		const byName = new Map(this.codes.map((c) => [c.name, c]));
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
			"mdqda.codeManager.hasCodes",
			this.codes.length > 0,
		);
		this.refresh();
	}

	// 把 [[文件名#^id]] 解析成块（重名时取第一处；找不到返回 undefined）
	resolveRef(ref: CodeRef): BlockRef | undefined {
		return this.library.findRefsByBasename(ref.note)[0];
	}

	getChildren(node?: CodeNode): CodeNode[] {
		if (!node) {
			return this.roots.map((code) => ({
				type: "code" as const,
				code,
			}));
		}
		if (node.type === "code") {
			// 子编码在前，片段在后
			const kids = (this.childrenOf.get(node.code.name) ?? []).map((code) => ({
				type: "code" as const,
				code,
			}));
			const segs = node.code.refs.map((ref) => ({
				type: "segment" as const,
				code: node.code,
				ref,
			}));
			return [...kids, ...segs];
		}
		return [];
	}

	getTreeItem(node: CodeNode): vscode.TreeItem {
		if (node.type === "code") {
			const c = node.code;
			const warning = this.treeWarnings.get(c.name);
			const hasChildren = (this.childrenOf.get(c.name) ?? []).length > 0;
			const item = new vscode.TreeItem(
				c.name,
				hasChildren || c.refs.length > 0
					? vscode.TreeItemCollapsibleState.Collapsed
					: vscode.TreeItemCollapsibleState.None,
			);
			item.contextValue = "mdqdaCode";
			item.iconPath = new vscode.ThemeIcon(warning ? "warning" : "symbol-key");
			item.description =
				vscode.l10n.t("{0} refs · {1} notes", c.refs.length, c.notes.size) +
				(warning ? " ⚠" : "");
			item.tooltip = codeTooltip(c, warning);
			// 单击 = 打开该编码文件（重命名/删除在右键菜单）
			item.command = {
				command: "mdqda.codeManager.openCodeFile",
				title: "",
				arguments: [node],
			};
			return item;
		}
		// 片段节点
		const ref = node.ref;
		const resolved = this.resolveRef(ref);
		const item = new vscode.TreeItem(
			resolved
				? snippetLabel(resolved.text)
				: vscode.l10n.t("Source not found: {0}", ref.raw),
			vscode.TreeItemCollapsibleState.None,
		);
		item.contextValue = "mdqdaCodeSegment";
		item.iconPath = new vscode.ThemeIcon("quote");
		item.description = resolved
			? `^${resolved.id} · ${resolved.file}`
			: ref.note;
		const tip = new vscode.MarkdownString();
		if (resolved) {
			tip.appendMarkdown(
				vscode.l10n.t("**{0}** line {1}", resolved.file, resolved.line + 1) +
					"\n\n",
			);
			tip.appendCodeblock(resolved.text.slice(0, 300), "markdown");
		} else {
			tip.appendMarkdown(
				vscode.l10n.t(
					"Cannot resolve {0} (the source file may have been deleted or the block ID is stale)",
					ref.raw,
				),
			);
		}
		item.tooltip = tip;
		item.command = {
			command: "mdqda.codeManager.revealSegment",
			title: "",
			arguments: [node],
		};
		return item;
	}

	// 合并 from → to：from 的引用并入 to（去重），from 的子编码改挂到 to，删除 from 文件
	async mergeCode(from: CodeFile, to: CodeFile): Promise<void> {
		const contentA = await readText(from.uri);
		const contentB = await readText(to.uri);
		const fmA = parseFrontmatter(contentA);
		const fmB = parseFrontmatter(contentB);
		const refsA = extractRefs(contentA, fmA.bodyStart).map((r) => r.raw);
		const refsB = extractRefs(contentB, fmB.bodyStart).map((r) => r.raw);
		const union = [...new Set([...refsB, ...refsA])];
		const head = fmB.bodyStart > 0 ? contentB.slice(0, fmB.bodyStart) : "";
		const newContent = (head ? head + "\n" : "") + union.join("\n") + "\n";

		const doc = await vscode.workspace.openTextDocument(to.uri);
		const full = new vscode.Range(
			doc.positionAt(0),
			doc.positionAt(doc.getText().length),
		);
		const wsEdit = new vscode.WorkspaceEdit();
		wsEdit.replace(to.uri, full, newContent);
		await vscode.workspace.applyEdit(wsEdit);
		// from 的子编码改挂到 to 名下
		for (const kid of this.codes.filter((c) => c.parent === from.name)) {
			try {
				await this.writeParent(kid, to.name);
			} catch {
				// 单个文件写入失败不中断合并
			}
		}
		await vscode.workspace.fs.delete(from.uri, { useTrash: true });
		await this.scan();
	}
}

function codeTooltip(c: CodeFile, warning?: string): vscode.MarkdownString {
	const md = new vscode.MarkdownString();
	md.appendMarkdown(
		vscode.l10n.t(
			"**{0}** · {1} refs · {2} notes",
			c.name,
			c.refs.length,
			c.notes.size,
		) + "\n\n",
	);
	md.appendMarkdown(
		c.definition ? c.definition : vscode.l10n.t("_(no definition)_"),
	);
	if (warning) {
		md.appendMarkdown(`\n\n⚠ ${warning}`);
	}
	return md;
}

export function registerCodeManagerCommands(
	context: vscode.ExtensionContext,
	provider: CodeManagerProvider,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand("mdqda.codeManager.refresh", () =>
			provider.scan(),
		),
		vscode.commands.registerCommand(
			"mdqda.codeManager.selectFolder",
			async () => {
				const roots = vscode.workspace.workspaceFolders;
				if (!roots || roots.length === 0) {
					vscode.window.showWarningMessage(
						vscode.l10n.t("No workspace folder is open"),
					);
					return;
				}
				const root = roots[0];
				const dirs: (vscode.QuickPickItem & { value: string })[] = [];
				await collectDirs(root.uri, dirs);
				dirs.sort((a, b) => a.value.localeCompare(b.value));
				const items: (vscode.QuickPickItem & { value?: string })[] = [
					{
						label: "$(root-folder) " + vscode.l10n.t("Workspace root"),
						description: vscode.l10n.t("Default"),
						value: "",
					},
					...dirs,
					{
						label: "$(edit) " + vscode.l10n.t("Type a relative path…"),
						description: vscode.l10n.t("e.g. 0-codes/subfolder"),
						value: "__input__",
					},
				];
				const pick = await vscode.window.showQuickPick(items, {
					title: vscode.l10n.t("QDA: Select Coding Folder"),
					placeHolder: vscode.l10n.t(
						"Type keywords to filter folders (matches name and path)",
					),
					matchOnDescription: true,
				});
				if (!pick) {
					return;
				}
				let value = pick.value;
				if (value === "__input__") {
					const input = await vscode.window.showInputBox({
						title: vscode.l10n.t("QDA: Select Coding Folder"),
						value:
							vscode.workspace
								.getConfiguration("mdqda")
								.get<string>("codingFolder") ?? "",
						placeHolder: vscode.l10n.t(
							"Relative to the workspace root; leave empty for root",
						),
					});
					if (input === undefined) {
						return;
					}
					value = input.trim();
					if (value) {
						const target = vscode.Uri.joinPath(root.uri, ...value.split("/"));
						try {
							await vscode.workspace.fs.stat(target);
						} catch {
							vscode.window.showWarningMessage(
								vscode.l10n.t("Folder does not exist: {0}", value),
							);
							return;
						}
					}
				}
				await vscode.workspace
					.getConfiguration("mdqda")
					.update("codingFolder", value, vscode.ConfigurationTarget.Workspace);
				await provider.scan();
			},
		),
		vscode.commands.registerCommand("mdqda.codeManager.newCode", async () => {
			const folder = codingFolderUri();
			if (!folder) {
				vscode.window.showWarningMessage(
					vscode.l10n.t("No workspace folder is open"),
				);
				return;
			}
			const name = await vscode.window.showInputBox({
				title: vscode.l10n.t("QDA: New Code"),
				placeHolder: vscode.l10n.t("Code name (e.g. coding density)"),
				validateInput: (v) =>
					v && v.trim().length
						? undefined
						: vscode.l10n.t("Name cannot be empty"),
			});
			if (!name) {
				return;
			}
			const definition = await vscode.window.showInputBox({
				title: vscode.l10n.t("Definition for “{0}”", name.trim()),
				placeHolder: vscode.l10n.t("One-line definition (optional)"),
			});
			const uri = vscode.Uri.joinPath(folder, name.trim() + ".md");
			try {
				await vscode.workspace.fs.stat(uri);
				vscode.window.showWarningMessage(
					vscode.l10n.t("Code “{0}” already exists", name.trim()),
				);
				return;
			} catch {
				// 目标不存在，可创建
			}
			const content = `---\ndefinition: ${definition?.trim() ?? ""}\n---\n\n`;
			await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
			await provider.scan();
		}),
		vscode.commands.registerCommand(
			"mdqda.codeManager.openCodeFile",
			async (node?: CodeNode) => {
				if (node?.type !== "code") {
					return;
				}
				const doc = await vscode.workspace.openTextDocument(node.code.uri);
				await vscode.window.showTextDocument(doc, { preview: true });
			},
		),
		vscode.commands.registerCommand(
			"mdqda.codeManager.setParent",
			async (node?: CodeNode) => {
				if (node?.type !== "code") {
					return;
				}
				const from = node.code;
				const others = provider.codeList.filter((c) => c.name !== from.name);
				if (others.length === 0) {
					vscode.window.showInformationMessage(
						vscode.l10n.t("No other codes available to set as parent"),
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
					...others.map((c) => ({
						label: c.name,
						description: vscode.l10n.t("{0} refs", c.refs.length),
						value: c.name,
					})),
				);
				const pick = await vscode.window.showQuickPick(items, {
					title: vscode.l10n.t("Set parent code for “{0}”", from.name),
					placeHolder: vscode.l10n.t(
						"Select a parent code; choose “Remove from parent” to cancel the relationship",
					),
				});
				if (!pick) {
					return;
				}
				const target = pick.value;
				// 校验：目标沿父链上溯不得经过自己（防成环）
				if (target) {
					let cur = target;
					const seen = new Set<string>();
					while (cur) {
						if (cur === from.name) {
							vscode.window.showWarningMessage(
								vscode.l10n.t(
									"Cannot set “{0}” as a child of “{1}”: this would create a cycle",
									from.name,
									target,
								),
							);
							return;
						}
						if (seen.has(cur)) {
							break;
						}
						seen.add(cur);
						const cf = provider.codeList.find((c) => c.name === cur);
						cur = cf?.parent ?? "";
					}
				}
				await provider.writeParent(from, target);
				await provider.scan();
			},
		),
		vscode.commands.registerCommand(
			"mdqda.codeManager.renameCode",
			async (node?: CodeNode) => {
				if (node?.type !== "code") {
					return;
				}
				const oldName = node.code.name;
				const name = await vscode.window.showInputBox({
					title: vscode.l10n.t("QDA: Rename Code"),
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
						vscode.l10n.t("Code “{0}” already exists", newName),
					);
					return;
				} catch {
					// 目标不存在
				}
				const wsEdit = new vscode.WorkspaceEdit();
				wsEdit.renameFile(node.code.uri, newUri);
				await vscode.workspace.applyEdit(wsEdit);
				// 同步子编码的 parent 字段（旧名 → 新名）
				for (const kid of provider.codeList.filter(
					(c) => c.parent === oldName,
				)) {
					try {
						await provider.writeParent(kid, newName);
					} catch {
						// 单个文件写入失败不中断重命名
					}
				}
				await provider.scan();
			},
		),
		vscode.commands.registerCommand(
			"mdqda.codeManager.deleteCode",
			async (node?: CodeNode) => {
				if (node?.type !== "code") {
					return;
				}
				const kidsCount = provider.codeList.filter(
					(c) => c.parent === node.code.name,
				).length;
				const deleteLabel = vscode.l10n.t("Delete");
				const pick = await vscode.window.showWarningMessage(
					vscode.l10n.t(
						"Delete code “{0}”? The file will be moved to the recycle bin; source materials are unaffected.",
						node.code.name,
					) +
						(kidsCount > 0
							? vscode.l10n.t(
									"Its {0} child codes will lose their parent and appear at the root level.",
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
		vscode.commands.registerCommand(
			"mdqda.codeManager.mergeCodes",
			async (node?: CodeNode) => {
				if (node?.type !== "code") {
					return;
				}
				const from = node.code;
				const others = provider.codeList.filter((c) => c.name !== from.name);
				if (others.length === 0) {
					vscode.window.showInformationMessage(
						vscode.l10n.t("No other codes to merge into"),
					);
					return;
				}
				const pick = await vscode.window.showQuickPick(
					others.map((c) => ({
						label: c.name,
						description: vscode.l10n.t("{0} refs", c.refs.length),
						code: c,
					})),
					{
						title: vscode.l10n.t("Merge “{0}” into…", from.name),
						placeHolder: vscode.l10n.t("Select target code"),
					},
				);
				if (!pick) {
					return;
				}
				// 校验：目标不能是 from 的子编码（否则随 from 删除而悬空）
				const kidsOf = (name: string) =>
					provider.codeList.filter((c) => c.parent === name);
				const isDescendant = (root: string, target: string): boolean => {
					const queue = [root];
					const seen = new Set<string>();
					while (queue.length > 0) {
						const cur = queue.shift()!;
						if (cur === target) {
							return true;
						}
						if (seen.has(cur)) {
							continue;
						}
						seen.add(cur);
						queue.push(...kidsOf(cur).map((c) => c.name));
					}
					return false;
				};
				if (isDescendant(from.name, pick.code.name)) {
					vscode.window.showWarningMessage(
						vscode.l10n.t(
							"Cannot merge “{0}” into its own child code “{1}”",
							from.name,
							pick.code.name,
						),
					);
					return;
				}
				const fromKidsCount = kidsOf(from.name).length;
				const mergeLabel = vscode.l10n.t("Merge");
				const ok = await vscode.window.showWarningMessage(
					vscode.l10n.t(
						"Merge “{0}” ({1} refs) into “{2}” ({3} refs)?\n\nReferences will be appended to the target code (deduplicated), the source code file will be deleted, and the target code's definition stays unchanged.",
						from.name,
						from.refs.length,
						pick.code.name,
						pick.code.refs.length,
					) +
						(fromKidsCount > 0
							? vscode.l10n.t(
									"\n\n{0} child code(s) of “{1}” will be re-parented under “{2}”.",
									fromKidsCount,
									from.name,
									pick.code.name,
								)
							: ""),
					{ modal: true },
					mergeLabel,
				);
				if (ok !== mergeLabel) {
					return;
				}
				await provider.mergeCode(from, pick.code);
			},
		),
		vscode.commands.registerCommand(
			"mdqda.codeManager.revealSegment",
			async (node?: CodeNode) => {
				if (node?.type !== "segment") {
					return;
				}
				const resolved = provider.resolveRef(node.ref);
				if (!resolved) {
					vscode.window.showWarningMessage(
						vscode.l10n.t(
							"Cannot resolve {0} (the source file may have been deleted or the block ID is stale)",
							node.ref.raw,
						),
					);
					return;
				}
				const doc = await vscode.workspace.openTextDocument(resolved.uri);
				const editor = await vscode.window.showTextDocument(doc, {
					preview: true,
				});
				const rng = doc.lineAt(resolved.line).range;
				editor.revealRange(rng, vscode.TextEditorRevealType.InCenter);
				editor.selection = new vscode.Selection(rng.start, rng.end);
			},
		),
		vscode.commands.registerCommand(
			"mdqda.codeManager.copySegmentRef",
			async (node?: CodeNode) => {
				if (node?.type !== "segment") {
					return;
				}
				await vscode.env.clipboard.writeText(node.ref.raw);
				vscode.window.showInformationMessage(
					vscode.l10n.t("Copied block reference: {0}", node.ref.raw),
				);
			},
		),
		vscode.commands.registerCommand(
			"mdqda.codeManager.exportCodebook",
			async () => {
				const codes = provider.codeList;
				if (codes.length === 0) {
					vscode.window.showInformationMessage(
						vscode.l10n.t("No codes to export"),
					);
					return;
				}
				const lines: string[] = [vscode.l10n.t("# Codebook"), ""];
				lines.push(
					vscode.l10n.t(
						"Generated: {0} (coding folder: {1})",
						new Date().toLocaleString(),
						provider.currentFolder,
					),
					"",
				);
				// 层级导出：根编码 ##，子编码逐级 ###/####…（上限 6 级标题）
				const walk = (list: CodeFile[], level: number) => {
					for (const c of list) {
						lines.push(
							`${"#".repeat(Math.min(level + 2, 6))} ${vscode.l10n.t("{0} ({1} refs · {2} notes)", c.name, c.refs.length, c.notes.size)}`,
							"",
						);
						if (c.definition) {
							lines.push(`> ${c.definition}`, "");
						}
						for (const r of c.refs) {
							lines.push(`- ${r.raw}`);
						}
						lines.push("");
						walk(provider.childCodes(c), level + 1);
					}
				};
				walk(provider.rootCodes, 0);
				const doc = await vscode.workspace.openTextDocument({
					language: "markdown",
					content: lines.join("\n"),
				});
				await vscode.window.showTextDocument(doc, { preview: true });
			},
		),
	);
}
