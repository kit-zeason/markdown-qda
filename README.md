# QDA Block Reference

在 VSCode 中为 Markdown 段落生成 **Foam / Obsidian 兼容的块引用**，一键复制到剪贴板，粘贴到编码文档（或任意笔记）即可建立"段落 ↔ 编码"的链接。

## 功能

- 光标位于段落中，或选中一段文本，按 `Ctrl+Alt+B`（或右键菜单 →「复制块引用」）
- 若该段落行尾**没有**块 ID：自动追加一个 `^xxxxxx`（6 位，字符集 `a-z0-9`，与 Obsidian 自动生成的块 ID 一致），并复制块引用 `[[文件名#^id]]` 到剪贴板
- 若行尾**已有**块 ID：直接复用，不会重复叠加
- 生成的块 ID 在文件内查重，避免与已有 ID 冲突

## 用法示例

转录稿 `访谈-01.md`：

```markdown
受访者A：我觉得压力主要来自工作负荷。
```

光标停在该段 → `Ctrl+Alt+B` → 变为：

```markdown
受访者A：我觉得压力主要来自工作负荷。 ^a3f9xk
```

剪贴板中已得到 `[[访谈-01#^a3f9xk]]`，粘贴到编码文档 `编码-压力.md`：

```markdown
## 引用
- [[访谈-01#^a3f9xk]]
```

## 兼容性

- **Foam**：`^id` 块锚点 + `[[note#^id]]` 块引用，Foam 原生支持，粘贴后可跳转
- **Obsidian**：块引用语法与 Obsidian 完全一致，同一文件可在 Obsidian 中打开、解析、嵌入
- 块 ID 规则对齐 Obsidian：字母、数字、连字符；行尾前置一个空格

## 键绑定

默认 `Ctrl+Alt+B`（仅 Markdown 文件生效），可在 VSCode 键绑定设置中修改。

## 开发

```bash
npm install
npm run compile          # 编译
npm run package          # 打包 .vsix
```

## License

MIT
