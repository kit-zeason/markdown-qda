import * as vscode from 'vscode';
import * as path from 'path';

// Obsidian 手动块 ID 允许字母、数字、连字符（不允许下划线/空格）
const BLOCK_ID_RE = /\s+\^([a-zA-Z0-9-]+)\s*$/;

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.commands.registerCommand(
        'qda.blockRef.copy', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            const doc = editor.document;
            if (doc.languageId !== 'markdown') {
                vscode.window.showWarningMessage('QDA Block Reference 仅支持 Markdown 文件');
                return;
            }

            // 无选区时以光标所在行为块；有选区时以选区末行为块
            const line = doc.lineAt(editor.selection.isEmpty
                ? editor.selection.active.line
                : editor.selection.end.line);

            // 该行行尾已有 ^id 则复用（"有码则跳过"）
            const existing = line.text.match(BLOCK_ID_RE);
            let id: string;
            if (existing) {
                id = existing[1];
            } else {
                id = randomId(6);
                // 文件内查重，避免与已有块 ID 冲突（Obsidian 文件内重复 ID 不可靠）
                const full = doc.getText();
                while (full.includes('^' + id)) {
                    id = randomId(6);
                }
                await editor.edit((e) => e.insert(
                    new vscode.Position(line.lineNumber, line.text.length),
                    ' ^' + id
                ));
            }

            const note = path.basename(doc.fileName, '.md');
            const ref = `[[${note}#^${id}]]`;
            await vscode.env.clipboard.writeText(ref);
            vscode.window.showInformationMessage(`已复制块引用：${ref}`);
        })
    );
}

// 与 Obsidian 自动生成的块 ID 一致：6 位，字符集 a-z0-9（36 进制）
function randomId(len: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < len; i++) {
        s += chars[Math.floor(Math.random() * chars.length)];
    }
    return s;
}

export function deactivate() { }
