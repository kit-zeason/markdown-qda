# AGENTS.md

Markdown QDA（`markdown-qda`）：Markdown 定性分析（QDA）的 VS Code 扩展。当前实现三大块：

1. **块引用**：为段落生成/复用 Foam/Obsidian 兼容块 ID（`^id`），复制或追加块引用到指定文档；
2. **块引用库**（视图 `mdqda.blockRefLibrary`）：已编码片段清单，可建文件夹归类、删除块 ID；
3. **编码管理**（视图 `mdqda.codeManager`）：编码 = 编码文件夹（`mdqda.codingFolder`，默认工作区根目录）下的一个 md 文件，内容为块引用列表，支持新建/重命名/合并/删除/导出编码本，定义存 YAML frontmatter。父子编码用 frontmatter 的 `parent` 字段声明（无 = 根级）；悬空/成环/超深（`MAX_CODE_DEPTH = 5`）自动降级为根级并标 ⚠，渲染只消费 `buildCodeHierarchy` 产出的树、不递归跟随 parent；UI 写入（设为子编码/合并/重命名）做环校验与子级同步。
核心契约 = Markdown 原生 + Obsidian/Foam 语法兼容。

## 构建与验证

- 编译：`npm run compile`（tsc strict，唯一质量门禁，改动后必须通过）。
- 打包：`npm run package`——vsce 依赖 `--allow-missing-repository`（package.json 无 repository 字段），不要为打包添加该字段。
- 无测试框架、无 lint：不要引入；验证 = compile 通过 + F5 手动验证「无选区 / 有选区」两个场景。

## 绊线（违反代价高）

- 新增命令须同时注册 `contributes.commands` 与 `activationEvents`——命令前缀 `mdqda.*`（如 `onCommand:mdqda.blockRef.copy`），无 `*` 激活；漏注册则命令失效至重载窗口。
- 不改块 ID 规则：`randomId` 为 6 位、字符集 `a-z0-9`；行尾匹配 `BLOCK_ID_RE = /\s+\^([a-zA-Z0-9-]+)\s*$/`；写入时前置一个空格（`' ^' + id`）。
- 新生成的 ID 必须对全文查重（`full.includes('^' + id)` 循环重抽），避免文件内冲突。

## 行为约定（易被"改进"破坏）

- 块定义：无选区 = 光标所在行；有选区 = 选区**末**行。勿改成首行。
- 行尾已有 `^id` 时直接复用（"有码则跳过"），绝不叠加第二个 ID。
- 引用文件名用 `path.basename(doc.fileName, '.md')`（去扩展名），不用相对路径。
- UI 文案、代码注释、文档一律中文，新代码保持一致。
