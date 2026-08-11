# Markdown QDA

Markdown 定性分析（QDA）扩展：为 Markdown 段落生成 **Foam / Obsidian 兼容的块引用**，一键复制到剪贴板或追加到指定文档；侧边栏「块引用库」管理已编码片段，「编码管理」管理编码文件夹里的代码文件——适用于质性研究（QDA）的"段落 ↔ 编码"链接工作流。

**简体中文** · [English](#english)

---

## 中文介绍

### 功能

#### 1. 复制块引用（仅复制）

- 光标位于段落中，或选中一段文本，执行 **QDA: 复制块引用**（命令面板或右键菜单 →「复制块引用」）
- 若该段落行尾**没有**块 ID：自动追加一个 `^xxxxxx`（6 位，字符集 `a-z0-9`，与 Obsidian 自动生成的块 ID 一致），并复制块引用 `[[文件名#^id]]` 到剪贴板
- 若行尾**已有**块 ID：直接复用，不会重复叠加
- 生成的块 ID 在文件内查重，避免与已有 ID 冲突

#### 2. 复制块引用至…（默认 `Ctrl+Alt+B`）

在功能 1 的基础上，额外弹出**文件检索框**：

- 列出工作区所有 Markdown 文档，输入关键字筛选，回车即选中
- 也可以**直接输入新路径**（如 `编码-压力.md`，支持 `子目录/文件名.md`），回车创建该文件
- 引用（裸引用 `[[文件名#^id]]`，v1 格式）自动**追加到目标文档末尾**，并在预览页中打开目标文档

> 剪贴板同样会得到该引用，即使取消选择目标文档，也可手动粘贴。

#### 3. 侧边栏「块引用库」

点击活动栏的 **QDA** 图标，打开块引用库：

- **自动收集**：工作区所有 Markdown 文件中行尾带 `^id` 的文本片段会自动出现在库中（文件保存、新建、删除、重命名时自动刷新）
- **块内容列表**：所有块直接罗列（不再按文件分组），每块显示块内容，次要信息行显示块编码与来源文件（如 `^a3f9xk · 访谈-01.md`）
- **悬停快捷操作**：鼠标悬停在块上出现两个按钮——**跳转到块所在位置**、**复制块引用**；单击块同样跳到原文
- **文件夹整理**：视图标题栏的「新建引用文件夹」按钮可新建文件夹；右键块 →「移动片段到文件夹…」归类；右键文件夹可重命名、删除（删除文件夹不影响片段，片段回到未分类）
- **删除块引用**：右键块 →「删除块引用」（需二次确认），会**真正从源文件中去掉行尾的块 ID**，该块即从库中消失，已引用它的 `[[…]]` 将失效
- **状态保存**：文件夹结构保存在 VS Code 的 `globalState` 中，**按工作区隔离**，切换项目互不影响；片段本身不复制、不移动，始终指向原文

#### 4. 侧边栏「编码管理」

活动栏 **QDA** 图标下第二个视图。**编码 = 编码文件夹下的一个 md 文件，内容为块引用列表**（如 `0-编码/AI编码.md` 里放着 `[[访谈-01#^a3f9xk]]`）。

- **编码列表**：显示每个编码的**引用数**与**覆盖材料数**（如 `AI编码  3 条 · 2 份材料`）；展开可见全部片段，悬停可跳转原文、复制引用
- **选择编码文件夹**：标题栏文件夹图标，弹出**全项目文件夹列表**（含任意层级子文件夹，自动跳过 `.git`/`node_modules`/`.obsidian`），输入关键字即按**名称与路径**过滤；也可选工作区根目录，或输入相对路径（如 `0-编码/子文件夹`）；设置项 `mdqda.codingFolder`（留空 = 根目录）
- **新建编码**：标题栏 `+`，输入名称（可选定义）自动生成带 YAML frontmatter 的文件
- **编码操作**：单击编码打开编码文件（查看定义与引用列表）；右键菜单依次为**合并**（把 A 的引用并入 B 去重后删 A）、重命名（引用不受影响）、删除（回收站可恢复）
- **父子编码**：悬停编码 →「QDA: 设为子编码…」选择父编码（或移出父级），关系写入编码文件 frontmatter 的 `parent` 字段，树按层级展示；父编码改名时子编码自动跟随；父编码被删除时子编码降级为根级并标 ⚠（悬停查看原因）；**合并**时子编码自动改挂到目标编码下，不能合并进自己的子编码
- **编码定义**：代码文件头部 YAML frontmatter 的 `definition:` 字段，悬停编码时显示
- **导出编码本**：标题栏导出按钮，生成含定义、引用数、全部引用的编码本 Markdown（未保存文档，可自行另存）
- 编码与块引用库互补：**块引用库是片段视角**（哪些段落被编码），**编码管理是代码视角**（每个编码收了哪些段落）

### 用法示例

转录稿 `访谈-01.md`：

```markdown
受访者A：我觉得压力主要来自工作负荷。
```

光标停在该段 → `Ctrl+Alt+B` → 检索框输入 `编码-压力` 回车 → 该行变为：

```markdown
受访者A：我觉得压力主要来自工作负荷。 ^a3f9xk
```

目标文档 `编码-压力.md` 末尾自动追加：

```markdown
[[访谈-01#^a3f9xk]]
```

侧边栏「块引用库」中会同时出现该片段：

```text
受访者A：我觉得压力主要来自工作负荷。 ^a3f9xk · 访谈-01.md
```

悬停可跳转/复制，右键可归入 `压力` 文件夹或删除块引用。

在「编码管理」视图把编码文件夹切到 `0-编码` 后，`AI编码.md` 会显示为一行编码（`AI编码 1 条 · 1 份材料`），展开即该编码下收录的全部片段。

### 兼容性

- **Foam**：`^id` 块锚点 + `[[note#^id]]` 块引用，Foam 原生支持，粘贴后可跳转
- **Obsidian**：块引用语法与 Obsidian 完全一致，同一文件可在 Obsidian 中打开、解析、嵌入
- 块 ID 规则对齐 Obsidian：字母、数字、连字符；行尾前置一个空格

### 键绑定

| 命令 | 默认键位 |
| --- | --- |
| QDA: 复制块引用至… | `Ctrl+Alt+B`（Markdown 文件） |
| QDA: 复制块引用 | 无（命令面板 / 右键菜单） |

### 界面语言

扩展界面支持中/英文，随 VS Code 的显示语言自动切换（简体中文环境显示中文，其他语言环境显示英文）。

### 开发

```bash
npm install
npm run compile          # 编译
npm run package          # 打包 .vsix 到 releases/ 目录
```

---

## English

Markdown qualitative data analysis (QDA) extension for VS Code: generate **Foam / Obsidian-compatible block references** for Markdown paragraphs, copy them to the clipboard or append them to a target document with one click; the **Block Reference Library** sidebar manages coded snippets and the **Code Manager** manages code files in a coding folder — a "paragraph ↔ code" linking workflow for qualitative research.

### Features

#### 1. Copy Block Reference (copy only)

- Place the cursor in a paragraph or select some text, then run **QDA: Copy Block Reference** (Command Palette or the editor context menu → "Copy Block Reference")
- If the line does **not** have a block ID at its end: a `^xxxxxx` ID is appended automatically (6 characters, charset `a-z0-9`, matching Obsidian's auto-generated block IDs), and the block reference `[[note#^id]]` is copied to the clipboard
- If the line **already has** a block ID: it is reused as-is, never duplicated
- Generated block IDs are checked against the whole file to avoid conflicts

#### 2. Copy Block Reference To… (default `Ctrl+Alt+B`)

On top of feature 1, a **file picker** is shown:

- Lists all Markdown documents in the workspace; type keywords to filter, press Enter to select
- You can also **type a new path directly** (e.g. `codes-stress.md`, subfolders supported: `subfolder/file.md`); pressing Enter creates the file
- The reference (a bare `[[note#^id]]`, v1 format) is **appended to the end of the target document**, which then opens in a preview tab

> The clipboard also receives the reference, so you can paste it manually even if you cancel the document picker.

#### 3. Sidebar: Block Reference Library

Click the **QDA** icon in the Activity Bar to open the Block Reference Library:

- **Auto-collected**: every text snippet whose line ends with `^id` in the workspace Markdown files appears here automatically (refreshed on save, create, delete, and rename)
- **Flat list**: all blocks are listed directly (not grouped by file); each block shows its content, with the block ID and source file as secondary info (e.g. `^a3f9xk · 访谈-01.md`)
- **Hover actions**: two buttons appear on hover — **reveal the block in its file** and **copy the block reference**; clicking a block also jumps to the source
- **Folder organization**: use "New Reference Folder" in the view title bar; right-click a block → "Move Snippet to Folder…" to organize; right-click a folder to rename or delete it (deleting a folder does not affect snippets; they return to unassigned)
- **Delete block reference**: right-click a block → "Delete Block Reference" (with confirmation) — this **actually removes the trailing block ID from the source file**, the block disappears from the library, and existing `[[…]]` references stop resolving
- **State persistence**: the folder structure is stored in VS Code `globalState`, **isolated per workspace**; snippets are never copied or moved — they always point to the original text

#### 4. Sidebar: Code Manager

The second view under the **QDA** Activity Bar icon. **A code = a .md file in the coding folder, whose content is a list of block references** (e.g. `0-编码/AI编码.md` contains `[[访谈-01#^a3f9xk]]`).

- **Code list**: shows each code's **reference count** and **covered-material count** (e.g. `AI编码  3 条 · 2 份材料`); expand to see all segments, hover to jump to the source or copy the reference
- **Select coding folder**: click the folder icon in the title bar to open the **full project folder list** (including nested subfolders, auto-skipping `.git` / `node_modules` / `.obsidian`); type keywords to filter by **name and path**; you can also pick the workspace root or type a relative path (e.g. `0-编码/subfolder`); configurable via `mdqda.codingFolder` (empty = workspace root)
- **New code**: click `+` in the title bar, enter a name (definition optional) — a file with YAML frontmatter is created
- **Code operations**: click a code to open its file (definition and references); the context menu offers **Merge** (merge A's references into B, deduplicated, then delete A), Rename (references are unaffected), and Delete (moves to the recycle bin)
- **Parent-child codes**: hover a code → "QDA: Set as Child Code…" to choose a parent (or remove from parent); the relation is stored in the `parent` field of the code file's frontmatter and rendered as a tree; renaming a parent updates its children automatically; deleting a parent demotes its children to the root level with a ⚠ marker (hover for the reason); **merging** re-parents the child codes under the target — you cannot merge into your own child code
- **Code definition**: the `definition:` field in the YAML frontmatter of the code file, shown on hover
- **Export codebook**: the export button in the title bar generates a codebook Markdown document with definitions, reference counts, and all references (an unsaved document — save it yourself)
- The Code Manager complements the Block Reference Library: **the library is the snippet view** (which paragraphs are coded), **the Code Manager is the code view** (which segments each code collects)

### Usage Example

Transcript `访谈-01.md`:

```markdown
受访者A：我觉得压力主要来自工作负荷。
```

Place the cursor on the paragraph → `Ctrl+Alt+B` → type `编码-压力` in the picker and press Enter → the line becomes:

```markdown
受访者A：我觉得压力主要来自工作负荷。 ^a3f9xk
```

The target document `编码-压力.md` gets this appended at its end:

```markdown
[[访谈-01#^a3f9xk]]
```

The snippet also appears in the Block Reference Library:

```text
受访者A：我觉得压力主要来自工作负荷。 ^a3f9xk · 访谈-01.md
```

Hover to reveal/copy; right-click to move it into a `压力` folder or delete the block reference.

After switching the coding folder to `0-编码` in the Code Manager view, `AI编码.md` shows as one code (`AI编码 1 条 · 1 份材料`); expand it to see all segments collected under it.

### Compatibility

- **Foam**: `^id` block anchors + `[[note#^id]]` block references are natively supported by Foam; pasted references are clickable
- **Obsidian**: the block reference syntax is identical to Obsidian's; the same files can be opened, parsed, and embedded in Obsidian
- Block ID rules follow Obsidian: letters, digits, hyphens; preceded by one space at the end of the line

### Keybindings

| Command | Default key |
| --- | --- |
| QDA: Copy Block Reference To… | `Ctrl+Alt+B` (Markdown files) |
| QDA: Copy Block Reference | none (Command Palette / context menu) |

### UI Language

The extension UI supports Chinese and English and switches automatically with the VS Code display language (Simplified Chinese UI in Chinese environments, English otherwise).

### Development

```bash
npm install
npm run compile          # compile
npm run package          # package .vsix into the releases/ directory
```

## License

MIT
