// 纯解析逻辑：不依赖 vscode，便于独立测试

import * as yaml from "js-yaml";

// Obsidian 手动块 ID 允许字母、数字、连字符（不允许下划线/空格）
export const BLOCK_ID_RE = /\s+\^([a-zA-Z0-9-]+)\s*$/;

export interface ParsedBlockRef {
	key: string; // `${file}#${id}`，文件夹成员以此为唯一键
	file: string; // 工作区相对路径（含 .md）
	id: string;
	text: string; // 块文本（去掉行尾 ^id）
	line: number; // 0 基行号
}

// 解析一个 Markdown 文件的全部块引用（行尾带 ^id 的行）
export function collectBlockRefs(
	content: string,
	file: string,
): ParsedBlockRef[] {
	const refs: ParsedBlockRef[] = [];
	const seen = new Set<string>();
	const lines = content.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const m = BLOCK_ID_RE.exec(lines[i]);
		if (!m) {
			continue;
		}
		const id = m[1];
		const key = `${file}#${id}`;
		if (seen.has(key)) {
			continue; // 文件内重复 ID 只取第一处
		}
		seen.add(key);
		refs.push({
			key,
			file,
			id,
			text: lines[i].slice(0, m.index).replace(/\s+$/, ""),
			line: i,
		});
	}
	return refs;
}

// ---- 实体文件解析（纯逻辑，不依赖 vscode） ----

// frontmatter 解析结果：tags 为实体类型标签（code/theme），definition 为一句话定义，
// children 为「我直接包含的实体名」（父端声明；同一实体出现在多个父下即多父）
export interface ParsedFrontmatter {
	tags: string[];
	definition?: string;
	children: string[];
	bodyStart: number;
}

// 把 YAML tags 归一化为数组：支持内联数组 [a, b]、YAML 列表、逗号分隔字符串（Obsidian 三种写法）
function normalizeTags(v: unknown): string[] {
	if (typeof v === "string") {
		return v
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
	}
	if (Array.isArray(v)) {
		return v.filter((t): t is string => typeof t === "string");
	}
	return [];
}

// children 归一化：兼容 [[名字]] / 别名 / 锚点写法，去空白与重复
function normalizeNames(v: unknown): string[] {
	const raw = typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") {
			continue;
		}
		const name = item
			.trim()
			.replace(/^\[\[/, "")
			.replace(/\]\]$/, "")
			.split("|")[0]
			.split("#")[0]
			.trim();
		if (name && !out.includes(name)) {
			out.push(name);
		}
	}
	return out;
}

function strField(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// 行级回退：frontmatter 不是合法 YAML 时只取平铺的 definition，tags/children 视为空
function lineFallback(fmText: string): { definition?: string } {
	const line = fmText
		.split("\n")
		.find((l) => l.trim().toLowerCase().startsWith("definition:"));
	return { definition: line?.replace(/^definition:\s*/i, "").trim() };
}

// 解析文件头 YAML frontmatter：用 js-yaml 完整解析（tags/definition/parent）；
// 无 frontmatter 或非法 YAML 时回退到行级解析，bodyStart 仍正确标记正文起点
export function parseFrontmatter(content: string): ParsedFrontmatter {
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!m) {
		return { tags: [], children: [], bodyStart: 0 };
	}
	const bodyStart = m[0].length;
	let data: unknown;
	try {
		data = yaml.load(m[1]);
	} catch {
		return { tags: [], children: [], ...lineFallback(m[1]), bodyStart };
	}
	const obj =
		data && typeof data === "object" && !Array.isArray(data)
			? (data as Record<string, unknown>)
			: {};
	return {
		tags: normalizeTags(obj.tags),
		definition: strField(obj.definition),
		children: normalizeNames(obj.children),
		bodyStart,
	};
}

