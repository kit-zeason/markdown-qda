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

// 实体类型标签（Obsidian 兼容的 frontmatter tags）
export const TAG_CODE = "code";
export const TAG_THEME = "theme";

export interface CodeFile {
	name: string; // 实体名 = 文件名去 .md
	uri: vscode.Uri;
	tags: string[]; // YAML frontmatter 的 tags（含 code = 编码，含 theme = 主题）
	definition?: string; // YAML frontmatter 的 definition
	parent?: string; // YAML frontmatter 的 parent（父实体名，无 = 根级）
	refs: CodeRef[]; // 去重后的块引用（仅编码实体提取）
	notes: Set<string>; // 覆盖的材料（去重）
}

export type CodeNode =
	| { type: "code"; code: CodeFile }
	| { type: "segment"; code: CodeFile; ref: CodeRef };

async function readText(uri: vscode.Uri): Promise<string> {
	return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
}

export interface QdaScanResult {
	codes: CodeFile[]; // tags 含 code
	themes: CodeFile[]; // tags 含 theme
}

// 工作区级扫描：解析全部 md 的 frontmatter，按 tags 分流实体。
// 只有编码实体才提取块引用（材料/主题跳过，控制成本）。
export async function scanQdaWorkspace(): Promise<QdaScanResult> {
	const result: QdaScanResult = { codes: [], themes: [] };
	if (
		!vscode.workspace.workspaceFolders ||
		vscode.workspace.workspaceFolders.length === 0
	) {
		return result;
	}
	let files: vscode.Uri[];
	try {
		files = await vscode.workspace.findFiles("**/*.md", EXCLUDE_GLOB, 5000);
	} catch {
		return result;
	}
	for (const uri of files) {
		let content: string;
		try {
			content = await readText(uri);
		} catch {
			continue; // 无法读取的文件跳过
		}
		const fm = parseFrontmatter(content);
		const base = {
			name: path.basename(uri.fsPath, ".md"),
			uri,
			tags: fm.tags,
			definition: fm.definition,
			parent: fm.parent,
		};
		if (fm.tags.includes(TAG_THEME)) {
			result.themes.push({ ...base, refs: [], notes: new Set() });
		} else if (fm.tags.includes(TAG_CODE)) {
			const refs = extractRefs(content, fm.bodyStart);
			result.codes.push({
				...base,
				refs,
				notes: new Set(refs.map((r) => r.note)),
			});
		}
	}
	for (const list of [result.codes, result.themes]) {
		list.sort((a, b) => a.name.localeCompare(b.name));
	}
	return result;
}

// 环校验：从 target 沿 parent 上溯，遇到 from 即成环
export function wouldCreateCycle(
	from: string,
	target: string,
	parentOf: (name: string) => string | undefined,
): boolean {
	let cur = target;
	const seen = new Set<string>();
	while (cur) {
		if (cur === from) {
			return true;
		}
		if (seen.has(cur)) {
			break;
		}
		seen.add(cur);
		cur = parentOf(cur) ?? "";
	}
	return false;
}

// 写实体文件的 parent 字段（空字符串 = 移出父级）
export async function writeEntityParent(
	uri: vscode.Uri,
	parentName: string,
): Promise<void> {
	const content = await readText(uri);
	const updated = setFrontmatterField(content, "parent", parentName);
	if (updated === content) {
		return;
	}
	const doc = await vscode.workspace.openTextDocument(uri);
	const full = new vscode.Range(
		doc.positionAt(0),
		doc.positionAt(doc.getText().length),
	);
	const wsEdit = new vscode.WorkspaceEdit();
	wsEdit.replace(uri, full, updated);
	await vscode.workspace.applyEdit(wsEdit);
}

