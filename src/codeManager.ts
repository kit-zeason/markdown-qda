import * as vscode from "vscode";
import * as path from "path";
import {
	buildEntityFrontmatter,
	buildEntityGraph,
	extractRefs,
	parseFrontmatter,
	setFrontmatterField,
	setFrontmatterList,
} from "./parse";
import type { ParsedRef } from "./parse";
import { EXCLUDE_GLOB } from "./library";
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
	children: string[]; // YAML frontmatter 的 children（直接包含的实体名，可含悬空）
	refs: CodeRef[]; // 去重后的块引用（仅编码实体提取）
	notes: Set<string>; // 覆盖的材料（去重）
}

// 树节点只表达实体结构：编码节点（块引用片段不再进树，ADR-0007）
export interface CodeNode {
	type: "code";
	code: CodeFile;
	path: string;
	depth: number; // 0 = 顶层；1 = 展开出来的子实体（编码视图只展开一层）
}

// 灰色参数：块数（带单位）；顶层再追加直接子实体数
export function countLabel(blocks: number, children = 0): string {
	return children > 0
		? vscode.l10n.t("{0} blocks · {1} children", blocks, children)
		: vscode.l10n.t("{0} blocks", blocks);
}

async function readText(uri: vscode.Uri): Promise<string> {
	return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
}

export interface QdaScanResult {
	codes: CodeFile[]; // tags 含 code
	themes: CodeFile[]; // tags 含 theme
	legacy: string[]; // 仍带旧 parent 字段的实体名（提示迁移）
}

// 旧写法（单父 parent）残留检测：存在 parent: 值即提示迁移
const LEGACY_PARENT_RE = /^parent:\s*\S/m;

// 工作区级扫描：解析全部 md 的 frontmatter，按 tags 分流实体。
// 只有编码实体才提取块引用（材料/主题跳过，控制成本）。
export async function scanQdaWorkspace(): Promise<QdaScanResult> {
	const result: QdaScanResult = { codes: [], themes: [], legacy: [] };
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
			children: fm.children,
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
		} else {
			continue;
		}
		if (LEGACY_PARENT_RE.test(content.slice(0, fm.bodyStart))) {
			result.legacy.push(base.name);
		}
	}
	for (const list of [result.codes, result.themes]) {
		list.sort((a, b) => a.name.localeCompare(b.name));
	}
	return result;
}

// 环校验：把 child 加进 parent 的 children 会成环 ⇔ child 的子孙里有 parent
export function wouldCreateCycle(
	child: string,
	parent: string,
	childrenOf: (name: string) => string[],
): boolean {
	const stack = [child];
	const seen = new Set<string>();
	while (stack.length > 0) {
		const cur = stack.pop()!;
		if (cur === parent) {
			return true;
		}
		if (seen.has(cur)) {
			continue;
		}
		seen.add(cur);
		stack.push(...childrenOf(cur));
	}
	return false;
}

