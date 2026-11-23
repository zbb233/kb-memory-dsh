/**
 * kb-memory-dsh —— 宿主半（多知识库 / 按项目软隔离版）。
 *
 * 提供一个「纯文件」的个人知识库，支持多个库按项目一对一绑定：
 *   ① 注册表 ~/.dsh/kb-memory/registry.json 记录 { libraries: [{id, name, root, projects[]}] }。
 *      每个库是磁盘上的一个目录，人类可以直接看、改、审。
 *   ② 注册一组 agent 工具（kb_index / kb_read / kb_list / kb_search / kb_write / kb_append），
 *      **每次调用必须带 library 参数（库 id）**，强制 agent 显式选库。
 *   ③ 注册常驻 systemPrompt 段：工具说明 + 「融合 vs 新建」强规则 + 项目绑定映射表 + 「静默」规则。
 *      未绑定当前工作区的会话，agent 不调用任何 kb_* 工具、不提及知识库（软隔离）。
 *   ④ 注册一个 HTTP 路由 /kb-memory/api/*，给浏览器面板做读/写 + 注册表管理（面板在 client 半）。
 *
 * 设计要点：
 *   - 知识库结构由文件自身表达：每个库根下每个子目录是一个「分类」，
 *     目录内每个 .md 是一个「知识条目」，分类的说明写在 <分类>/_index.md。
 *   - 每个库有一个总索引 INDEX.md，条目来源是扫描磁盘（而不是维护一份易失配的清单），
 *     保证「文件即真相」——人类增删文件后索引自动跟上。
 *   - 写操作直接用 node:fs（不走 DSH fs 服务）：fs 服务受沙箱 workspace-write 限制，
 *     而知识库根可能在工作区之外，会被 `file access denied under workspace-write mode` 拒掉。
 *   - 注册表读写用**同步** node:fs：systemPrompt 的 section/context 的 text() 是同步函数，
 *     装配提示词时不能 await。知识库正文读写仍用 node:fs/promises。
 *   - 「软隔离」靠提示词实现：工具拿不到会话 cwd（process.cwd() 是宿主进程 CWD，不是会话工作区），
 *     所以由 agent 读自己运行时上下文里的 Current working directory 自行判断该用哪个库。
 */

