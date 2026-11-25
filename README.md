# Markdown QDA

Write a qualitative study in plain text: addressable material, citable codes, themes carrying their evidence, claims that can be checked — without opening an application.

`v0.6.1` · MIT

**English** · [简体中文](#中文介绍)

> **Publishing status** ⚠️ Not yet published to the VS Code Marketplace / Open VSX. Install via the `.vsix` from the [Releases](https://github.com/kit-zeason/markdown-qda/releases) page, or build it yourself with `npm run package`. Marketplace publishing is planned.
>
> **发布状态** ⚠️ 本扩展**尚未发布到 VS Code Marketplace / Open VSX**，当前通过 [Release](https://github.com/kit-zeason/markdown-qda/releases) 提供 `.vsix` 安装包（或自行 `npm run package` 打包）。计划未来择机上架。

---

## English

Markdown QDA is a text-native method for qualitative analysis, implemented in Markdown and built on block-code-theme (BCT) as its infrastructure. Blocks make material addressable, codes cite blocks, themes cite codes.

This extension is the tooling for that method: three sidebar views (block references, codes, themes) and a few commands, all operating on the `.md` files in your own folder.

### The idea: qualitative analysis as plain text

Mainstream qualitative software stores the analysis as application state: passages, codes, codebooks, node trees and themes live inside a project file, unreadable without the package that wrote them. For solo work this is fine. But the moment the analysis has to go to a collaborator, a reviewer, a re-check, or an AI agent, the whole chain from material to claim must be readable, diffable and contestable outside the software.

Text-native coding puts that chain on an addressable plain-text surface:

- a passage of material carries a stable **block** ID (`^k3f9x2`, Obsidian / Foam syntax);
- a **code** is a Markdown file whose body lists block references and whose frontmatter carries the definition;
- a **theme** is a Markdown file whose `children` list the codes it builds on and whose body carries the argument.

Material → block → code → theme → claim: every layer opens in an editor, greps, and diffs. The codebook becomes a citable object rather than a tree inside a package.

The record is not tied to a school. Paper text, the appendix codebook and the software's node tree used to be three non-corresponding things; here they are readings of one record. Constant comparison, thematic analysis, framework analysis, computational text analysis and second-order analysis (re-coding published analyses as new material) can share the same files, because they share one layer: addressable passages, a citable codebook, themes that carry evidence. Changing school changes how the codebook and the themes are written, not the storage format, and rebuilds nothing — the same material can be thematically analysed in the morning and framework-analysed in the afternoon without exporting the data twice.

Mixed methods follow the same route: statistical scripts, topic models and LLM pipelines read the same md and write back to the same md, so the divergence between human and machine, qualitative and computational, shows up in the text. Method boundaries then fall on how things are written, not on which package you own.

Plain text is not a universal solvent. Only material that can be rendered as text enters the record — audio and video through transcripts and time codes, images through the analyst's frame descriptions — and a transcript is not the recording. The format makes judgment checkable; it does not make it for you.

### Minimal: BCT in three moves

Three levels, three entity kinds, two kinds of edge; every edge connects adjacent levels.

| Level | Entity | File form | Edges |
| --- | --- | --- | --- |
| Block | a passage of material | trailing `^id` (6 chars, `a-z0-9`) | cited by codes |
| Code | a `.md` with `tags: code` | body = block references; `definition`, `children` | collects blocks; may collect sub-codes |
| Theme | a `.md` with `tags: theme` | body = argument; `children` = supporting codes | collects codes, flat, no nesting |

A code may sit under several parents at once (multi-parent DAG): to try another coding architecture, create a parent code and list the existing sub-codes in it — no child file changes. Mainstream CAQDAS keeps a single classification tree, so switching schemes usually means rebuilding nodes; here it is one file.

Minimal example, three files.

*`20260810-interview-A.md`*

```markdown
Interviewee A: I have to compare everything again each time — too tiring. I'd rather wait for a big sale. ^k3f9x2
```

*`Price sensitivity comes from comparison cost.md`*

```markdown
---
tags:
  - code
definition: High comparison cost makes price sensitivity show up as delayed decisions
children:
  - Special offers only resolve short-term hesitation
---
[[20260810-interview-A#^k3f9x2]]
[[20260812-interview-B#^z2w8n6]]
```

*`Promotions read as a signal to keep waiting.md`*

```markdown
---
tags:
  - theme
definition: When comparison costs are high, promotions are read as a signal to keep waiting
children:
  - Price sensitivity comes from comparison cost
  - Special offers only resolve short-term hesitation
---
For users with high comparison costs, a promotion is not a discount but a signal to "wait a bit"… (argument)
```

The whole primitive set is: give a block an ID and cite it, add a block or an entity to a code, add a code to a theme, change identity by changing `tags`, export the analysis table, write the agent contract. Each of those is one line or one field of plain text; writing them by hand is fully equivalent. Being usable without this extension is a design requirement, not a fallback.

**Deliberately not:**

- no embedded LLM; no retrieval, clustering, NLP or statistics — other tools do that;
- no account, no cloud sync, no database;
- no proprietary format; no PDF / HTML export (it would break `[[...]]` links);
- no "memo" entity: in a text-native environment a memo is a usage pattern, not a file type;
- no prescribed folder layout — identity lives in the frontmatter `tags`, files can live anywhere.

**Plug in instead:** Obsidian / Foam parse the same block references, Dataview and the tag pane query the same tags, `git` handles versions and diffs, `ripgrep` finds codes and citations, pandoc drafts the paper, Zotero handles references, Python / R do statistics and topic models, and any LLM agent joins through `AGENTS.md`. Text as the platform means the only interface between these tools is the file.

### Data sovereignty: who holds the files

- No account, no telemetry, no network. Files live on your disk; how you sync them (git / OneDrive / Syncthing) is your call.
- The format is the artifact: delete the extension and material, codes, themes and the export table still read, edit and re-parse. The extension removes the mechanical labour of writing `^id` and reference lists; it does not hold your data.
- The analysis table is a generated artifact and an acceptance test: theme → code → block, each block as `[[material#^id]] — original text`. `cat` and `grep` can rebuild that table from the source files, which is what makes the record text-native in fact rather than in claim.
- Sovereignty has costs: backups, sync conflicts and what agents may write are yours to manage.

### Agent access: a contract, not a model

The extension contains no LLM and does not pick a vendor for you. `QDA: Setup Agent Workflow` does three things:

1. writes the collaboration contract into the project-root `AGENTS.md` — entity contract, block-reference rules, analysis pipeline;
2. copies three `SKILL.md` templates to `.qda/agent-skills/` (editable; re-run the command to apply changes);
3. installs the skills into the directories you tick: `.agents/skills/`, `.claude/skills/`, `.pi/skills/`, `.dsh/skills/`.

The agent reads and writes the same md you do: it can add block references, propose candidate codes against the codebook, check that a theme's supporting codes resolve, and report themes with no evidence. Its output is a diff — you read it, reject it, revert it.

The boundary is fixed: interpretation stays with the analyst, the agent does checkable mechanical work. Every write stays in the text, where the next collaborator — or the next agent — can re-check it. That is what this record has over pasting material into a chat window.

### Quick start

1. Install the `.vsix` (Releases page, or build with `npm run package`) and open your research folder in VS Code.
2. Put the cursor in a material paragraph and press `Ctrl+Alt+B`; pick a code file. The line gains a block ID and `[[note#^id]]` is appended to that file as a list item.
3. Give code and theme files `tags` (YAML block list), or select files and run `QDA: Define as Code` / `QDA: Define as Theme`; the sidebar views pick them up. Build the three levels with "Add to Code…" / "Add to Theme…".
4. Run `QDA: Setup Agent Workflow` when you want an agent in the loop.
5. Run `QDA: Export Analysis Summary` at the end, as a paper appendix or an audit artifact.

### Status and roadmap

- Implemented: block IDs and the block reference library, code manager (multi-parent DAG), theme manager (flat), three-level analysis export, agent workflow setup.
- Next: a versioned specification, validator and conformance suite, so "usable without this extension" becomes a testable promise; argument constraints on themes (warnings, not gates).
- Not doing: see "Minimal".

### Compatibility

- **Foam / Obsidian**: `^id` anchors and `[[note#^id]]` block references are the native syntax of both; the same files parse in either.
- **frontmatter**: `tags` is always a YAML block list (what Obsidian requires), so Obsidian's tag pane and Dataview can query it directly:

```yaml
---
tags:
  - code
---
```

### Documentation

Architecture decisions and design notes live in `docs/` (`docs/README.md` is the index); that folder is excluded from the vsix.

### Development

```bash
npm install
npm run compile          # compile
npm run package          # package a .vsix into releases/
```

### Keybindings

| Command | Default key |
| --- | --- |
| QDA: Copy Block Reference To… | `Ctrl+Alt+B` (Markdown files) |
| QDA: Copy Block Reference | none (Command Palette / context menu) |

### UI language

The UI supports Chinese and English and follows the VS Code display language.

---

## 中文介绍

把一个定性研究项目写成一组纯文本：材料可寻址、编码可引用、主题带证据、论断可被检查——不需要打开某个应用。

Markdown QDA 是一套 text-native（文本本位）的定性分析方法，在 Markdown 上实现，以 block-code-theme（BCT）为基础设施。块让材料可寻址，编码引用块，主题引用编码。

本扩展是这套方法的配套工具：三个侧边栏视图（块引用库、编码、主题）加几条命令，操作对象全部是你文件夹里的 `.md`。

### 构想：把定性分析写进纯文本

主流定性分析软件把分析存成应用状态：段落、编码、编码本、节点树、主题都在项目文件里，离开软件就读不出来。对个人使用，这没有大问题；但分析一旦要交给合作者、评审、复核，或者一个 AI agent，从材料到论断的整条证据链就必须能脱离软件被读、被 diff、被质疑。

Text-native 的做法是把这条证据链放在一个可寻址的纯文本面上：

- 材料里的一个段落有稳定块（block） ID（`^k3f9x2`，Obsidian / Foam 语法）；
- 编码（code）是一个 Markdown 文件，正文是块引用列表，定义写在 frontmatter；
- 主题是（theme）一个 Markdown 文件，`children` 列出支撑它的编码，正文写论述。

材料 → 块 → 编码 → 主题 → 论断，每一层都是编辑器能打开、`grep` 能搜、`git` 能对比的文件。编码本从"软件里的一棵树"变成可引用的对象。

这个记录不绑定某个流派。论文正文、附录里的编码本、软件里的节点树原本是三份互不对应的东西，在这里是同一份记录的不同读法。持续比较、主题分析、框架分析、计算文本分析、二次分析（把已发表的分析当材料再编码）可以共用同一批文件，因为它们共用的是同一层：可寻址的段落、可引用的编码本、带证据的主题。换流派只换编码本和主题的写法，不换存储格式，也不重做文件——同一批材料上午做主题分析、下午做框架分析，不必导两次数据。

混合方法同理：统计脚本、主题模型、LLM 管线读同一批 md，产出写回同一批 md，人机之间、质性与计算之间的差异就落在文本上。方法之间的界线于是落在写法上，而不落在软件上。

纯文本也不是万能溶剂：只有能文本化的材料进入记录（音频视频靠转写与时间码，图像靠研究者写的画面描述），转写不等同于听原声；格式让判断可检查，但不替你做判断。

### 极简：只给 BCT 三个动作

三级架构，三种实体，两条边：边只连相邻两级。

| 层级 | 实体 | 文件形态 | 关系 |
| --- | --- | --- | --- |
| Block | 材料里的一个段落 | 行尾 `^id`（6 位，`a-z0-9`） | 被编码引用 |
| Code | `tags: code` 的 md | 正文 = 块引用列表；`definition`、`children` | 收块；可收子编码 |
| Theme | `tags: theme` 的 md | 正文 = 论述；`children` = 支撑编码 | 收编码，平铺不嵌套 |

编码可以同时属于多个父编码（多父 DAG）：要换一套编码架构，就新建一个父编码把现成的子编码列进去，子文件一个都不动。主流 CAQDAS 只有一棵分类树，换方案往往等于重做节点——这里只是一次写一个文件。

最小示例，三份文件。

*`20260810-访谈A.md`*

```markdown
受访者A：每次都要重新比一遍，太累了，不如等大促。 ^k3f9x2
```

*`价格敏感来自比价成本.md`*

```markdown
---
tags:
  - code
definition: 比价成本高使价格敏感表现为推迟决策
children:
  - 促销只解决短期犹豫
---
[[20260810-访谈A#^k3f9x2]]
[[20260812-访谈B#^z2w8n6]]
```

*`促销被读成"再等等"的信号.md`*

```markdown
---
tags:
  - theme
definition: 比价成本高时，促销被解释为继续观望的信号
children:
  - 价格敏感来自比价成本
  - 促销只解决短期犹豫
---
比价成本高的用户不把促销当优惠，而是当"再等等"的信号……（论述）
```

整个原语集合只有这几件事：给块发 ID 并引用、把块或实体加进编码、把编码加进主题、改 tags 换身份、导出分析总表、写入 agent 契约。每个动作在纯文本里都是加一行或改一个字段，手写完全等价。"可以不用这个插件"是设计要求，不是兜底。

**刻意不做**

- 不内嵌 LLM，不做检索、聚类、NLP、统计——这些交给别的工具；
- 不做账号、云同步、数据库；
- 不定义专有格式，不导出 PDF / HTML（那会让 `[[...]]` 链接失效）；
- 不设"备忘录"实体：在文本本位环境里，备忘录是一种使用方式，不是一种文件类型；
- 不规定目录结构：实体身份由 frontmatter `tags` 声明，文件放哪都行。

**外接即可**：Obsidian / Foam 解析同一套块引用，Dataview 与标签面板能查同一套 tags，`git` 管版本与 diff，`ripgrep` 找编码与引用，pandoc 出稿，Zotero 接引文，Python / R 做统计与主题模型，任意 LLM agent 通过 `AGENTS.md` 接入。"以文本为平台"的意思是：这些工具之间唯一的接口是文件。

### 数据主权：文件在谁手里

- 无账号、无遥测、不联网。所有文件在你的磁盘上，用什么同步（git / OneDrive / Syncthing）由你决定。
- 格式即产物：删掉扩展，材料、编码、主题、导出表仍然能读、能改、能被重新解析。插件省掉的是手写 `^id` 与引用列表的机械劳动，不持有数据。
- 分析总表是生成物，也是验收物：「主题 → 编码 → 块」三级清单，每块给 `[[材料#^id]] — 原文`。只用 `cat` / `grep` 就能从源文件重建这张表，说明记录确实是文本原生的。
- 代价跟着主权来：备份、同步冲突、agent 的写权限，都由你自己管。

### Agent 接入：给契约，不给模型

扩展不含 LLM，也不替你选供应商。`QDA: 配置 Agent 工作流` 做三件事：

1. 把协作契约写进项目根 `AGENTS.md`——实体契约、块引用规则、分析流水线；
2. 把 3 个 `SKILL.md` 模板复制到 `.qda/agent-skills/`（可改，重跑命令生效）；
3. 按你勾选的目录，把技能注入 `.agents/skills/`、`.claude/skills/`、`.pi/skills/`、`.dsh/skills/`。

agent 读写的就是你手上这批 md：它可以补块引用、按编码本给候选编码、核对主题的支撑编码是否悬空、报告"没有证据的主题"。产出是 diff，你能看、能拒、能回退。

边界写死：分析判断留在人这边，agent 做可检查的机械工作。每次写入都留在文本里，可被下一个合作者或下一个 agent 复核——这是它相对"把材料贴进聊天框"站得住的地方。

### 快速开始

1. 装 `.vsix`（Releases 页，或自行 `npm run package`），用 VS Code 打开研究文件夹。
2. 光标停在材料段落，`Ctrl+Alt+B` 选一个编码文件：段落得到 `^id`，引用 `[[文件名#^id]]` 以列表项追加进该文件。
3. 给编码 / 主题文件写 `tags`（YAML 块式列表），或选中文件执行 `QDA: 定义为编码` / `QDA: 定义为主题`，侧边栏出现实体；用「加入编码…」「加入主题…」把三级结构搭起来。
4. 需要 agent 时运行 `QDA: 配置 Agent 工作流`。
5. 分析结束时运行 `QDA: 导出分析总表`，作为论文附录或审计件。

### 现状与路线

- 已实现：块引用与块引用库、编码管理（多父 DAG）、主题管理（平铺）、三级分析总表导出、agent 工作流配置。
- 待做：把格式写成版本化规范 + 校验器 + 一致性测试，让"不用本扩展也能用"成为可验证的承诺；主题的论述约束（提示而非门禁）。
- 不做：见「极简」一节。

### 兼容性

- **Foam / Obsidian**：`^id` 锚点与 `[[note#^id]]` 块引用是两者原生语法，同一批文件都能解析。
- **frontmatter**：`tags` 一律写成 YAML 块式列表（Obsidian 要求），Obsidian 标签面板与 Dataview 可直接检索：

```yaml
---
tags:
  - code
---
```

### 文档

架构决策与构想见 `docs/`（`docs/README.md` 为索引），该目录不进 vsix。

### 开发

```bash
npm install
npm run compile          # 编译
npm run package          # 打包 .vsix 到 releases/ 目录
```

### 键绑定

| 命令 | 默认键位 |
| --- | --- |
| QDA: 复制块引用至… | `Ctrl+Alt+B`（Markdown 文件） |
| QDA: 复制块引用 | 无（命令面板 / 右键菜单） |

### 界面语言

扩展界面支持中/英文，随 VS Code 的显示语言自动切换。

---

## License

MIT