// 写实体文件的 children 列表（空数组 = 删除该字段）
export async function writeEntityChildren(
	uri: vscode.Uri,
	children: string[],
): Promise<void> {
	const content = await readText(uri);
	const updated = setFrontmatterList(content, "children", children);
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

// 全库替换 children 里的某个名字（改名、合并用）；返回改动的文件数
export async function replaceChildName(
	oldName: string,
	newName: string,
): Promise<number> {
	const { codes, themes } = await scanQdaWorkspace();
	let changed = 0;
	for (const e of [...codes, ...themes]) {
		if (!e.children.includes(oldName)) {
			continue;
		}
		const next = [...new Set(e.children.map((n) => (n === oldName ? newName : n)))];
		try {
			await writeEntityChildren(e.uri, next);
			changed++;
		} catch {
			// 单个文件写入失败不中断
		}
	}
	return changed;
}

// 覆写文件的 tags 字段（标记为编码/主题）：一律写成 YAML 块式列表
export async function setTagsOnFile(
	uri: vscode.Uri,
	tags: string[],
): Promise<void> {
	const content = await readText(uri);
	const updated = setFrontmatterList(content, "tags", tags);
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
	private themes: CodeFile[] = []; // 主题列表（导出与「加入父实体」的候选来源）
	private roots: CodeFile[] = []; // 根级编码（未被任何 children 引用 + 悬空/成环降级）
	private childrenOf = new Map<string, CodeFile[]>(); // 实体名 → 直接子实体
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

	get themeList(): CodeFile[] {
		return this.themes;
	}

	// 层级树的只读入口（导出编码本等使用）
	get rootCodes(): CodeFile[] {
		return this.roots;
	}

	childCodes(code: { name: string }): CodeFile[] {
		return this.childrenOf.get(code.name) ?? [];
	}

	treeWarning(code: CodeFile): string | undefined {
		return this.treeWarnings.get(code.name);
	}

	// 写实体文件的 children 列表（空数组 = 清空）
	async writeChildren(code: CodeFile, children: string[]): Promise<void> {
		await writeEntityChildren(code.uri, children);
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
		const { codes, themes, legacy } = await scanQdaWorkspace();
		this.codes = codes;
		this.themes = themes;
		// 构建实体图：父端 children 声明成员，同一编码可挂在多个父下（DAG）
		const codeNames = new Set(codes.map((c) => c.name));
		const graph = buildEntityGraph(
			codes,
			codeNames,
			"Child “{0}” is not a code; ignored",
		);
		const byName = new Map(codes.map((c) => [c.name, c]));
		this.roots = graph.roots
			.map((n) => byName.get(n))
			.filter((c): c is CodeFile => c !== undefined);
		this.childrenOf = new Map();
		for (const [p, kids] of graph.childrenOf) {
			this.childrenOf.set(
				p,
				kids
					.map((n) => byName.get(n))
					.filter((c): c is CodeFile => c !== undefined),
			);
		}
		this.treeWarnings = new Map(
			[...graph.warnings].map(([name, w]) => [
				name,
				vscode.l10n.t(w.template, ...w.args),
			]),
		);
		// 旧 parent 字段残留：不静默丢层级，标 ⚠ 提示跑迁移
		const legacySet = new Set(legacy);
		for (const c of codes) {
			if (legacySet.has(c.name) && !this.treeWarnings.has(c.name)) {
				this.treeWarnings.set(
					c.name,
					vscode.l10n.t(
						"Legacy `parent` field found; run QDA: Migrate Parent to Children",
					),
				);
			}
		}
		await vscode.commands.executeCommand(
			"setContext",
			"mdqda.codeManager.hasCodes",
			this.codes.length > 0,
		);
		this.refresh();
	}

	// 把 [[文件名#^id]] 解析成块（按 id 精确匹配；找不到返回 undefined）
	resolveRef(ref: CodeRef): BlockRef | undefined {
		return this.library
			.findRefsByBasename(ref.note)
			.find((r) => r.id === ref.id);
	}

	getChildren(node?: CodeNode): CodeNode[] {
		if (!node) {
			return this.roots.map((code) => ({
				type: "code" as const,
				code,
				path: code.name,
				depth: 0,
			}));
		}
		// 只显示子编码；块引用片段不进树（ADR-0007）。
		// path 参与 TreeItem id，保证一处多挂时展开状态互不干扰
		return (this.childrenOf.get(node.code.name) ?? []).map((code) => ({
			type: "code" as const,
			code,
			path: `${node.path}/${code.name}`,
			depth: node.depth + 1,
		}));
	}

	getTreeItem(node: CodeNode): vscode.TreeItem {
		const c = node.code;
		const warning = this.treeWarnings.get(c.name);
		const kids = this.childrenOf.get(c.name) ?? [];
		const top = node.depth === 0; // 只展开一层，子编码恒为叶子
		const item = new vscode.TreeItem(
			c.name,
			top && kids.length > 0
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None,
		);
		item.id = node.path; // DAG：同一编码可在多处出现，id 必须含父路径
		item.contextValue = "mdqdaCode";
		item.iconPath = new vscode.ThemeIcon(warning ? "warning" : "symbol-key");
		item.description = countLabel(c.refs.length, top ? kids.length : 0) + (warning ? " ⚠" : "");
		item.tooltip = codeTooltip(c, warning);
		// 单击 = 打开该编码文件（重命名/删除在右键菜单）
		item.command = {
			command: "mdqda.codeManager.openCodeFile",
			title: "",
			arguments: [node],
		};
		return item;
	}

	// 合并 from → to：from 的引用并入 to（去重），children 合并，全库对 from 的引用换成 to，删除 from 文件
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
		// from 的子实体并入 to，再把全库对 from 的引用换成 to
		const merged = [
			...new Set([...to.children, ...from.children]),
		].filter((n) => n !== to.name && n !== from.name);
		await writeEntityChildren(to.uri, merged);
		await replaceChildName(from.name, to.name);
		await vscode.workspace.fs.delete(from.uri, { useTrash: true });
		await this.scan();
	}
}

