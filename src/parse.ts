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

// frontmatter 解析结果：tags 为实体类型标签（code/theme），definition/parent 为既有字段
export interface ParsedFrontmatter {
	tags: string[];
	definition?: string;
	parent?: string;
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

function strField(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

// 行级回退：frontmatter 不是合法 YAML 时只取平铺的 definition/parent，tags 视为空
function lineFallback(fmText: string): {
	definition?: string;
	parent?: string;
} {
	const fmLines = fmText.split("\n");
	const line = (field: string) =>
		fmLines.find((l) => {
			const t = l.trim();
			return t.toLowerCase().startsWith(field.toLowerCase() + ":");
		});
	const def = line("definition");
	const parent = line("parent");
	return {
		definition: def?.replace(/^definition:\s*/i, "").trim(),
		parent: parent?.replace(/^parent:\s*/i, "").trim() || undefined,
	};
}

// 解析文件头 YAML frontmatter：用 js-yaml 完整解析（tags/definition/parent）；
// 无 frontmatter 或非法 YAML 时回退到行级解析，bodyStart 仍正确标记正文起点
export function parseFrontmatter(content: string): ParsedFrontmatter {
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!m) {
		return { tags: [], bodyStart: 0 };
	}
	const bodyStart = m[0].length;
	let data: unknown;
	try {
		data = yaml.load(m[1]);
	} catch {
		return { tags: [], ...lineFallback(m[1]), bodyStart };
	}
	const obj =
		data && typeof data === "object" && !Array.isArray(data)
			? (data as Record<string, unknown>)
			: {};
	return {
		tags: normalizeTags(obj.tags),
		definition: strField(obj.definition),
		parent: strField(obj.parent),
		bodyStart,
	};
}

// 写入/删除 frontmatter 字段；value 为空字符串 = 删除该字段行。
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
		return `---\n${field}: ${value}\n---\n\n` + content;
	}
	const lines = m[1].split("\n");
	const idx = lines.findIndex((l) => {
		const t = l.trim();
		return t.toLowerCase().startsWith(field.toLowerCase() + ":");
	});
	let newFm: string;
	if (value) {
		if (idx >= 0) {
			lines[idx] = `${field}: ${value}`;
		} else {
			lines.push(`${field}: ${value}`);
		}
		newFm = lines.join("\n");
	} else {
		if (idx < 0) {
			return content; // 字段不存在且删除：无操作
		}
		lines.splice(idx, 1);
		newFm = lines
			.join("\n")
			.replace(/\n{2,}/g, "\n")
			.replace(/^\n+/, "")
			.replace(/\n+$/, "");
	}
	const rest = content.slice((m.index ?? 0) + m[0].length);
	return `---\n${newFm}\n---\n${rest}`;
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

// 由编码的 parent 字段构建层级树：悬空/成环的编码降级为根级并记警告。
// 渲染层只消费本函数产出的结构，不递归跟随 parent，保证不可能死循环。
export function buildCodeHierarchy(
	codes: { name: string; parent?: string }[],
): CodeTreeResult {
	const byName = new Set(codes.map((c) => c.name));
	const parentsOf = new Map<string, string>();
	for (const c of codes) {
		if (c.parent) {
			parentsOf.set(c.name, c.parent);
		}
	}

	const warnings = new Map<string, WarningMessage>();
	// 悬空：parent 指向不存在的编码
	for (const [name, p] of parentsOf) {
		if (!byName.has(p)) {
			warnings.set(name, {
				template: "Parent code “{0}” does not exist; shown at root level",
				args: [p],
			});
		}
	}
	// 环检测：沿 parent 链 DFS（每节点至多一条出边），环内与指向环的节点都降级
	const inCycle = new Set<string>();
	const state = new Map<string, number>(); // 0 未访问 1 访问中 2 完成
	const dfs = (name: string): boolean => {
		const s = state.get(name) ?? 0;
		if (s === 1) {
			return true; // 发现环
		}
		if (s === 2) {
			return inCycle.has(name); // 已处理：按是否在环内返回
		}
		state.set(name, 1);
		const p = parentsOf.get(name);
		let cyclic = false;
		if (p && byName.has(p)) {
			cyclic = dfs(p);
		}
		state.set(name, 2);
		if (cyclic) {
			inCycle.add(name);
		}
		return cyclic;
	};
	for (const c of codes) {
		dfs(c.name);
	}
	for (const name of inCycle) {
		warnings.set(name, {
			template: "Parent relation forms a cycle; shown at root level",
			args: [],
		});
	}

	// 正常父子关系 + 根级
	const childrenOf = new Map<string, string[]>();
	for (const c of codes) {
		childrenOf.set(c.name, []);
	}
	const roots: string[] = [];
	for (const c of codes) {
		const p = parentsOf.get(c.name);
		if (!p || !byName.has(p) || inCycle.has(c.name)) {
			roots.push(c.name);
		} else {
			childrenOf.get(p)!.push(c.name);
		}
	}

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