import { resolve as pathResolve, join as pathJoin, dirname as pathDirname, isAbsolute as pathIsAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

export const name = 'kb-memory-host'
/** fs 读写知识库；webServer 开面板 HTTP 路由；tools 注册 agent 工具；systemPrompt 挂提醒段。 */
export const inject = ['fs', 'webServer', 'tools', 'systemPrompt']

/** 单段分类目录名允许的字符：不含路径分隔符 `/`（由 categoryParts 逐段校验，防路径穿越与怪名）。 */
const CATEGORY_RE = /^[\p{L}\p{N}_\-.]+$/u
/** 嵌套分类最多几层，防止超深目录把 scan 拖慢。 */
const MAX_CATEGORY_DEPTH = 8
/** 知识条目文件名（不含 .md）。 */
const ENTRY_RE = /^[\p{L}\p{N}_\-. ]+$/u
/** 知识库 id（只允许字母/数字/下划线/横线）。 */
const LIB_RE = /^[A-Za-z0-9_-]+$/

const INDEX_FILE = 'INDEX.md'

function safeName(name, re, what) {
	if (typeof name !== 'string' || !name.trim()) throw new Error(`${what}不能为空`)
	const trimmed = name.trim()
	if (!re.test(trimmed)) throw new Error(`${what} "${trimmed}" 含有不允许的字符（可用：中英文、数字、下划线、横线、点、空格）`)
	if (trimmed === '.' || trimmed === '..') throw new Error(`${what}不合法`)
	return trimmed
}

/**
 * 把分类路径（如 `数仓/单用户CBU`）校验成路径段数组；单层分类返回 `[name]`。
 * 每段都按 CATEGORY_RE 校验，空段 / `.` / `..` 一律拒绝，避免 pathJoin 把分类名当路径穿越出知识库根。
 */
function categoryParts(name, what = '分类名') {
	if (typeof name !== 'string' || !name.trim()) throw new Error(`${what}不能为空`)
	const trimmed = name.trim()
	const parts = trimmed.split('/')
	if (parts.length > MAX_CATEGORY_DEPTH) throw new Error(`${what}层级过深（最多 ${MAX_CATEGORY_DEPTH} 层）：${trimmed}`)
	for (const p of parts) {
		if (!p) throw new Error(`${what} "${trimmed}" 含空路径段（不能有前导/尾随斜杠或连续斜杠）`)
		if (!CATEGORY_RE.test(p)) throw new Error(`${what} "${trimmed}" 含不允许的字符（每段可用：中英文、数字、下划线、横线、点；层级用 / 分隔）`)
		if (p === '.' || p === '..') throw new Error(`${what}不合法：${trimmed}`)
	}
	return parts
}

function today() {
	const d = new Date()
	const pad = (n) => String(n).padStart(2, '0')
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function yamlStr(s) {
	const v = String(s).replace(/["\\]/g, '\\$&').replace(/\n/g, ' ')
	return `"${v}"`
}

export function apply(ctx, config) {
	const log = ctx.logger?.('kb-memory') ?? ctx.logger

	/* ────────────────────────────── 注册表（同步） ────────────────────────────── */

	/** 注册表路径可由 cordis config.registryPath 覆盖；默认放在 ~/.dsh/kb-memory/。 */
	const registryPath = config?.registryPath && typeof config.registryPath === 'string'
		? config.registryPath
		: pathJoin(homedir(), '.dsh', 'kb-memory', 'registry.json')

	/** 每个库最近一次 scan 的快照，供同步的提示词上下文使用。 */
	const statusByLib = {}

	/** 同步读注册表：缺失/损坏时返回空注册表，不让插件崩掉。 */
	function loadRegistry() {
		try {
			const data = JSON.parse(readFileSync(registryPath, 'utf8'))
			if (!data || !Array.isArray(data.libraries)) return { version: 1, libraries: [] }
			return { version: 1, libraries: data.libraries }
		} catch {
			return { version: 1, libraries: [] }
		}
	}

	/** 校验并规范化注册表；一对一冲突会直接抛错。 */
	function normalizeRegistry(input) {
		if (!input || !Array.isArray(input.libraries)) throw new Error('registry.libraries 必须是数组')
		const seenLibs = new Set()
		const seenProjects = new Map()
		const libraries = input.libraries.map((raw) => {
			const id = String(raw?.id || '').trim()
			if (!LIB_RE.test(id)) throw new Error(`知识库 id 不合法："${id}"（只允许字母、数字、下划线、横线）`)
			if (seenLibs.has(id)) throw new Error(`知识库 id 重复：${id}`)
			seenLibs.add(id)

			const name = String(raw?.name || id).trim() || id
			const rootRaw = String(raw?.root || '').trim()
			if (!rootRaw) throw new Error(`知识库 ${id} 缺少 root（必须是绝对路径）`)
			if (!pathIsAbsolute(rootRaw)) throw new Error(`知识库 ${id} 的 root 必须是绝对路径："${rootRaw}"`)
			const root = pathResolve(rootRaw)

			const projects = []
			for (const p of Array.isArray(raw?.projects) ? raw.projects : []) {
				const v = String(p || '').trim().replace(/\/+$/, '')
				if (!v) continue
				if (!pathIsAbsolute(v)) throw new Error(`项目路径必须是绝对路径："${v}"`)
				const abs = pathResolve(v)
				if (!projects.includes(abs)) projects.push(abs)
			}
			for (const p of projects) {
				const prev = seenProjects.get(p)
				if (prev && prev !== id) throw new Error(`一对一冲突：项目 ${p} 同时绑定了知识库 ${prev} 和 ${id}`)
				seenProjects.set(p, id)
			}
			return { id, name, root, projects }
		})
		return { version: 1, libraries }
	}

	function libById(id) {
		const reg = loadRegistry()
		const lib = reg.libraries.find((l) => l.id === String(id || ''))
		if (!lib) {
			const avail = reg.libraries.map((l) => l.id).join(', ') || '（注册表为空，尚未配置任何知识库）'
			throw new Error(`未知知识库 library="${id}"；可用：${avail}`)
		}
		return lib
	}

	/** 工具层强制必填：不传 library 直接报错，杜绝「猜一个库去写」。 */
	function requireLib(id) {
		if (!id || !String(id).trim()) throw new Error('缺少必填参数 library（知识库 id）。先按上方「项目绑定与静默」规则确认当前工作区命中的库；当前工作区未绑定任何库时本会话应保持静默、不要调用 kb_* 工具。')
		return libById(id)
	}

	/** 写注册表 + 初始化新库目录 + 刷新全部快照。 */
	async function saveRegistry(input) {
		const reg = normalizeRegistry(input)
		mkdirSync(pathDirname(registryPath), { recursive: true })
		writeFileSync(registryPath, JSON.stringify(reg, null, 2) + '\n', 'utf8')
		for (const lib of reg.libraries) await initLibrary(lib)
		await refreshAll()
		return reg
	}

	/* ────────────────────────────── 路径与布局（按库参数化） ────────────────────────────── */

	let nodeFs = null
	async function getNodeFs() {
		if (!nodeFs) nodeFs = await import('node:fs/promises')
		return nodeFs
	}

	function resolveUnder(lib, relParts) {
		return pathJoin(lib.root, ...relParts)
	}

	async function ensureDir(lib, relParts) {
		const { mkdir } = await getNodeFs()
		const abs = relParts.length ? resolveUnder(lib, relParts) : lib.root
		await mkdir(abs, { recursive: true })
		return abs
	}

	async function readTextIfExists(lib, relParts) {
		try {
			const { readFile, stat } = await getNodeFs()
			const abs = resolveUnder(lib, relParts)
			const info = await stat(abs)
			if (!info.isFile()) return null
			return await readFile(abs, 'utf8')
		} catch {
			return null
		}
	}

	async function writeText(lib, relParts, content) {
		const { writeFile } = await getNodeFs()
		await ensureDir(lib, relParts.length > 1 ? relParts.slice(0, -1) : [])
		const abs = resolveUnder(lib, relParts)
		await writeFile(abs, content, 'utf8')
	}

	async function listDirIfExists(lib, relParts) {
		try {
			const { readdir } = await getNodeFs()
			const abs = relParts.length ? resolveUnder(lib, relParts) : lib.root
			const entries = await readdir(abs, { withFileTypes: true })
			return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
		} catch {
			return []
		}
	}

	/* ────────────────────────────── 知识库模型 ────────────────────────────── */

	/** 扫描某个库，返回 { id, name, root, projects, categories }。
	 *  categories 是先序 DFS 的扁平列表：name 为完整分类路径（如 `数仓/单用户CBU`），
	 *  带 depth / parent / children，供 INDEX.md 与面板按层级渲染；单层分类仍是 `数仓`。 */
	async function scan(libId) {
		const lib = libById(libId)
		const categories = []

		async function walk(parts, depth) {
			const name = parts.join('/')
			const metaText = await readTextIfExists(lib, [...parts, '_index.md'])
			const entries = []
			const childDirs = []
			for (const f of await listDirIfExists(lib, parts)) {
				if (f.type === 'directory') {
					if (CATEGORY_RE.test(f.name) && f.name !== '.' && f.name !== '..') childDirs.push(f.name)
					continue
				}
				if (!f.name.toLowerCase().endsWith('.md')) continue
				if (f.name === '_index.md') continue
				const ename = f.name.replace(/\.md$/i, '')
				const body = (await readTextIfExists(lib, [...parts, f.name])) ?? ''
				entries.push({ name: ename, ...parseEntry(body) })
			}
			entries.sort((a, b) => b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name))
			childDirs.sort((a, b) => a.localeCompare(b))
			categories.push({
				name,
				depth,
				parent: depth > 0 ? parts.slice(0, -1).join('/') : '',
				children: depth < MAX_CATEGORY_DEPTH ? childDirs.map((d) => `${name}/${d}`) : [],
				meta: parseCategoryMeta(metaText),
				entries,
			})
			if (depth < MAX_CATEGORY_DEPTH) {
				for (const d of childDirs) await walk([...parts, d], depth + 1)
			}
		}

		const rootEntries = await listDirIfExists(lib, [])
		const tops = rootEntries
			.filter((e) => e.type === 'directory' && CATEGORY_RE.test(e.name))
			.map((e) => e.name)
			.sort((a, b) => a.localeCompare(b))
		for (const t of tops) await walk([t], 0)
		const result = { id: lib.id, name: lib.name, root: lib.root, projects: lib.projects, categories }
		statusByLib[lib.id] = result
		return result
	}

	function parseCategoryMeta(text) {
		if (!text) return { title: '', description: '' }
		const fm = frontmatter(text)
		return { title: fm.title || '', description: fm.description || '' }
	}

	/** 条目正文：支持 YAML frontmatter（title/updated/summary/tags）。 */
	function parseEntry(body) {
		const fm = frontmatter(body)
		const noFm = stripFrontmatter(body)
		const firstHeading = (noFm.match(/^\s*#\s+(.+)$/m) || [])[1] || ''
		const summary =
			fm.summary ||
			noFm.replace(/^\s*#.*$/m, '').replace(/\s+/g, ' ').trim().slice(0, 160)
		return {
			title: fm.title || firstHeading || '',
			updated: fm.updated || '',
			summary,
			tags: fm.tags || [],
		}
	}

	function frontmatter(text) {
		const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
		if (!m) return {}
		const out = {}
		for (const line of m[1].split(/\r?\n/)) {
			const mm = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/)
			if (!mm) continue
			let v = mm[2].trim()
			if (/^\[.*\]$/.test(v)) {
				v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
			} else {
				v = v.replace(/^["']|["']$/g, '')
			}
			out[mm[1]] = v
		}
		return out
	}

	function stripFrontmatter(text) {
		return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
	}

	/** 生成 INDEX.md：全库分类 + 条目大纲。 */
	async function renderIndex(scanResult) {
		const s = scanResult
		const lines = []
		lines.push('<!-- 本文件由 kb-memory-dsh 自动生成，请勿手工破坏结构；可自由增删分类目录与条目文件，索引会在下次重建时跟上。 -->')
		lines.push('')
		lines.push('# 知识库索引')
		lines.push('')
		lines.push(`> 知识库：\`${s.name}\`（id=\`${s.id}\`）　·　根目录：\`${s.root}\`　·　分类 ${s.categories.length} 个　·　条目 ${s.categories.reduce((n, c) => n + c.entries.length, 0)} 条`)
		if (s.projects?.length) lines.push(`> 绑定项目：${s.projects.map((p) => `\`${p}\``).join('、')}`)
		lines.push('')
		lines.push('## 分类')
		lines.push('')
		for (const c of s.categories) {
			const title = c.meta.title || c.name
			const hashes = '#'.repeat(Math.min(3 + (c.depth || 0), 6))
			lines.push(`${hashes} ${title}　\`${c.name}/\``)
			if (c.meta.description) lines.push(`> ${c.meta.description}`)
			lines.push('')
			if (!c.entries.length) {
				lines.push('_（暂无条目）_')
				lines.push('')
				continue
			}
			for (const e of c.entries) {
				const upd = e.updated ? `　·　_${e.updated}_` : ''
				const sum = e.summary ? ` —— ${e.summary}` : ''
				lines.push(`- [${e.title || e.name}](${c.name}/${e.name}.md)${sum}${upd}`)
			}
			lines.push('')
		}
		return lines.join('\n')
	}

	async function rebuildIndex(libId) {
		const s = await scan(libId)
		const text = await renderIndex(s)
		await writeText(libById(libId), [INDEX_FILE], text)
		return text
	}

	async function initLibrary(lib) {
		const { mkdir } = await getNodeFs()
		await mkdir(lib.root, { recursive: true })
		await rebuildIndex(lib.id)
	}

	/** 为分类路径上的每一层补 _index.md：嵌套分类的父层也要有，面板/索引才认得。 */
	async function ensureCategoryIndexes(lib, catParts) {
		for (let i = 1; i <= catParts.length; i++) {
			const parts = catParts.slice(0, i)
			if (await readTextIfExists(lib, [...parts, '_index.md'])) continue
			const label = parts[parts.length - 1]
			await writeText(lib, [...parts, '_index.md'], `---\ntitle: ${yamlStr(label)}\n---\n\n# ${label}\n`)
		}
	}

	/** 刷新所有库的快照，并清掉已删除库的缓存。 */
	async function refreshAll() {
		const reg = loadRegistry()
		for (const lib of reg.libraries) {
			try {
				await scan(lib.id)
			} catch (error) {
				log?.warn?.('kb-memory: 扫描知识库 ' + lib.id + ' 失败 ' + String(error?.message || error))
			}
		}
		const ids = new Set(reg.libraries.map((l) => l.id))
		for (const id of Object.keys(statusByLib)) if (!ids.has(id)) delete statusByLib[id]
	}

	// 启动时刷一次快照（只读，不创建目录、不写 INDEX.md）。
	refreshAll().catch((error) => log?.warn?.('kb-memory: 首次扫描失败 ' + String(error?.message || error)))

	/* ────────────────────────────── Agent 工具 ────────────────────────────── */

	const ok = (summary, data) => ({ ok: true, summary, data })
	const LIB_PARAM = {
		type: 'string',
		description: '知识库 id（必填）。先按上方「项目绑定与「静默」规则」确认当前工作区命中的库并填它的 id；当前工作区未绑定任何库时本会话应保持静默、不要调用本工具。',
	}

	ctx.effect(() =>
		ctx.tools.register({
			name: 'kb_index',
			description:
				'读取个人知识库的顶层索引（分类与条目大纲）。写知识前先用它了解已有分类，避免重复造分类。必须带 library 参数指定知识库。',
			parameters: { type: 'object', properties: { library: LIB_PARAM }, required: ['library'], additionalProperties: false },
			output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
			async execute(args) {
				const lib = requireLib(args?.library)
				const existing = await readTextIfExists(lib, [INDEX_FILE])
				if (existing) return existing
				return await rebuildIndex(lib.id)
			},
		})
	)

	ctx.effect(() =>
		ctx.tools.register({
			name: 'kb_list',
			description: '列出知识库的分类；给 category 时列出该分类下的条目（名字/标题/更新时间/摘要）。必须带 library 参数指定知识库。',
			parameters: {
				type: 'object',
				properties: {
					library: LIB_PARAM,
					category: { type: 'string', description: '分类路径（可用 `/` 写多级，如 `数仓/单用户CBU`）；省略则只列分类' },
				},
				required: ['library'],
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
			},
			async execute(args) {
				const lib = requireLib(args?.library)
				const s = await scan(lib.id)
				if (args && args.category) {
					const key = categoryParts(args.category).join('/')
					const c = s.categories.find((x) => x.name === key)
					if (!c) return ok(`没有分类 ${key}`, { error: 'category not found', categories: s.categories.map((x) => x.name) })
					return ok(`分类 ${c.name} 有 ${c.entries.length} 条`, c)
				}
				return ok(`共 ${s.categories.length} 个分类`, {
					categories: s.categories.map((c) => ({ name: c.name, depth: c.depth, parent: c.parent, title: c.meta.title, description: c.meta.description, count: c.entries.length })),
				})
			},
		})
	)

	ctx.effect(() =>
		ctx.tools.register({
			name: 'kb_read',
			description: '读取某个知识条目的完整内容。参数 library（知识库 id）、category（分类路径，可用 `/` 写多级，如 `数仓/单用户CBU`）与 name（条目名，不含 .md）。',
			parameters: {
				type: 'object',
				properties: {
					library: LIB_PARAM,
					category: { type: 'string', description: '分类路径，可用 `/` 写多级' },
					name: { type: 'string' },
				},
				required: ['library', 'category', 'name'],
				additionalProperties: false,
			},
			output: {
				schema: { type: 'string' },
				render: (_a, v) => [{ type: 'text', text: String(v) }],
			},
			async execute(args) {
				const lib = requireLib(args?.library)
				const catParts = categoryParts(args.category)
				const cat = catParts.join('/')
				const nm = safeName(args.name, ENTRY_RE, '条目名')
				const text = await readTextIfExists(lib, [...catParts, `${nm}.md`])
				if (text == null) throw new Error(`条目不存在：${lib.id}/${cat}/${nm}.md`)
				return text
			},
		})
	)

	ctx.effect(() =>
		ctx.tools.register({
			name: 'kb_search',
			description: '在知识库里做全文关键字搜索（大小写不敏感），返回命中的分类/条目与片段。必须带 library 参数指定知识库。',
			parameters: {
				type: 'object',
				properties: {
					library: LIB_PARAM,
					query: { type: 'string', description: '关键字' },
					limit: { type: 'integer', description: '最多返回条数，默认 20' },
				},
				required: ['library', 'query'],
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
			},
			async execute(args) {
				const lib = requireLib(args?.library)
				const q = String(args.query || '').trim().toLowerCase()
				if (!q) throw new Error('query 不能为空')
				const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
				const s = await scan(lib.id)
				const hits = []
				for (const c of s.categories) {
					const catParts = c.name.split('/')
					for (const e of c.entries) {
						const body = (await readTextIfExists(lib, [...catParts, `${e.name}.md`])) ?? ''
						const idx = body.toLowerCase().indexOf(q)
						if (idx === -1 && !(e.title || '').toLowerCase().includes(q)) continue
						const snippet = idx === -1 ? e.summary : body.slice(Math.max(0, idx - 40), idx + 120).replace(/\s+/g, ' ').trim()
						hits.push({ category: c.name, name: e.name, title: e.title, snippet })
						if (hits.length >= limit) break
					}
					if (hits.length >= limit) break
				}
				return ok(`命中 ${hits.length} 条`, { library: lib.id, query: args.query, hits })
			},
		})
	)

	ctx.effect(() =>
		ctx.tools.register({
			name: 'kb_write',
			description:
				'在知识库写入（覆盖）一个知识条目。参数：library（知识库 id，必填）、category（分类路径，可用 `/` 写多级如 `数仓/单用户CBU`，不存在的层级自动建）、name（条目名）、title、summary、content、tags。',
			parameters: {
				type: 'object',
				properties: {
					library: LIB_PARAM,
					category: { type: 'string', description: '分类路径，可用 `/` 写多级' },
					name: { type: 'string' },
					title: { type: 'string' },
					summary: { type: 'string' },
					content: { type: 'string' },
					tags: { type: 'array', items: { type: 'string' } },
				},
				required: ['library', 'category', 'name', 'content'],
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
			},
			async execute(args) {
				const lib = requireLib(args?.library)
				const catParts = categoryParts(args.category)
				const cat = catParts.join('/')
				const nm = safeName(args.name, ENTRY_RE, '条目名')
				const title = String(args.title || nm)
				const summary = String(args.summary || '').replace(/\s+/g, ' ').trim().slice(0, 200)
				const tags = Array.isArray(args.tags) ? args.tags.map(String) : []
				const body = stripFrontmatter(String(args.content || '')).trimStart()
				const fmLines = ['---', `title: ${yamlStr(title)}`, `updated: ${today()}`]
				if (summary) fmLines.push(`summary: ${yamlStr(summary)}`)
				if (tags.length) fmLines.push(`tags: [${tags.map(yamlStr).join(', ')}]`)
				fmLines.push('---', '')
				const text = fmLines.join('\n') + (body.startsWith('#') ? '' : `# ${title}\n\n`) + body + (body.endsWith('\n') ? '' : '\n')
				await writeText(lib, [...catParts, `${nm}.md`], text)
				// 保证分类路径上每一层都有 _index.md（嵌套分类的父层也要建）
				await ensureCategoryIndexes(lib, catParts)
				await rebuildIndex(lib.id)
				return ok(`已写入 ${lib.id}/${cat}/${nm}.md`, { library: lib.id, path: `${cat}/${nm}.md`, title, updated: today() })
			},
		})
	)

	ctx.effect(() =>
		ctx.tools.register({
			name: 'kb_append',
			description: '往一个已存在（或新建）的知识条目末尾追加一段 Markdown。分类路径可用 `/` 写多级。必须带 library 参数指定知识库。',
			parameters: {
				type: 'object',
				properties: {
					library: LIB_PARAM,
					category: { type: 'string', description: '分类路径，可用 `/` 写多级' },
					name: { type: 'string' },
					content: { type: 'string' },
				},
				required: ['library', 'category', 'name', 'content'],
				additionalProperties: false,
			},
			output: {
				schema: { type: 'object' },
				render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
			},
			async execute(args) {
				const lib = requireLib(args?.library)
				const catParts = categoryParts(args.category)
				const cat = catParts.join('/')
				const nm = safeName(args.name, ENTRY_RE, '条目名')
				const add = stripFrontmatter(String(args.content || '')).trim()
				const prev = (await readTextIfExists(lib, [...catParts, `${nm}.md`])) ?? ''
				let text = prev
				if (!prev) {
					text = `---\ntitle: ${yamlStr(nm)}\nupdated: ${today()}\n---\n\n# ${nm}\n`
				} else {
					// 更新 frontmatter 里的 updated
					text = prev.replace(/(^---\r?\n[\s\S]*?\r?\n---)/, (m) =>
						/^updated\s*:/m.test(m) ? m.replace(/^updated\s*:.*$/m, `updated: ${today()}`) : m.replace(/\n---$/, `\nupdated: ${today()}\n---`)
					)
				}
				const sep = text.endsWith('\n') ? '\n' : '\n\n'
				text = text + sep + add + '\n'
				await writeText(lib, [...catParts, `${nm}.md`], text)
				await ensureCategoryIndexes(lib, catParts)
				await rebuildIndex(lib.id)
				return ok(`已追加到 ${lib.id}/${cat}/${nm}.md`, { library: lib.id, path: `${cat}/${nm}.md`, updated: today() })
			},
		})
	)

	/* ────────────────────────── systemPrompt 维护提醒 ────────────────────────── */

	// 「融合 vs 新建」强规则的精简版：每轮 context 都会带（section 里是完整版）。
	// 这条规则是硬性的：任何写入前必须先结合全库现状做判定，禁止不看就写。
	const MERGE_RULE_SHORT = [
		'**★ 写入前的强规则（每次更新都必须执行）**：动手写之前，先 `kb_index` 看全库 + `kb_search` 搜主题关键词 + `kb_read` 读最相关条目，然后二选一：',
		'- **★ 先确认工作区再动手**：本插件按项目绑定多个知识库（映射表见上方常驻规则）；调用任何 `kb_*` 工具前先确认当前工作区命中哪个库，并把对应的 `library` id 传进去。当前工作区未绑定任何库时本会话应保持静默、不要使用 kb_* 工具。',
		'- **已有相关条目 → 必须融合**：补充用 `kb_append` 追加；需重组才用 `kb_write` 覆盖，但必须把旧内容合并进新正文、不能丢旧信息。',
		'- **★ 防重复（写前必做全文比对）**：`kb_read` 全文后，若待写信息已在该条目正文里、或本会话已写过 → **直接跳过，不追加、不覆盖**；同一主题别反复融合。补充优先用 `kb_write` 整篇覆盖（幂等），少用 `kb_append`（纯追加、零查重）；覆盖前重读最新全文再合并，避免与并行会话互相盖掉。',
		'- **★ 融合要「正文 + 标题 + 摘要」三者一起改**：条目的 `title`、正文一级标题、`summary`、`tags` 必须同步扩写成覆盖新旧两块；正文要重组为并列章节，不要只在末尾挂「补：xxx」的补丁章节。标题停在旧范围 = 名实不符，等于没融合好。',
		'- **确认全库无相关条目 → 才新建**：`kb_write` 新条目，优先归入已有分类，没有合适分类才新建。',
		'- **严禁**：不看就写、同主题拆成多个碎片条目、造重复分类、覆盖时丢旧内容、融合时标题/摘要不跟随更新、层层追加补丁。写后在回复里说明「已融合进 X」或「新建 X」。',
	].join('\n')

	/** 项目绑定映射表 + 「静默」规则（常驻 section 与每轮 context 都要能读到最新注册表）。 */
	function bindingRuleLines() {
		const reg = loadRegistry()
		const lines = [
			'### ★ 项目绑定与「静默」规则（调用任何 kb_* 工具前必须先判断）',
			'',
			'本插件支持**多个知识库**，按项目（工作区绝对路径）**一对一**绑定。当前注册表（`library` 参数填库 id）：',
			'',
			'| 库 id | 名称 | 绑定的项目（工作区绝对路径） |',
			'| --- | --- | --- |',
		]
		if (!reg.libraries.length) lines.push('| （无） | — | 尚未配置任何知识库 |')
		for (const l of reg.libraries) {
			const projs = l.projects.length ? l.projects.map((p) => `\`${p}\``).join('<br>') : '（未绑定项目）'
			lines.push(`| \`${l.id}\` | ${l.name} | ${projs} |`)
		}
		lines.push(
			'',
			'1. 先看本轮运行时上下文里的 `Current working directory`（你的工作区绝对路径；比对时忽略末尾斜杠）。',
			'2. 命中上表某一行 → 本会话**启用**该库；此后所有 `kb_*` 调用都必须带 `library` 参数并填该行的库 id。',
			'3. 一行都没命中 → 本会话**未启用知识库（静默）**：不要调用任何 `kb_*` 工具、不要提及知识库、不要读写任何条目、不要在回复里说「已融合进 X」或「新建 X」。只有用户明确点名某个知识库时，才按用户指定的 `library` 执行。',
			'4. **一对一**：一个项目只绑一个库；不要跨库融合、不要把 A 库的内容写进 B 库；条目里的 `分类/条目名.md` 交叉引用只在同一个库内有效。',
			'5. 不确定工作区是否绑定时，宁可静默，也不要猜一个库去写。',
		)
		return lines
	}

	// 每轮都会重算的动态上下文：报告各库当前规模 + 强规则精简版。
	// 2026-11-14：B 档「上一轮收尾复盘」提醒与每轮「收尾提醒」已移除，避免提醒疲劳与重复写入。
	ctx.effect(() =>
		ctx.systemPrompt.context({
			name: 'kb-memory-status',
			order: 4000,
			text: () => {
				const reg = loadRegistry()
				const head = '## 知识库现状（kb-memory）'
				const lines = [head, '', `注册表 \`${registryPath}\`　知识库 ${reg.libraries.length} 个　**仅当你的工作区命中绑定时使用**（映射表见上方常驻规则）：`]
				if (!reg.libraries.length) lines.push('- （尚未配置任何知识库；本会话应按静默规则处理）')
				for (const lib of reg.libraries) {
					const s = statusByLib[lib.id]
					const scale = s
						? `分类 ${s.categories.length} 个 · 条目 ${s.categories.reduce((n, c) => n + c.entries.length, 0)} 条`
						: '（尚未扫描）'
					const projs = lib.projects.length ? lib.projects.join('、') : '（未绑定项目）'
					lines.push(`- \`${lib.id}\`（${lib.name}）· root=\`${lib.root}\` · ${scale} · 绑定：${projs}`)
				}
				return lines.join('\n') + '\n\n' + MERGE_RULE_SHORT
			},
		})
	)

	ctx.effect(() =>
		ctx.systemPrompt.section({
			name: 'kb-memory',
			order: 60,
			text: () => [
				'## 个人知识库（kb-memory）',
				'',
				'本工作区维护着一个纯文件的个人知识库，你通过 kb_* 工具读写它。**先按下面的绑定规则判断本会话是否启用知识库**：',
				'',
				...bindingRuleLines(),
				'',
				'### 工具（所有 kb_* 工具都必须带 `library` 参数）',
				'',
				'- `kb_index`：查看库的顶层索引（分类 + 条目大纲）。',
				'- `kb_list` / `kb_read` / `kb_search`：浏览与检索。',
				'- `kb_write`：新建或整篇覆盖一个条目；`kb_append`：往条目末尾追加更新。',
				'- **分类支持多级**：`category` 可用 `/` 写路径（如 `数仓/单用户CBU`），每层会自动建目录与 `_index.md`；`kb_list` / `kb_read` / `kb_write` / `kb_append` 都按完整路径定位，交叉引用也要写完整路径。',
				'',
				'### ★ 写入前的强规则（每次更新都必须遵守，不可跳过）',
				'',
				'**在动手写任何内容之前，必须先结合知识库整体情况做一次「融合 vs 新建」判定**：',
				'1. 先 `kb_index` 看全库分类与条目大纲，再用 `kb_search`（用主题关键词、表名、平台名等）查是否已有相关条目，最后 `kb_read` 读最相关的 1–2 条。',
				'2. **命中已有条目（同一对象 / 同一主题 / 同一张表 / 同一个平台操作）→ 必须「融合」，不得另起新条目**：',
				'   - 补充新信息 → 用 `kb_append` 追加到该条目末尾（并更新 updated）；',
				'   - 需要重组/纠错 → 可用 `kb_write` 整篇覆盖，但**必须把旧条目里有价值的内容合并进新正文**，绝不能把旧信息丢掉；',
				'   - **★ 防重复（写前必做全文比对，杜绝重复）**：`kb_read` 读到相关条目后，若待写信息已在该条目正文里、或本会话已经写过 → **直接跳过，不追加、不覆盖**；同一主题不要反复融合。补充优先用 `kb_write` 整篇覆盖（幂等），少用 `kb_append`（纯追加、零查重）；覆盖前重读最新全文再合并旧内容，避免与并行会话互相盖掉。',
				'   - **★ 融合要「正文 + 标题 + 摘要」三者一起改**：条目的 `title`、正文一级标题、`summary`、`tags` 都要同步扩写成覆盖新旧两部分；正文要重组为并列章节，不要只在末尾挂「补：xxx」的补丁章节。标题停在旧范围会让人从索引上误判条目范围，等于没融合好；',
				'   - 融合后摘要 `summary` 要能覆盖新旧两部分内容；文件名（`name`）一般保持不变，避免别的条目里的交叉引用失效。',
				'3. **确认全库确实没有相关条目 → 才「新建」**：用 `kb_write` 创建，优先归入已有分类；确实没有合适分类才新建分类（用动词/名词命名，如 `数仓`、`平台操作`、`飞书文档`）。',
				'4. **严禁**：不看就写、把同一主题拆成多个碎片条目、造语义重复的分类、用 `kb_write` 覆盖时丢掉旧内容、融合时标题/摘要不跟随更新、层层追加补丁章节、跨库融合。',
				'5. 判定结果要在回复里说一句（如「已融合进 数仓/xxx」或「新建 平台操作/xxx」），便于人 review。',
				'',
				'**何时写**：当一轮对话产出了值得长期保留、跨会话复用的知识（例如：某张表的字段口径、某个平台的操作步骤、一次排障的结论、一条团队约定）时，主动沉淀，不必等人提醒、也不必征求确认。',
				'**怎么写**：条目正文用 Markdown，写清「是什么、怎么做、为什么、坑在哪」；一句话摘要放进 summary；正文带日期；**融合时 title、正文一级标题、summary、tags 必须与正文一起扩写**。',
				'**别写什么**：一次性的闲聊、临时状态、密钥与密码等敏感信息、可从代码实时得出且不会变化的事实。宁可少写，不要污染知识库。',
				'**审阅**：人是最终的校对者；你的职责是让每条记录清晰、可核对、带日期。',
			].join('\n'),
		})
	)

	/* ────────────────────────── 会话结束钩子：只刷快照 ────────────────────────── */

	// 设计原则：**不往 turn 循环里注入消息**（agent.inject 会进 agent/pre-step 的 admission 流程，
	// 结构不符会让整轮判失败——已实测踩过）。B 档复盘提醒已移除，这里只刷新所有库的快照。
	ctx.effect(() =>
		ctx.on('agent/turn-stopping', async () => {
			try {
				await refreshAll()
			} catch (error) {
				log?.warn?.('kb-memory: 刷新知识库快照失败 ' + String(error?.message || error))
			}
		})
	)

	/* ────────────────────────────── HTTP 路由（供面板） ────────────────────────────── */
	function sendJson(res, status, obj) {
		const body = JSON.stringify(obj)
		res.writeHead?.(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
		res.end(body)
	}

	async function readBody(req) {
		const chunks = []
		for await (const c of req) chunks.push(c)
		return Buffer.concat(chunks).toString('utf8')
	}

	ctx.effect(() =>
		ctx.webServer.register({
			kind: 'prefix',
			path: '/kb-memory/api',
			handler: async (req, res) => {
				try {
					const url = new URL(req.url, 'http://localhost')
					const p = url.pathname.replace(/^\/kb-memory\/api/, '') || '/'
					const method = req.method || 'GET'

					// 注册表管理：GET 读 / PUT 整份覆盖（面板管理弹窗用）
					if (p === '/registry' && method === 'GET') {
						return sendJson(res, 200, { ok: true, ...loadRegistry(), registryPath })
					}
					if (p === '/registry' && method === 'PUT') {
						const payload = JSON.parse((await readBody(req)) || '{}')
						const reg = await saveRegistry(payload)
						return sendJson(res, 200, { ok: true, ...reg, registryPath })
					}

					// 其余路由都要选一个库（面板总是带 lib；缺省回退到第一个库）
					const pickLib = (payload) => {
						const id = url.searchParams.get('lib') || payload?.library || loadRegistry().libraries[0]?.id
						if (!id) throw new Error('尚未配置任何知识库；请先在面板「管理」里新建知识库')
						return libById(id)
					}

					if (p === '/tree' && method === 'GET') {
						const lib = pickLib(null)
						const s = await scan(lib.id)
						return sendJson(res, 200, { ok: true, ...s })
					}
					if (p === '/index' && method === 'GET') {
						const lib = pickLib(null)
						const text = (await readTextIfExists(lib, [INDEX_FILE])) ?? (await rebuildIndex(lib.id))
						return sendJson(res, 200, { ok: true, text })
					}
					if (p === '/entry' && method === 'GET') {
						const lib = pickLib(null)
						const catParts = categoryParts(url.searchParams.get('category'))
						const nm = safeName(url.searchParams.get('name'), ENTRY_RE, '条目名')
						const text = await readTextIfExists(lib, [...catParts, `${nm}.md`])
						if (text == null) return sendJson(res, 404, { ok: false, error: 'not found' })
						return sendJson(res, 200, { ok: true, text })
					}
					if (p === '/entry' && method === 'PUT') {
						const payload = JSON.parse((await readBody(req)) || '{}')
						const lib = pickLib(payload)
						const catParts = categoryParts(payload.category)
						const nm = safeName(payload.name, ENTRY_RE, '条目名')
						if (typeof payload.text !== 'string') return sendJson(res, 400, { ok: false, error: 'text required' })
						await writeText(lib, [...catParts, `${nm}.md`], payload.text)
						await ensureCategoryIndexes(lib, catParts)
						await rebuildIndex(lib.id)
						return sendJson(res, 200, { ok: true, library: lib.id })
					}
					if (p === '/entry' && method === 'DELETE') {
						const lib = pickLib(null)
						const catParts = categoryParts(url.searchParams.get('category'))
						const nm = safeName(url.searchParams.get('name'), ENTRY_RE, '条目名')
						const { rm } = await getNodeFs()
						const abs = resolveUnder(lib, [...catParts, `${nm}.md`])
						await rm(abs, { force: true })
						await rebuildIndex(lib.id)
						return sendJson(res, 200, { ok: true, library: lib.id })
					}
					if (p === '/category' && method === 'PUT') {
						const payload = JSON.parse((await readBody(req)) || '{}')
						const lib = pickLib(payload)
						const catParts = categoryParts(payload.category)
						const cat = catParts.join('/')
						const title = String(payload.title || catParts[catParts.length - 1])
						const description = String(payload.description || '')
						await ensureDir(lib, catParts)
						await ensureCategoryIndexes(lib, catParts.slice(0, -1))
						await writeText(lib, [...catParts, '_index.md'], `---\ntitle: ${yamlStr(title)}\ndescription: ${yamlStr(description)}\n---\n\n# ${title}\n`)
						await rebuildIndex(lib.id)
						return sendJson(res, 200, { ok: true, library: lib.id })
					}
					if (p === '/reindex' && method === 'POST') {
						const lib = pickLib(null)
						const text = await rebuildIndex(lib.id)
						return sendJson(res, 200, { ok: true, library: lib.id, text })
					}
					return sendJson(res, 404, { ok: false, error: `unknown route ${p}` })
				} catch (error) {
					sendJson(res, 500, { ok: false, error: String(error?.message || error) })
				}
			},
		})
	)

	log?.info?.('kb-memory: 已就绪，注册表 = ' + registryPath + '，知识库 ' + loadRegistry().libraries.length + ' 个')
}
