import * as vscode from "vscode";
import * as path from "path";
import {
	blockRefString,
	checkSource,
	ensureBlockId,
	targetLine,
} from "./blockRef";
import { LibraryProvider, registerLibraryCommands } from "./library";
import {
	CodeManagerProvider,
	registerCodeManagerCommands,
	registerEntityCommands,
} from "./codeManager";
import {
	ThemeManagerProvider,
	registerThemeManagerCommands,
} from "./themeManager";
import { registerAgentWorkflowCommand } from "./agentWorkflow";

const EXCLUDE_GLOB =
	"{**/node_modules/**,**/.git/**,**/.obsidian/**,**/.lh/**}";

export function activate(context: vscode.ExtensionContext) {
	// ---- 侧边栏「块引用库」 ----
	const library = new LibraryProvider(context);
	const libraryView = vscode.window.createTreeView("mdqda.blockRefLibrary", {
		treeDataProvider: library,
		showCollapseAll: true,
	});
	context.subscriptions.push(libraryView);
	registerLibraryCommands(context, library);

	// ---- 侧边栏「编码管理」 ----
	const codeManager = new CodeManagerProvider(library);
	const codeView = vscode.window.createTreeView("mdqda.codeManager", {
		treeDataProvider: codeManager,
		showCollapseAll: true,
	});
	context.subscriptions.push(codeView);
	registerCodeManagerCommands(context, codeManager);

	// ---- 侧边栏「主题管理」 ----
	const themeManager = new ThemeManagerProvider(library);
	const themeView = vscode.window.createTreeView("mdqda.themeManager", {
		treeDataProvider: themeManager,
		showCollapseAll: true,
	});
	context.subscriptions.push(themeView);
	registerThemeManagerCommands(context, themeManager);

	// ---- Agent 工作流配置（AGENTS.md + 技能注入） ----
	registerAgentWorkflowCommand(context);

	// ---- 实体关系命令（加入/移出父实体、迁移旧 parent） ----
	registerEntityCommands(context);

	// 库内容随 Markdown 文件变化自动刷新
	const rescan = debounce(() => {
		void library.scan();
	}, 500);
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((d) => {
			if (d.languageId === "markdown") {
				rescan();
			}
		}),
		vscode.workspace.onDidCreateFiles(() => rescan()),
		vscode.workspace.onDidDeleteFiles(() => rescan()),
		vscode.workspace.onDidRenameFiles((e) => {
			library.onRename(e);
			rescan();
		}),
	);
	void library.scan();

	// ---- 复制块引用（仅复制到剪贴板） ----
	const copy = async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor || !checkSource(editor)) {
			return;
		}
		const id = await ensureBlockId(editor, targetLine(editor));
		const ref = blockRefString(editor.document.fileName, id);
		await vscode.env.clipboard.writeText(ref);
		vscode.window.showInformationMessage(
			vscode.l10n.t("Copied block reference: {0}", ref),
		);
	};

	// ---- 复制块引用至…（默认 Ctrl+Alt+B）：复制后选择目标文档并追加到末尾 ----
	const copyTo = async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor || !checkSource(editor)) {
			return;
		}
		const id = await ensureBlockId(editor, targetLine(editor));
		const ref = blockRefString(editor.document.fileName, id);
		await vscode.env.clipboard.writeText(ref);

		const target = await pickMarkdownFile(editor.document.uri);
		if (!target) {
			return; // 用户取消
		}
		await appendRefToFile(target, ref);
		vscode.window.showInformationMessage(
			vscode.l10n.t(
				"Copied block reference: {0}, appended to {1}",
				ref,
				vscode.workspace.asRelativePath(target, false),
			),
		);
		rescan();
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("mdqda.blockRef.copy", copy),
		vscode.commands.registerCommand("mdqda.blockRef.copyTo", copyTo),
	);
}

interface FilePickItem extends vscode.QuickPickItem {
	uri?: vscode.Uri;
	createPath?: string;
}

