---
name: qda-theoretical-coding
description: 对已有编码做理论编码（轴心/选择性编码）。用抽象理论语言阅读编码本，聚合与升维编码：生成新的理论编码，或通过 frontmatter 的 parent 字段重组编码层级。触发词：理论编码、轴心编码、选择性编码、theoretical coding、把编码理论化。
---

# QDA 理论编码（Theoretical Coding）

本 skill 不依赖 VS Code 扩展命令，直接读写 Markdown 文件，遵守 markdown-qda 的实体契约。

## 前置条件

- 编码本：`tags: [code]` 的编码文件集（用户指定目录或受管区）
- 现有编码已用 `definition` 说明含义，有块引用作为证据

## 操作

1. 通读全部编码的 `definition` 与引用片段，理解材料语义
2. 用用户指定的理论视角（如扎根理论、框架分析、制度理论）识别聚合模式
3. 两种产物（按用户要求选择）：
   - a. 新建理论编码文件（`tags: [code]`），definition 用理论语言概括，正文引用其子编码涉及的片段
   - b. 为既有编码设置 / 调整 `parent`（写入其 frontmatter），形成编码层级
4. 层级约束：`parent` 必须指向存在的编码，不得成环，深度不超过 5 层

## 检查清单

- [ ] `parent` 指向存在的编码且不成环
- [ ] 理论编码的 definition 能覆盖其子编码的语义
- [ ] 理论编码正文有块引用证据（或注明"由已有编码聚合"）
- [ ] 不删除、不破坏已有编码的引用
