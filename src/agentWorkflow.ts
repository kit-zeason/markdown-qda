import * as vscode from "vscode";

// QDA 技能模板（templates/agent-skills/ 下的目录名）
const SKILL_NAMES = [
	"qda-natural-coding",
	"qda-theoretical-coding",
	"qda-thematic-synthesis",
];

// 目标 agent 技能目录清单（相对工作区根）；note 说明覆盖的 agent。
// 不追求探测所有 agent：固定清单 + 探测已存在目录默认勾选。
const AGENT_TARGETS = [
	{ dir: ".agents/skills", note: "pi · dsh · agents.md 规范系" },
	{ dir: ".claude/skills", note: "Claude Code" },
	{ dir: ".pi/skills", note: "pi（项目级）" },
	{ dir: ".dsh/skills", note: "DeepSeek Harness（项目级）" },
];

// AGENTS.md 段落标记（幂等依据）
const AGENTS_MARK = "## QDA Agent Workflow";

// 写入根 AGENTS.md 的 QDA 协作规则段（给任意 agent 读取，不依赖具体工具）
const AGENTS_SECTION = `## QDA Agent Workflow

本项目的 QDA 实体由 markdown-qda 扩展定义。Agent 协作时遵守：

- **实体类型**：frontmatter 的 \`tags\` 声明——\`code\` 编码、\`theme\` 主题、\`material\` 材料（约定）。类型由标签决定，不由目录决定。
- **frontmatter 格式**：\`tags\` 一律写成 YAML 块式列表（\`tags:\` / \`  - code\`），不得写成内联数组 \`tags: [code]\`（Obsidian 官方要求 tags 为 YAML 列表）；\`definition\` 为标量字段；\`children\` 为父端声明的成员列表（YAML 列表，纯实体名）。
- **块引用**：\`[[文件名#^id]]\`（文件名去扩展名）。块 ID 为 6 位 a-z0-9，行尾前置一个空格（\` ^xxxxxx\`）；已有 \`^id\` 直接复用，新 ID 全文查重。
- **编码文件**：正文 = 块引用列表；\`definition\` 一句话定义；\`children\` 列出它直接包含的编码。同一编码可出现在多个父编码的 \`children\` 里（多父，用于并行试多套编码架构），但不得成环。
- **主题文件**：正文 = 叙述性分析；\`children\` 列出它收录的编码与子主题（与编码同一套机制）。
- **分析流程**：材料 →（自然编码）→ 编码 →（理论编码/重组 children）→ 编码层级 →（凝练主题）→ 主题笔记 →（导出）分析总表。
- **技能**：本插件提供 \`qda-natural-coding\`（自然编码）、\`qda-theoretical-coding\`（理论编码）、\`qda-thematic-synthesis\`（凝练主题）三个技能，安装到你的技能目录（如 .agents/skills/、.claude/skills/）后按需调用。

`;

// 一键配置 Agent 工作流：复制技能模板 → 写 AGENTS.md → 勾选注入目标
export function registerAgentWorkflowCommand(
	context: vscode.ExtensionContext,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand("mdqda.setupAgentWorkflow", async () => {
			const root = vscode.workspace.workspaceFolders?.[0]?.uri;
			if (!root) {
				vscode.window.showWarningMessage(
					vscode.l10n.t("No workspace folder is open"),
				);
				return;
			}
			// 1. 复制模板到项目内 .qda/agent-skills/（可编辑源，用户可改后重跑）
			const src = vscode.Uri.joinPath(
				context.extensionUri,
				"templates",
				"agent-skills",
			);
			const projectTpl = vscode.Uri.joinPath(root, ".qda", "agent-skills");
			try {
				await vscode.workspace.fs.copy(src, projectTpl, {
					overwrite: true,
				});
			} catch {
				// 模板不可用时继续（AGENTS.md 仍可写入）
			}
			// 2. 幂等写入 AGENTS.md 的 QDA 规则段
			await writeAgentsSection(vscode.Uri.joinPath(root, "AGENTS.md"));
			// 3. 选择注入目标：已存在的目录默认勾选
			const items: (vscode.QuickPickItem & { dir: string })[] = [];
			for (const t of AGENT_TARGETS) {
				const exists = await dirExists(
					vscode.Uri.joinPath(root, ...t.dir.split("/")),
				);
				items.push({
					label: t.dir,
					description:
						t.note +
						(exists
							? vscode.l10n.t("(exists)")
							: vscode.l10n.t("(will be created)")),
					picked: exists,
					dir: t.dir,
				});
			}
			const picks = await vscode.window.showQuickPick(items, {
				canPickMany: true,
				title: vscode.l10n.t("QDA: Agent Skill Injection Targets"),
				placeHolder: vscode.l10n.t(
					"Choose target agent directories to write QDA skills into",
				),
				matchOnDescription: true,
			});
			if (!picks || picks.length === 0) {
				vscode.window.showInformationMessage(
					vscode.l10n.t(
						"Templates copied to {0}; AGENTS.md updated. No agent directory was chosen.",
						vscode.workspace.asRelativePath(projectTpl, false),
					),
				);
				return;
			}
			// 4. 复制技能到选中的目录
			let injected = 0;
			for (const p of picks) {
				for (const skill of SKILL_NAMES) {
					const dst = vscode.Uri.joinPath(root, ...p.dir.split("/"), skill);
					try {
						await vscode.workspace.fs.createDirectory(
							vscode.Uri.joinPath(dst, ".."),
						);
					} catch {
						// 目录已存在
					}
					try {
						await vscode.workspace.fs.copy(
							vscode.Uri.joinPath(projectTpl, skill),
							dst,
							{ overwrite: true },
						);
						injected++;
					} catch {
						// 单个失败不中断
					}
				}
			}
			vscode.window.showInformationMessage(
				vscode.l10n.t(
					"QDA skills injected into {0} target(s) ({1} SKILL.md files). Restart your agent for them to take effect.",
					picks.length,
					injected,
				),
			);
		}),
	);
}

async function dirExists(uri: vscode.Uri): Promise<boolean> {
	try {
		const st = await vscode.workspace.fs.stat(uri);
		return st.type === vscode.FileType.Directory;
	} catch {
		return false;
	}
}

// 幂等写入 AGENTS.md：存在标记段则整段替换，否则追加
async function writeAgentsSection(uri: vscode.Uri): Promise<void> {
	let content = "";
	try {
		content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(
			"utf8",
		);
	} catch {
		// 文件不存在，按新建处理
	}
	const lines = content.split(/\r?\n/);
	const start = lines.findIndex((l) => l.trim() === AGENTS_MARK);
	const sectionLines = AGENTS_SECTION.replace(/\s+$/, "").split("\n");
	if (start < 0) {
		const newContent =
			content.replace(/\s+$/, "") +
			(content.trim() ? "\n\n" : "") +
			AGENTS_SECTION;
		await vscode.workspace.fs.writeFile(uri, Buffer.from(newContent, "utf8"));
		return;
	}
	// 段结束 = 下一个 "## " 或文件尾
	let end = start + 1;
	while (end < lines.length && !lines[end].startsWith("## ")) {
		end++;
	}
	const merged = [
		...lines.slice(0, start),
		...sectionLines,
		...lines.slice(end),
	].join("\n");
	await vscode.workspace.fs.writeFile(uri, Buffer.from(merged, "utf8"));
}