// 检索框：列出工作区 Markdown 文档；输入不存在的新路径（如 编码-压力.md）可创建
function pickMarkdownFile(source: vscode.Uri): Promise<vscode.Uri | undefined> {
	return new Promise((resolve) => {
		const roots = vscode.workspace.workspaceFolders;
		if (!roots || roots.length === 0) {
			vscode.window.showWarningMessage(
				vscode.l10n.t(
					"No workspace folder is open; cannot choose a target document",
				),
			);
			resolve(undefined);
			return;
		}
		void (async () => {
			const files = await vscode.workspace.findFiles(
				"**/*.md",
				EXCLUDE_GLOB,
				5000,
			);
			const baseItems: FilePickItem[] = files
				.filter((f) => f.toString() !== source.toString())
				.map((f) => ({
					label: path.basename(f.fsPath),
					description: vscode.workspace.asRelativePath(f, false),
					uri: f,
				}))
				.sort((a, b) =>
					(a.description ?? "").localeCompare(b.description ?? ""),
				);

			const qp = vscode.window.createQuickPick<FilePickItem>();
			qp.title = vscode.l10n.t("QDA: Copy Block Reference To…");
			qp.placeholder = vscode.l10n.t(
				"Select a Markdown document, or type a new path (e.g. codes-stress.md) to create",
			);
			qp.matchOnDescription = true;
			qp.items = baseItems;

			qp.onDidChangeValue((value) => {
				const v = value.trim();
				if (!v) {
					qp.items = baseItems;
					return;
				}
				const withExt = v.toLowerCase().endsWith(".md") ? v : v + ".md";
				if (
					baseItems.some(
						(i) => i.description === withExt || i.description === v,
					)
				) {
					qp.items = baseItems;
					return;
				}
				qp.items = [
					{
						label: "$(add) " + vscode.l10n.t("Create new file {0}", withExt),
						description: vscode.l10n.t(
							"This path does not exist; press Enter to create it",
						),
						createPath: withExt,
					},
					...baseItems,
				];
			});

			qp.onDidAccept(() => {
				const sel = qp.selectedItems[0];
				if (!sel) {
					return;
				}
				qp.hide();
				if (sel.createPath) {
					resolve(
						vscode.Uri.joinPath(roots[0].uri, ...sel.createPath.split("/")),
					);
				} else {
					resolve(sel.uri);
				}
			});
			qp.onDidHide(() => resolve(undefined));
			qp.show();
		})();
	});
}

// 把裸引用 [[文件#^id]] 追加到目标文档末尾（文件不存在则创建）
async function appendRefToFile(target: vscode.Uri, ref: string): Promise<void> {
	let exists = true;
	try {
		await vscode.workspace.fs.stat(target);
	} catch {
		exists = false;
	}

	if (!exists) {
		try {
			await vscode.workspace.fs.createDirectory(
				vscode.Uri.joinPath(target, ".."),
			);
		} catch {
			// 目录已存在时忽略
		}
		await vscode.workspace.fs.writeFile(
			target,
			Buffer.from(ref + "\n", "utf8"),
		);
	} else {
		const doc = await vscode.workspace.openTextDocument(target);
		const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
		const last = doc.lineAt(doc.lineCount - 1);
		let insertText: string;
		if (doc.lineCount === 1 && last.text === "") {
			insertText = ref; // 空文件：直接写入
		} else if (last.text === "") {
			insertText = ref + eol; // 文件末尾已有换行：补在末尾行
		} else {
			insertText = eol + ref + eol; // 末尾无换行：先换行再追加
		}
		const wsEdit = new vscode.WorkspaceEdit();
		wsEdit.insert(target, last.range.end, insertText);
		await vscode.workspace.applyEdit(wsEdit);
	}

	const doc = await vscode.workspace.openTextDocument(target);
	await vscode.window.showTextDocument(doc, {
		preview: true,
		preserveFocus: true,
	});
}

function debounce(fn: () => void, ms: number): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return () => {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		timer = setTimeout(() => {
			timer = undefined;
			fn();
		}, ms);
	};
}

export function deactivate() {}