// frontmatter 中某个字段占用的行范围：键所在行 + 其后所有缩进续行（列表项等）。
// 用于定位并整体替换字段，避免残留旧写法造成的非法 YAML。
function fieldBlockRange(
	lines: string[],
	field: string,
): { start: number; end: number } | null {
	const start = lines.findIndex((l) => {
		const t = l.trim();
		return t.toLowerCase().startsWith(field.toLowerCase() + ":");
	});
	if (start < 0) {
		return null;
	}
	let end = start + 1;
	while (
		end < lines.length &&
		lines[end].trim() !== "" &&
		/^\s/.test(lines[end])
	) {
		end++;
	}
	return { start, end };
}

// YAML 标量安全渲染：含 ":" 等字符时由 js-yaml 自动加引号，避免写出非法 YAML
export function yamlScalar(value: string): string {
	return yaml.dump(value).trimEnd();
}

// 写入/删除 frontmatter 标量字段；value 为空字符串 = 删除该字段。
// 无 frontmatter 且需要写入时，在文件头新建 frontmatter。
export function setFrontmatterField(
	content: string,
	field: string,
	value: string,
): string {
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!m) {
		if (!value) {
			return content; // 无 frontmatter 且删除字段：无操作
		}
		return `---\n${field}: ${yamlScalar(value)}\n---\n\n` + content;
	}
	const lines = m[1].split("\n");
	const range = fieldBlockRange(lines, field);
	if (value) {
		const block = [`${field}: ${yamlScalar(value)}`];
		if (range) {
			lines.splice(range.start, range.end - range.start, ...block);
		} else {
			lines.push(...block);
		}
	} else {
		if (!range) {
			return content; // 字段不存在且删除：无操作
		}
		lines.splice(range.start, range.end - range.start);
	}
	const newFm = lines
		.join("\n")
		.replace(/\n{2,}/g, "\n")
		.replace(/^\n+/, "")
		.replace(/\n+$/, "");
	const rest = content.slice((m.index ?? 0) + m[0].length);
	return `---\n${newFm}\n---\n${rest}`;
}

// 覆写 frontmatter 列表字段，一律写成 YAML 块式列表（Obsidian 规范）：
//
//	tags:
//	  - code
//
// 读取端兼容内联数组 / 块式列表 / 逗号分隔字符串三种写法，写入端只产出块式。
export function setFrontmatterList(
	content: string,
	field: string,
	items: string[],
): string {
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	const block = items.length ? yaml.dump({ [field]: items }).trimEnd() : "";
	if (!m) {
		if (!block) {
			return content;
		}
		return `---\n${block}\n---\n\n` + content;
	}
	const lines = m[1].split("\n");
	const range = fieldBlockRange(lines, field);
	if (block) {
		const blockLines = block.split("\n");
		if (range) {
			lines.splice(range.start, range.end - range.start, ...blockLines);
		} else {
			lines.push(...blockLines);
		}
	} else if (range) {
		lines.splice(range.start, range.end - range.start);
	} else {
		return content; // 无该字段且无需写入：无操作
	}
	const newFm = lines
		.join("\n")
		.replace(/\n{2,}/g, "\n")
		.replace(/^\n+/, "")
		.replace(/\n+$/, "");
	const rest = content.slice((m.index ?? 0) + m[0].length);
	return `---\n${newFm}\n---\n${rest}`;
}

// 生成实体文件的 frontmatter：块式 tags + 可选 definition
export function buildEntityFrontmatter(
	type: string,
	definition?: string,
): string {
	const data: Record<string, unknown> = { tags: [type] };
	const def = definition?.trim();
	if (def) {
		data.definition = def;
	}
	return `---\n${yaml.dump(data).trimEnd()}\n---\n\n`;
}

// 多级编码深度上限（超出仅警告，仍正常显示）
export const MAX_CODE_DEPTH = 5;

export interface WarningMessage {
	template: string; // 警告文案模板（含 {0} 占位符）；本地化由渲染层负责
	args: (string | number)[]; // 模板参数
}

export interface CodeTreeResult {
	roots: string[]; // 根级编码名（按传入顺序）
	childrenOf: Map<string, string[]>; // 父名 → 子名列表
	warnings: Map<string, WarningMessage>; // 编码名 → 警告（悬空/成环/超深）
}