// 覆写文件的 tags 字段（标记为编码/主题）
export async function setTagsOnFile(
	uri: vscode.Uri,
	tags: string[],
): Promise<void> {
	const content = await readText(uri);
	const updated = setFrontmatterField(content, "tags", `[${tags.join(", ")}]`);
	if (updated === content) {
		return;
	}
	const doc = await vscode.workspace.openTextDocument(uri);
	const full = new vscode.Range(
		doc.positionAt(0),
		doc.positionAt(doc.getText().length),
	);
	const wsEdit = new vscode.WorkspaceEdit();
	wsEdit.replace(uri, full, updated);
	await vscode.workspace.applyEdit(wsEdit);
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
		await writeEntityParent(code.uri, parentName);
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
		const { codes } = await scanQdaWorkspace();
		this.codes = codes;
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
			return this.roots.map((code) => ({ type: "code" as const, code }));
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
		vscode.commands.registerCommand("mdqda.codeManager.newCode", async () => {
			const roots = vscode.workspace.workspaceFolders;
			if (!roots || roots.length === 0) {
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
			const newName = name.trim();
			// 全工作区查重：文件名是块引用的主键，跨目录同名会导致解析歧义
			const dup = await findDuplicateName(newName);
			if (dup) {
				vscode.window.showWarningMessage(
					vscode.l10n.t("Code “{0}” already exists: {1}", newName, dup),
				);
				return;
			}
			const definition = await vscode.window.showInputBox({
				title: vscode.l10n.t("Definition for “{0}”", newName),
				placeHolder: vscode.l10n.t("One-line definition (optional)"),
			});
			const folder = await pickEntityFolder(vscode.l10n.t("QDA: New Code"));
			if (folder === undefined) {
				return;
			}
			const uri = vscode.Uri.joinPath(
				roots[0].uri,
				...(folder ? folder.split("/") : []),
				newName + ".md",
			);
			const content = `---\ntags: [${TAG_CODE}]\ndefinition: ${definition?.trim() ?? ""}\n---\n\n`;
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
				if (
					target &&
					wouldCreateCycle(
						from.name,
						target,
						(name) => provider.codeList.find((c) => c.name === name)?.parent,
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
					vscode.l10n.t("Generated: {0}", new Date().toLocaleString()),
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
		vscode.commands.registerCommand("mdqda.codeManager.markAsCodeBulk", () =>
			defineEntities(TAG_CODE),
		),
	);
}

// ---- 实体批量定义（定义为编码 / 定义为主题） ----

export type DefineTag = typeof TAG_CODE | typeof TAG_THEME;

export interface DefinePickItem extends vscode.QuickPickItem {
	uri?: vscode.Uri; // 文件条目
	folderRel?: string; // 文件夹条目（工作区相对路径）
}

// 批量定义实体：选中文件直接写入 tags；选中文件夹递归其下全部 md。
// 已声明任何实体标签的文件跳过（幂等，绝不覆盖既有声明）。
export async function defineEntities(tag: DefineTag): Promise<void> {
	const roots = vscode.workspace.workspaceFolders;
	if (!roots || roots.length === 0) {
		vscode.window.showWarningMessage(
			vscode.l10n.t("No workspace folder is open"),
		);
		return;
	}
	const root = roots[0];
	const tagLabel =
		tag === TAG_CODE ? vscode.l10n.t("code") : vscode.l10n.t("theme");
	const [files, dirs] = await Promise.all([
		vscode.workspace.findFiles("**/*.md", EXCLUDE_GLOB, 10000),
		(async () => {
			const out: (vscode.QuickPickItem & { value: string })[] = [];
			await collectDirs(root.uri, out);
			return out.sort((a, b) => a.value.localeCompare(b.value));
		})(),
	]);
	const items: DefinePickItem[] = [
		...dirs.map((d) => ({
			label: `$(folder) ${d.label.replace(/^\$\(folder\)\s*/, "")}`,
			description: d.value,
			folderRel: d.value,
		})),
		...files
			.map((f) => ({
				label: path.basename(f.fsPath),
				description: vscode.workspace.asRelativePath(f, false),
				uri: f,
			}))
			.sort((a, b) => (a.description ?? "").localeCompare(b.description ?? "")),
	];
	const qp = vscode.window.createQuickPick<DefinePickItem>();
	qp.title =
		tag === TAG_CODE
			? vscode.l10n.t("QDA: Define as Code")
			: vscode.l10n.t("QDA: Define as Theme");
	qp.placeholder = vscode.l10n.t(
		"Select Markdown files or folders; all Markdown files inside selected folders are included",
	);
	qp.canSelectMany = true;
	qp.matchOnDescription = true;
	qp.items = items;
	qp.onDidAccept(() => {
		void (async () => {
			const selected = qp.selectedItems;
			if (selected.length === 0) {
				return;
			}
			qp.hide();
			// 展开选中的文件夹条目：递归收集其下全部 md
			const targets = new Map<string, vscode.Uri>();
			for (const item of selected) {
				if (item.uri) {
					targets.set(item.uri.toString(), item.uri);
				} else if (item.folderRel !== undefined) {
					const glob = `${item.folderRel}/**/*.md`;
					for (const u of await vscode.workspace.findFiles(
						glob,
						EXCLUDE_GLOB,
						10000,
					)) {
						targets.set(u.toString(), u);
					}
				}
			}
			// 幂等：已声明任何实体标签的文件跳过，绝不覆盖
			const toMark: vscode.Uri[] = [];
			let skipped = 0;
			for (const uri of targets.values()) {
				try {
					const content = Buffer.from(
						await vscode.workspace.fs.readFile(uri),
					).toString("utf8");
					if (parseFrontmatter(content).tags.length > 0) {
						skipped++;
						continue;
					}
					toMark.push(uri);
				} catch {
					skipped++;
				}
			}
			if (toMark.length === 0) {
				vscode.window.showInformationMessage(
					vscode.l10n.t(
						"No files to define: all selected files already declare a code or theme tag",
					),
				);
				return;
			}
			const confirmLabel = vscode.l10n.t("Define");
			const ok = await vscode.window.showWarningMessage(
				vscode.l10n.t(
					"Define {0} Markdown file(s) as {1}? Files that already declare a code/theme tag are skipped.",
					toMark.length,
					tagLabel,
				) +
					(skipped > 0
						? "\n\n" +
							vscode.l10n.t(
								"{0} file(s) will be skipped (already tagged)",
								skipped,
							)
						: ""),
				{ modal: true },
				confirmLabel,
			);
			if (ok !== confirmLabel) {
				return;
			}
			let done = 0;
			for (const uri of toMark) {
				try {
					await setTagsOnFile(uri, [tag]);
					done++;
				} catch {
					// 单个文件写入失败不中断
				}
			}
			vscode.window.showInformationMessage(
				vscode.l10n.t(
					"Marked {0} file(s) as {1}; {2} skipped",
					done,
					tagLabel,
					skipped,
				),
			);
			await vscode.commands.executeCommand("mdqda.codeManager.refresh");
			await vscode.commands.executeCommand("mdqda.themeManager.refresh");
		})();
	});
	qp.show();
}

// 选择新建编码/主题文件的落点目录（默认项 = 工作区根 + 当前活动文件所在目录）
export async function pickEntityFolder(
	title: string,
): Promise<string | undefined> {
	const roots = vscode.workspace.workspaceFolders;
	if (!roots || roots.length === 0) {
		vscode.window.showWarningMessage(
			vscode.l10n.t("No workspace folder is open"),
		);
		return undefined;
	}
	const dirs: (vscode.QuickPickItem & { value: string })[] = [];
	await collectDirs(roots[0].uri, dirs);
	dirs.sort((a, b) => a.value.localeCompare(b.value));
	const items: (vscode.QuickPickItem & { value: string })[] = [
		{
			label: "$(root-folder) " + vscode.l10n.t("Workspace root"),
			description: vscode.l10n.t("Default"),
			value: "",
		},
	];
	const activeDir = activeFileFolderRel();
	if (activeDir) {
		items.push({
			label: "$(file-directory) " + activeDir,
			description: vscode.l10n.t("Folder of the active file"),
			value: activeDir,
		});
	}
	items.push(...dirs);
	const pick = await vscode.window.showQuickPick(items, {
		title,
		placeHolder: vscode.l10n.t("Select a folder for the new file"),
		matchOnDescription: true,
	});
	return pick?.value;
}

// 当前活动文件所在目录（工作区内相对路径；工作区外或为根时返回 undefined）
function activeFileFolderRel(): string | undefined {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return undefined;
	}
	const rel = vscode.workspace.asRelativePath(
		vscode.Uri.joinPath(editor.document.uri, ".."),
		false,
	);
	if (path.isAbsolute(rel) || rel === ".") {
		return undefined;
	}
	return rel;
}

// 全工作区查重：返回已存在同名文件的相对路径（不存在返回 undefined）
export async function findDuplicateName(
	name: string,
): Promise<string | undefined> {
	const files = await vscode.workspace.findFiles(
		`**/${name}.md`,
		EXCLUDE_GLOB,
		5,
	);
	return files.length > 0
		? vscode.workspace.asRelativePath(files[0], false)
		: undefined;
}