export function codeTooltip(c: CodeFile, warning?: string): vscode.MarkdownString {
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
	// 新建编码；给 parent 时顺带把它写进该父编码的 children（「在此编码下新建子编码」）
	const createCode = async (parent?: CodeFile): Promise<void> => {
		const roots = vscode.workspace.workspaceFolders;
		if (!roots || roots.length === 0) {
			vscode.window.showWarningMessage(
				vscode.l10n.t("No workspace folder is open"),
			);
			return;
		}
		const name = await vscode.window.showInputBox({
			title: parent
				? vscode.l10n.t("QDA: New Sub-code under “{0}”", parent.name)
				: vscode.l10n.t("QDA: New Code"),
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
		const content = buildEntityFrontmatter(TAG_CODE, definition);
		await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
		if (parent) {
			// 父端 children 声明成员；新文件刚落地，直接用父节点里已有的 children 追加
			await writeEntityChildren(parent.uri, [...parent.children, newName]);
		}
		await provider.scan();
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("mdqda.codeManager.refresh", () =>
			provider.scan(),
		),
		vscode.commands.registerCommand("mdqda.codeManager.newCode", () =>
			createCode(),
		),
		vscode.commands.registerCommand(
			"mdqda.codeManager.newChildCode",
			async (node?: CodeNode) => {
				if (node?.type !== "code") {
					return;
				}
				await createCode(node.code);
			},
		),
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
				// 同步其它实体 children 里的旧名（父端声明，改名必须全库替换）
				await replaceChildName(oldName, newName);
				await provider.scan();
			},
		),
		vscode.commands.registerCommand(
			"mdqda.codeManager.deleteCode",
			async (node?: CodeNode) => {
				if (node?.type !== "code") {
					return;
				}
				const kidsCount = provider.childCodes(node.code).length;
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
		// 编码 → 主题：只改 frontmatter tags，正文与块引用一字不动（父端 children 里的旧名保留，编码侧会标 ⚠）
		vscode.commands.registerCommand(
			"mdqda.codeManager.convertToTheme",
			async (node?: CodeNode) => {
				if (node?.type !== "code") {
					return;
				}
				const convertLabel = vscode.l10n.t("Convert to Theme");
				const pick = await vscode.window.showWarningMessage(
					vscode.l10n.t(
						"Convert “{0}” to a theme? Only the frontmatter `tags` changes — body and block references stay as they are.",
						node.code.name,
					),
					{ modal: true },
					convertLabel,
				);
				if (pick !== convertLabel) {
					return;
				}
				await setTagsOnFile(node.code.uri, [TAG_THEME]);
				await refreshViews();
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
				// 校验：目标不能是 from 的子编码（否则随 from 删除而脱挂）
				const kidsOf = (name: string) => provider.childCodes({ name });
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
		vscode.commands.registerCommand("mdqda.codeManager.exportAnalysis", () =>
			exportAnalysis(provider),
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

// ---- 三级导出：主题 → 编码 → 块 ----

// 导出为一份纯 Markdown 清单：每块给「链接 + 原文」，脱离插件也能读、可 diff。
// 主题层为空时自然退化为编码本（编码 → 块）。
async function exportAnalysis(provider: CodeManagerProvider): Promise<void> {
	const { codes, themes } = await scanQdaWorkspace();
	if (codes.length === 0 && themes.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t("Nothing to export"));
		return;
	}
	const codeByName = new Map(codes.map((c) => [c.name, c]));
	const themeByName = new Map(themes.map((t) => [t.name, t]));
	const allNames = new Set([...codeByName.keys(), ...themeByName.keys()]);
	const graph = buildEntityGraph(themes, allNames);
	const usedCodes = new Set<string>();
	const lines: string[] = [];
	const blockCount = codes.reduce((n, c) => n + c.refs.length, 0);

	lines.push(vscode.l10n.t("# Analysis summary"), "");
	lines.push(
		vscode.l10n.t(
			"> Generated by markdown-qda on {0} · {1} themes · {2} codes · {3} blocks",
			new Date().toISOString().slice(0, 10),
			themes.length,
			codes.length,
			blockCount,
		),
		"",
	);

	// 编码层递归：父编码本身可能没有块，证据在子编码里，所以沿 children 展开
	const emitCode = (
		c: CodeFile,
		indent: string,
		emitted: Set<string>,
	): void => {
		if (emitted.has(c.name)) {
			return; // 同一主题内不重复；跨主题允许重复（多父的不同切法）
		}
		emitted.add(c.name);
		usedCodes.add(c.name);
		lines.push(
			`${indent}- ${vscode.l10n.t("Code: {0} ({1} blocks)", c.name, c.refs.length)}`,
		);
		for (const ref of c.refs) {
			const hit = provider.resolveRef(ref);
			const text = hit
				? hit.text.replace(/\s+/g, " ").trim()
				: vscode.l10n.t("(source not found)");
			lines.push(`${indent}  - ${ref.raw} — ${text}`);
		}
		for (const child of c.children) {
			const sub = codeByName.get(child);
			if (sub) {
				emitCode(sub, indent + "  ", emitted);
			}
		}
	};

	const emitTheme = (name: string, depth: number, seen: Set<string>): void => {
		const t = themeByName.get(name);
		if (!t || seen.has(name)) {
			return;
		}
		seen.add(name);
		lines.push(
			`${"#".repeat(Math.min(depth + 2, 6))} ${vscode.l10n.t("Theme: {0}", t.name)}`,
			"",
		);
		if (t.definition) {
			lines.push(vscode.l10n.t("Definition: {0}", t.definition), "");
		}
		for (const child of t.children) {
			const c = codeByName.get(child);
			if (c) {
				emitCode(c, "", new Set<string>());
				continue;
			}
			if (themeByName.has(child)) {
				emitTheme(child, depth + 1, seen);
				continue;
			}
			lines.push(`- ⚠ ${vscode.l10n.t("Not found: {0}", child)}`);
		}
		lines.push("");
	};

	const seen = new Set<string>();
	for (const root of graph.roots) {
		emitTheme(root, 0, seen);
	}
	const rest = codes.filter((c) => !usedCodes.has(c.name));
	if (rest.length > 0) {
		lines.push(`## ${vscode.l10n.t("Codes not in any theme")}`, "");
		for (const c of rest) {
			emitCode(c, "", new Set<string>());
		}
		lines.push("");
	}

	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
	const target = await vscode.window.showSaveDialog({
		defaultUri: root
			? vscode.Uri.joinPath(root, `${stamp}-分析总表.md`)
			: undefined,
		filters: { Markdown: ["md"] },
	});
	if (!target) {
		return;
	}
	await vscode.workspace.fs.writeFile(
		target,
		Buffer.from(lines.join("\n"), "utf8"),
	);
	await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), {
		preview: true,
	});
}

// ---- 实体关系命令（两个视图共用） ----

async function refreshViews(): Promise<void> {
	await vscode.commands.executeCommand("mdqda.codeManager.refresh");
	await vscode.commands.executeCommand("mdqda.themeManager.refresh");
}

// 把实体加入某个父实体的 children；编码可进编码/主题，主题只能进主题
// 把编码加入某个父实体：kind 决定候选类型（code = 加进父编码，theme = 加进主题）
export function registerEntityCommands(context: vscode.ExtensionContext): void {
	const addToParent = async (
		node: CodeNode | undefined,
		kind: "code" | "theme",
	): Promise<void> => {
		if (node?.type !== "code") {
			return;
		}
		const source = node.code;
		// 主题不挂在任何实体下：主题只收录编码（ADR-0007）
		if (source.tags.includes(TAG_THEME)) {
			vscode.window.showInformationMessage(
				vscode.l10n.t(
					"“{0}” is a theme; themes cannot be a member of another entity",
					source.name,
				),
			);
			return;
		}
		const { codes, themes } = await scanQdaWorkspace();
		const pool = kind === "theme" ? themes : codes;
		const candidates = pool.filter((e) => e.name !== source.name);
		if (candidates.length === 0) {
			vscode.window.showInformationMessage(
				vscode.l10n.t("No candidate parents available"),
			);
			return;
		}
		const pick = await vscode.window.showQuickPick(
			candidates.map((e) => ({
				label: e.name,
				detail: e.definition,
				entity: e,
			})),
			{
				title:
					kind === "theme"
						? vscode.l10n.t("Add “{0}” to theme…", source.name)
						: vscode.l10n.t("Add “{0}” to code…", source.name),
				matchOnDetail: true,
			},
		);
		if (!pick) {
			return;
		}
		const target = pick.entity;
		if (target.children.includes(source.name)) {
			vscode.window.showInformationMessage(
				vscode.l10n.t(
					"“{0}” is already a child of “{1}”",
					source.name,
					target.name,
				),
			);
			return;
		}
		const childrenOf = new Map<string, string[]>();
		for (const e of [...codes, ...themes]) {
			childrenOf.set(e.name, e.children);
		}
		if (
			wouldCreateCycle(source.name, target.name, (n) => childrenOf.get(n) ?? [])
		) {
			vscode.window.showWarningMessage(
				vscode.l10n.t(
					"Cannot add “{0}” under “{1}”: this would create a cycle",
					source.name,
					target.name,
				),
			);
			return;
		}
		await writeEntityChildren(target.uri, [...target.children, source.name]);
		await refreshViews();
	};

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"mdqda.entity.addToCode",
			async (node?: CodeNode) => addToParent(node, "code"),
		),
		vscode.commands.registerCommand(
			"mdqda.entity.addToTheme",
			async (node?: CodeNode) => addToParent(node, "theme"),
		),
	);

	// 把编码从父实体移出；kind = "theme" 时只在主题里找（主题视图的「从主题移出」）
	const removeFromParent = async (
		node: CodeNode | undefined,
		kind?: "theme",
	): Promise<void> => {
		if (node?.type !== "code") {
			return;
		}
		const source = node.code;
		const { codes, themes } = await scanQdaWorkspace();
		const pool = kind === "theme" ? themes : [...codes, ...themes];
		const parents = pool.filter((e) => e.children.includes(source.name));
		if (parents.length === 0) {
			vscode.window.showInformationMessage(
				kind === "theme"
					? vscode.l10n.t("“{0}” is in no theme", source.name)
					: vscode.l10n.t("“{0}” has no parent", source.name),
			);
			return;
		}
		const pick = await vscode.window.showQuickPick(
			parents.map((e) => ({
				label: e.name,
				description: e.tags.includes(TAG_THEME)
					? vscode.l10n.t("theme")
					: vscode.l10n.t("code"),
				detail: e.definition,
				entity: e,
			})),
			{
				title:
					kind === "theme"
						? vscode.l10n.t("Remove “{0}” from theme…", source.name)
						: vscode.l10n.t("Remove “{0}” from…", source.name),
			},
		);
		if (!pick) {
			return;
		}
		await writeEntityChildren(
			pick.entity.uri,
			pick.entity.children.filter((n) => n !== source.name),
		);
		await refreshViews();
	};

	context.subscriptions.push(
		vscode.commands.registerCommand(
			"mdqda.entity.removeFromParent",
			async (node?: CodeNode) => removeFromParent(node),
		),
		vscode.commands.registerCommand(
			"mdqda.entity.removeFromTheme",
			async (node?: CodeNode) => removeFromParent(node, "theme"),
		),
		vscode.commands.registerCommand("mdqda.migrate.parentToChildren", () =>
			migrateLegacyParent(),
		),
	);
}

// 一次性迁移：旧 parent 字段 → 父实体的 children，并删除 parent 字段
async function migrateLegacyParent(): Promise<void> {
	const { codes, themes } = await scanQdaWorkspace();
	const all = [...codes, ...themes];
	const byName = new Map(all.map((e) => [e.name, e]));
	const additions = new Map<string, string[]>();
	let migrated = 0;
	for (const e of all) {
		const content = await readText(e.uri);
		const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!fm) {
			continue;
		}
		const line = fm[1]
			.split("\n")
			.find((l) => /^parent:\s*\S/.test(l));
		if (!line) {
			continue;
		}
		const parentName = line
			.replace(/^parent:\s*/, "")
			.replace(/^["']|["']$/g, "")
			.trim();
		if (parentName && byName.has(parentName)) {
			const list = additions.get(parentName) ?? [];
			list.push(e.name);
			additions.set(parentName, list);
		}
		const doc = await vscode.workspace.openTextDocument(e.uri);
		const full = new vscode.Range(
			doc.positionAt(0),
			doc.positionAt(doc.getText().length),
		);
		const wsEdit = new vscode.WorkspaceEdit();
		wsEdit.replace(e.uri, full, setFrontmatterField(content, "parent", ""));
		await vscode.workspace.applyEdit(wsEdit);
		migrated++;
	}
	for (const [name, kids] of additions) {
		const parent = byName.get(name);
		if (!parent) {
			continue;
		}
		await writeEntityChildren(parent.uri, [
			...new Set([...parent.children, ...kids]),
		]);
	}
	if (migrated === 0) {
		vscode.window.showInformationMessage(
			vscode.l10n.t("No legacy `parent` field found"),
		);
		return;
	}
	vscode.window.showInformationMessage(
		vscode.l10n.t(
			"Migrated {0} entity/entities from `parent` to `children`",
			migrated,
		),
	);
	await refreshViews();
}