// 由 children 字段构建实体图：父端声明成员，同一实体可挂在多个父下（DAG）。
// known 用来区分「悬空引用」与「合法但不属于本视图」的成员（如主题视图里的编码成员）；
// missingTemplate 由调用方给，编码视图与主题视图对"不认识的成员"措辞不同。
// 环内节点提升为根级并断开其出边，保证渲染层不会死循环。
export interface GraphEntity {
	name: string;
	children: string[];
}

export function buildEntityGraph(
	entities: GraphEntity[],
	known?: Set<string>,
	missingTemplate = "Child “{0}” does not exist; ignored",
): CodeTreeResult {
	const byName = new Map(entities.map((e) => [e.name, e]));
	const knownNames = known ?? new Set(byName.keys());
	const warnings = new Map<string, WarningMessage>();
	const edges = new Map<string, string[]>();

	for (const e of entities) {
		const kept: string[] = [];
		for (const c of e.children) {
			if (!knownNames.has(c)) {
				if (!warnings.has(e.name)) {
					warnings.set(e.name, { template: missingTemplate, args: [c] });
				}
				continue;
			}
			if (byName.has(c)) {
				kept.push(c); // 只渲染本视图内的实体
			}
		}
		edges.set(e.name, kept);
	}

	// 环检测（DFS 三色）：回边经过的节点记为环内
	const state = new Map<string, 1 | 2>();
	const stack: string[] = [];
	const inCycle = new Set<string>();
	const visit = (name: string): void => {
		if (state.get(name) === 1) {
			for (let i = stack.lastIndexOf(name); i < stack.length; i++) {
				inCycle.add(stack[i]);
			}
			return;
		}
		if (state.get(name) === 2) {
			return;
		}
		state.set(name, 1);
		stack.push(name);
		for (const c of edges.get(name) ?? []) {
			visit(c);
		}
		stack.pop();
		state.set(name, 2);
	};
	for (const e of entities) {
		visit(e.name);
	}
	for (const name of inCycle) {
		warnings.set(name, {
			template: "Parent relation forms a cycle; shown at root level",
			args: [],
		});
	}

	// 环内节点断开出边，且不再作为别人的子节点，只以根级出现
	const childrenOf = new Map<string, string[]>();
	const referenced = new Set<string>();
	for (const e of entities) {
		const kids = (edges.get(e.name) ?? []).filter((k) => !inCycle.has(k));
		childrenOf.set(e.name, kids);
		for (const k of kids) {
			referenced.add(k);
		}
	}
	const roots = entities
		.map((e) => e.name)
		.filter((n) => !referenced.has(n));

	// 深度检查（BFS，从根向下；超出上限仅警告）
	const depth = new Map<string, number>();
	const queue = roots.slice();
	for (const r of roots) {
		depth.set(r, 0);
	}
	let head = 0;
	while (head < queue.length) {
		const cur = queue[head++];
		const d = depth.get(cur)!;
		for (const child of childrenOf.get(cur) ?? []) {
			if (depth.has(child)) {
				continue;
			}
			depth.set(child, d + 1);
			if (d + 1 > MAX_CODE_DEPTH && !warnings.has(child)) {
				warnings.set(child, {
					template:
						"Hierarchy deeper than {0} levels (still displayed normally)",
					args: [MAX_CODE_DEPTH],
				});
			}
			queue.push(child);
		}
	}
	return { roots, childrenOf, warnings };
}

export interface ParsedRef {
	raw: string; // [[note#^id]] 原文
	note: string; // 文件名（去扩展名）
	id: string;
}

const REF_RE = /\[\[([^\]|#]+)#\^([a-zA-Z0-9-]+)\]\]/g;

// 提取正文（frontmatter 之后）的全部块引用，去重
export function extractRefs(content: string, bodyStart: number): ParsedRef[] {
	const refs: ParsedRef[] = [];
	const seen = new Set<string>();
	const re = new RegExp(REF_RE.source, "g");
	let m: RegExpExecArray | null;
	while ((m = re.exec(content.slice(bodyStart))) !== null) {
		if (seen.has(m[0])) {
			continue;
		}
		seen.add(m[0]);
		refs.push({ raw: m[0], note: m[1], id: m[2] });
	}
	return refs;
}
