# kb-memory-dsh

一个 **纯文件、可人工 review** 的个人知识库插件（DSH Web profile 常驻）。

- **Host 半** 注册 `kb_*` 工具与一段常驻系统提示，让 agent 在日常会话里主动把可复用知识沉淀进 `<工作区>/knowledge-base/`。
- **Client 半** 在侧栏加一个「知识库」图标，点开是一个整页面板：左树浏览、右预览/编辑、新建/删除、重建索引。

## 目录

```
knowledge-base/            ← 知识库根目录（可用插件 config.root 覆盖）
├── INDEX.md               ← 总索引（自动生成）
└── <分类>/
    ├── _index.md          ← 分类说明（frontmatter: title/description）
    └── <条目>.md          ← 知识条目（frontmatter: title/updated/summary/tags）
```

## Agent 工具

| 工具 | 作用 |
|---|---|
| `kb_index` | 读顶层索引 |
| `kb_list` | 列分类 / 分类下条目 |
| `kb_read` | 读条目正文 |
| `kb_search` | 全文检索 |
| `kb_write` | 新建/覆盖条目 |
| `kb_append` | 追加更新 |

## 面板 HTTP 接口（宿主内部）

`GET /kb-memory/api/tree|index|entry` · `PUT /kb-memory/api/entry|category` · `DELETE /kb-memory/api/entry` · `POST /kb-memory/api/reindex`

## 自动更新

- 会话中：系统提示 + 每轮刷新的知识库现状上下文，提醒 agent 自主沉淀。
- 会话结束：`agent/turn-stopping` 钩子刷新快照，下一轮提示词带上最新规模。
