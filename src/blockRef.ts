import * as vscode from "vscode";
import * as path from "path";
import { BLOCK_ID_RE } from "./parse";

// 与 Obsidian 自动生成的块 ID 一致：6 位，字符集 a-z0-9（36 进制）
export function randomId(len: number): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let s = "";
	for (let i = 0; i < len; i++) {
		s += chars[Math.floor(Math.random() * chars.length)];
	}
	return s;
}

// 无选区时以光标所在行为块；有选区时以选区末行为块
export function targetLine(editor: vscode.TextEditor): vscode.TextLine {
	return editor.document.lineAt(
		editor.selection.isEmpty
			? editor.selection.active.line
			: editor.selection.end.line,
	);
}

// 检查当前文件是否可用（Markdown 且为磁盘文件）
export function checkSource(editor: vscode.TextEditor): boolean {
	const doc = editor.document;
	if (doc.languageId !== "markdown") {
		vscode.window.showWarningMessage(
			vscode.l10n.t("QDA Block Reference only supports Markdown files"),
		);
		return false;
	}
	if (doc.uri.scheme !== "file") {
		vscode.window.showWarningMessage(
			vscode.l10n.t("QDA Block Reference requires a saved local file"),
		);
		return false;
	}
	return true;
}

// 保证行尾有块 ID：已有则复用，没有则生成并写入（文件内查重）
export async function ensureBlockId(
	editor: vscode.TextEditor,
	line: vscode.TextLine,
): Promise<string> {
	const existing = line.text.match(BLOCK_ID_RE);
	if (existing) {
		return existing[1];
	}
	let id = randomId(6);
	const full = editor.document.getText();
	while (full.includes("^" + id)) {
		id = randomId(6);
	}
	await editor.edit((e) =>
		e.insert(new vscode.Position(line.lineNumber, line.text.length), " ^" + id),
	);
	return id;
}

// [[文件名#^id]]（Obsidian / Foam 块引用），filePath 传绝对路径或相对路径均可
export function blockRefString(filePath: string, id: string): string {
	const note = path.basename(filePath, ".md");
	return `[[${note}#^${id}]]`;
}
