/**
 * kb-memory-dsh —— 客户端半（浏览器面板）。
 *
 * 侧栏一个「书页」图标（sidebar.panellist，id = kb-memory），点开在 main 槽渲染整页面板。
 * 面板从宿主 /kb-memory/api/* 读写知识库：
 *   - 左：分类树 → 条目列表（标题 / 更新时间 / 摘要）
 *   - 右：选中条目 Markdown 预览；「编辑」切源码框，保存写盘
 *   - 操作：新建条目、编辑分类说明、删除条目、重建索引
 *
 * 约束（遵循 practices）：不 require Harness Client 包，自己写控件；用主题 token；
 * 全部资源在 apply 内注册。不写新的 session event。
 */

window.__ModuleLoader__.load({
  id: 'kb-memory-dsh',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /* ───────────────────────────── API ───────────────────────────── */

    // bridge 路径相对页面 base 解析（与 dsh-free-search 一致）。
    function apiBase() {
      return '/kb-memory/api'
    }

    // 当前选中的知识库 id：api() 会把 lib=<id> 注入每个业务请求。
    // /registry 路由不需要 lib（带上也会被宿主忽略），所以跳过。
    let currentLibId = null
    const setCurrentLib = (id) => { currentLibId = id || null }

    async function api(method, path, body) {
      const init = { method, headers: {} }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const q = currentLibId && !path.startsWith('/registry')
        ? (path.includes('?') ? '&' : '?') + 'lib=' + encodeURIComponent(currentLibId)
        : ''
      const res = await fetch(apiBase() + path + q, init)
      const text = await res.text()
      let json
      try {
        json = text ? JSON.parse(text) : {}
      } catch {
        throw new Error('返回不是 JSON：' + text.slice(0, 200))
      }
      if (!json.ok) throw new Error(json.error || '请求失败')
      return json
    }

    /* ───────────────────────────── 样式 ───────────────────────────── */

    // 用主题 token，浅/深自动适配。样式通过 <style> 一次性注入。
    const STYLE_ID = 'kb-memory-style'
    const CSS = `
/* ── 基础骨架 ── */
.kbm-root { display:flex; height:100%; width:100%; position:relative; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:13px; }
.kbm-col { display:flex; flex-direction:column; flex:1; min-width:0; min-height:0; }
.kbm-split { display:flex; flex:1; min-height:0; }
.kbm-side { display:flex; flex-direction:column; background:var(--dsw-alias-bg-layer-1); min-width:0; overflow:hidden; }
.kbm-main { flex:1; display:flex; flex-direction:column; min-width:0; }

/* ── 顶栏：品牌 + 库选择 + 管理（不再显示长绝对路径） ── */
.kbm-libbar { display:flex; align-items:center; gap:10px; padding:9px 14px; border-bottom:1px solid var(--dsw-alias-border-l1); flex:0 0 auto; background:var(--dsw-alias-bg-layer-1); }
.kbm-brand { display:flex; align-items:center; gap:8px; flex:0 0 auto; }
.kbm-brand-mark { width:18px; height:18px; border-radius:5px; background:var(--dsw-alias-brand-primary); color:#fff; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:700; line-height:1; box-shadow:0 1px 3px rgba(0,0,0,.12); }
.kbm-brand-name { font-size:13px; font-weight:600; letter-spacing:.02em; }
.kbm-libbar-divider { width:1px; height:16px; background:var(--dsw-alias-border-l2); flex:0 0 auto; }
.kbm-libbar-spacer { flex:1; min-width:6px; }
.kbm-libbar-label { font-size:11px; color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.kbm-select { height:28px; box-sizing:border-box; padding:0 9px; border:1px solid var(--dsw-alias-border-l2); border-radius:7px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:12px; max-width:240px; }
.kbm-select:hover { border-color:var(--dsw-alias-brand-primary); }

/* ── 侧栏头部：两行，每行只做一件事 ── */
.kbm-side-head { padding:14px 14px 12px; display:flex; flex-direction:column; gap:12px; flex:0 0 auto; border-bottom:1px solid var(--dsw-alias-border-l1); }
.kbm-side-head-row { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.kbm-side-title { display:flex; align-items:baseline; gap:8px; min-width:0; }
.kbm-title { font-size:14px; font-weight:600; }
.kbm-badge { font-size:10px; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l2); border-radius:999px; padding:1px 7px; white-space:nowrap; }
.kbm-side-tools { display:flex; align-items:center; gap:6px; flex-wrap:nowrap; flex:0 0 auto; }

/* ── 按钮：统一高度 / 圆角，主次分层 ── */
.kbm-btn { height:28px; box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center; gap:5px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); border-radius:7px; padding:0 10px; font-size:12px; cursor:pointer; white-space:nowrap; transition:background .15s, border-color .15s, color .15s, transform .1s; }
.kbm-btn:hover { border-color:var(--dsw-alias-brand-primary); }
.kbm-btn:active { transform:translateY(1px); }
.kbm-btn.primary { background:var(--dsw-alias-brand-primary); color:#fff; border-color:var(--dsw-alias-brand-primary); font-weight:500; }
.kbm-btn.primary::before { content:'+'; font-size:15px; line-height:1; font-weight:400; margin-right:1px; }
.kbm-btn.primary:hover { filter:brightness(1.07); }
.kbm-btn.ghost { background:transparent; border-color:transparent; color:var(--dsw-alias-label-secondary); }
.kbm-btn.ghost:hover { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); border-color:transparent; }
.kbm-btn.danger:hover { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }
.kbm-btn:disabled { opacity:.45; cursor:default; transform:none; }

/* ── 搜索：独占整行，放大镜 / 清除 / 命中数都在框内 ── */
.kbm-search-row { display:flex; align-items:center; gap:8px; }
.kbm-search-wrap { position:relative; flex:1; min-width:0; display:flex; align-items:center; }
.kbm-search-ico { position:absolute; left:11px; top:50%; width:11px; height:11px; margin-top:-7px; border:1.5px solid var(--dsw-alias-label-secondary); border-radius:50%; pointer-events:none; opacity:.75; }
.kbm-search-ico::after { content:''; position:absolute; right:-4px; bottom:-3px; width:5px; height:1.5px; background:var(--dsw-alias-label-secondary); transform:rotate(45deg); border-radius:1px; }
.kbm-search { flex:1; min-width:0; width:auto; box-sizing:border-box; height:30px; padding:0 58px 0 30px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:12px; }
.kbm-search::placeholder { color:var(--dsw-alias-label-secondary); opacity:.8; }
.kbm-search:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
.kbm-search-clear { position:absolute; right:9px; top:50%; transform:translateY(-50%); border:0; background:transparent; color:var(--dsw-alias-label-secondary); font-size:14px; line-height:1; cursor:pointer; padding:2px 3px; border-radius:4px; }
.kbm-search-clear:hover { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.kbm-hit-count { position:absolute; right:10px; top:50%; transform:translateY(-50%); font-size:10px; color:var(--dsw-alias-label-secondary); white-space:nowrap; flex:0 0 auto; pointer-events:none; }
.kbm-search-wrap.has-clear .kbm-hit-count { right:32px; }
.kbm-search-wrap.has-clear .kbm-search { padding-right:80px; }

/* ── 目录树 ── */
.kbm-tree { flex:1; overflow:auto; padding:8px 8px 16px; }
.kbm-tree::-webkit-scrollbar { width:8px; }
.kbm-tree::-webkit-scrollbar-thumb { background:var(--dsw-alias-border-l2); border-radius:8px; border:2px solid transparent; background-clip:padding-box; }
.kbm-cat { margin:4px 0; }
.kbm-cat-head { display:flex; align-items:center; gap:7px; padding:6px 8px; border-radius:7px; cursor:pointer; user-select:none; transition:background .12s; }
.kbm-cat-head:hover { background:var(--dsw-alias-bg-layer-2); }
.kbm-caret { width:12px; color:var(--dsw-alias-label-secondary); transition:transform .12s; font-size:10px; }
.kbm-cat-name { font-weight:600; font-size:12px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.kbm-count { color:var(--dsw-alias-label-secondary); font-size:10px; background:var(--dsw-alias-bg-layer-2); border-radius:999px; padding:0 6px; }
.kbm-entries { padding-left:8px; }
.kbm-entry { padding:6px 8px; border-radius:7px; cursor:pointer; border-left:2px solid transparent; transition:background .12s; }
.kbm-entry:hover { background:var(--dsw-alias-bg-layer-2); }
.kbm-entry.active { background:var(--dsw-alias-bg-layer-2); border-left-color:var(--dsw-alias-brand-primary); }
.kbm-entry-title { font-size:12.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.kbm-entry-sum { color:var(--dsw-alias-label-secondary); font-size:11px; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.kbm-entry.compact { padding:5px 8px; }
.kbm-entry-row { display:flex; align-items:center; gap:6px; }
.kbm-entry-row .kbm-entry-title { flex:1; min-width:0; }
.kbm-entry-updated { color:var(--dsw-alias-label-secondary); font-size:10px; white-space:nowrap; font-variant-numeric:tabular-nums; }
.kbm-hl { background:var(--dsw-alias-brand-primary); color:#fff; border-radius:2px; padding:0 1px; }
.kbm-cat.nested { border-left:1px solid var(--dsw-alias-border-l2); margin-left:6px; }

/* ── 底栏：低频视图 / 宽度控件下沉，不占视线区 ── */
.kbm-side-foot { flex:0 0 auto; display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; padding:8px 12px; border-top:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }
.kbm-foot-group { display:flex; align-items:center; gap:5px; }
.kbm-foot-label { font-size:10px; color:var(--dsw-alias-label-secondary); margin-right:2px; }
.kbm-foot-sep { width:1px; height:14px; background:var(--dsw-alias-border-l2); margin:0 3px; }
.kbm-mini { height:24px; box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); border-radius:6px; padding:0 7px; font-size:11px; line-height:1.4; cursor:pointer; white-space:nowrap; transition:background .15s, border-color .15s, color .15s; }
.kbm-mini:hover { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-label-primary); }
.kbm-mini.on { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-base); }
.kbm-mini:disabled { opacity:.45; cursor:default; }
.kbm-mini.icon { width:24px; padding:0; }
.kbm-width-box { display:flex; align-items:center; gap:3px; flex:0 0 auto; }
.kbm-width-val { font-size:11px; color:var(--dsw-alias-label-secondary); min-width:40px; text-align:center; font-variant-numeric:tabular-nums; user-select:none; }

/* ── 主区 ── */
.kbm-main-head { display:flex; align-items:center; gap:8px; padding:10px 18px; min-height:48px; box-sizing:border-box; border-bottom:1px solid var(--dsw-alias-border-l1); }
.kbm-path { font-size:12px; color:var(--dsw-alias-label-secondary); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,Menlo,Consolas,monospace; }
.kbm-body { flex:1; overflow:auto; padding:24px 28px; }
.kbm-empty { color:var(--dsw-alias-label-secondary); text-align:center; margin-top:80px; font-size:12px; line-height:1.8; }
.kbm-preview { max-width:820px; line-height:1.75; word-break:break-word; }
.kbm-preview h1 { font-size:22px; border-bottom:1px solid var(--dsw-alias-border-l1); padding-bottom:10px; margin:0 0 18px; }
.kbm-preview h2 { font-size:18px; margin:26px 0 12px; } .kbm-preview h3 { font-size:15px; margin:20px 0 10px; }
.kbm-preview pre { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:12px 14px; overflow:auto; }
.kbm-preview code { background:var(--dsw-alias-bg-layer-1); padding:1px 5px; border-radius:4px; font-size:12px; }
.kbm-preview pre code { background:none; padding:0; }
.kbm-preview table { border-collapse:collapse; } .kbm-preview td,.kbm-preview th { border:1px solid var(--dsw-alias-border-l2); padding:5px 10px; }
.kbm-preview blockquote { border-left:3px solid var(--dsw-alias-brand-primary); margin:12px 0; padding:4px 14px; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-1); border-radius:0 6px 6px 0; }
.kbm-preview a { color:var(--dsw-alias-brand-primary); }
.kbm-editor { width:100%; height:100%; box-sizing:border-box; resize:none; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:13px; line-height:1.6; padding:14px 16px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); }
.kbm-editor:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }

/* ── 弹层 ── */
.kbm-toast { position:absolute; bottom:18px; right:22px; background:var(--dsw-alias-bg-overlay); border:1px solid var(--dsw-alias-border-l2); border-radius:8px; padding:8px 14px; font-size:12px; box-shadow:0 4px 16px rgba(0,0,0,.18); }
.kbm-toast.err { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }
.kbm-mask { position:fixed; inset:0; background:rgba(0,0,0,.35); display:flex; align-items:center; justify-content:center; z-index:50; }
.kbm-dialog { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:12px; padding:20px; width:360px; box-shadow:0 8px 30px rgba(0,0,0,.3); }
.kbm-dialog h3 { margin:0 0 14px; font-size:14px; }
.kbm-field { margin-bottom:10px; }
.kbm-field label { display:block; font-size:12px; color:var(--dsw-alias-label-secondary); margin-bottom:4px; }
.kbm-input { width:100%; box-sizing:border-box; height:30px; padding:0 9px; border:1px solid var(--dsw-alias-border-l2); border-radius:7px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:13px; }
.kbm-input:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
.kbm-dialog-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:16px; }
.kbm-dialog.wide { width:680px; max-height:84vh; display:flex; flex-direction:column; }
.kbm-reg-path { font-size:11px; color:var(--dsw-alias-label-secondary); margin-bottom:10px; word-break:break-all; }
.kbm-manage-list { flex:1; overflow:auto; min-height:0; }
.kbm-libcard { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:10px; margin-bottom:10px; }
.kbm-libcard-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
.kbm-libcard-title { font-weight:600; font-size:13px; }
.kbm-grid { display:grid; grid-template-columns:1fr 1fr 2fr; gap:8px; }
.kbm-textarea { width:100%; box-sizing:border-box; min-height:58px; padding:6px 8px; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:12px; font-family:ui-monospace,Menlo,Consolas,monospace; line-height:1.5; }
.kbm-manage-note { font-size:11px; color:var(--dsw-alias-label-secondary); margin-top:8px; line-height:1.55; }

/* ── 2026-11-18：侧栏宽度可见握柄（原 5px 透明条 + 误导性 border-right 已移除） ── */
.kbm-resizer { flex:0 0 12px; cursor:col-resize; background:var(--dsw-alias-bg-layer-1); position:relative; z-index:3; touch-action:none; border-left:1px solid var(--dsw-alias-border-l1); border-right:1px solid var(--dsw-alias-border-l1); outline:none; }
.kbm-resizer::after { content:''; position:absolute; left:50%; top:50%; width:3px; height:3px; border-radius:50%; transform:translate(-50%,-50%); background:var(--dsw-alias-label-secondary); box-shadow:0 -7px 0 var(--dsw-alias-label-secondary), 0 7px 0 var(--dsw-alias-label-secondary); }
.kbm-resizer:hover, .kbm-resizer.dragging, .kbm-resizer:focus-visible { background:var(--dsw-alias-brand-primary); }
.kbm-resizer:hover::after, .kbm-resizer.dragging::after, .kbm-resizer:focus-visible::after { background:#fff; box-shadow:0 -7px 0 #fff, 0 7px 0 #fff; }
.kbm-resizer:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:-2px; }
.kbm-root.resizing { user-select:none; cursor:col-resize; }
.kbm-root.resizing * { user-select:none !important; }
.kbm-reopen { margin-right:8px; }
`

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }

    /* ─────────────────────── 极简 Markdown 渲染 ─────────────────────── */
    // 不引第三方：转义后按行处理标题/列表/代码块/表格/引用/段落，够看懂即可。
    function renderMarkdown(src) {
      const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const inline = (s) =>
        esc(s)
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/\*([^*]+)\*/g, '<em>$1</em>')
          .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      const lines = String(src || '').split(/\r?\n/)
      const out = []
      let i = 0
      // 跳过 frontmatter
      if (lines[0] === '---') {
        for (i = 1; i < lines.length; i++) if (lines[i] === '---') { i++; break }
      }
      let inCode = false
      let codeBuf = []
      let listType = null
      let tableBuf = []
      const flushTable = () => {
        if (!tableBuf.length) return
        const rows = tableBuf.filter((r) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(r))
        const cells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => inline(c.trim()))
        let html = '<table>'
        rows.forEach((r, idx) => {
          const tag = idx === 0 ? 'th' : 'td'
          html += '<tr>' + cells(r).map((c) => `<${tag}>${c}</${tag}>`).join('') + '</tr>'
        })
        html += '</table>'
        out.push(html)
        tableBuf = []
      }
      const flushList = () => {
        if (listType) { out.push(`</${listType}>`); listType = null }
      }
      for (; i < lines.length; i++) {
        const line = lines[i]
        if (/^```/.test(line)) {
          flushList(); flushTable()
          if (inCode) { out.push('<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>'); codeBuf = []; inCode = false }
          else inCode = true
          continue
        }
        if (inCode) { codeBuf.push(line); continue }
        if (/^\s*\|.*\|\s*$/.test(line)) { flushList(); tableBuf.push(line); continue }
        else if (tableBuf.length) flushTable()
        const mh = line.match(/^(#{1,6})\s+(.*)$/)
        if (mh) { flushList(); out.push(`<h${mh[1].length}>${inline(mh[2])}</h${mh[1].length}>`); continue }
        if (/^\s*>\s?/.test(line)) { flushList(); out.push('<blockquote>' + inline(line.replace(/^\s*>\s?/, '')) + '</blockquote>'); continue }
        if (/^\s*[-*+]\s+/.test(line)) { if (listType !== 'ul') { flushList(); out.push('<ul>'); listType = 'ul' } out.push('<li>' + inline(line.replace(/^\s*[-*+]\s+/, '')) + '</li>'); continue }
        if (/^\s*\d+\.\s+/.test(line)) { if (listType !== 'ol') { flushList(); out.push('<ol>'); listType = 'ol' } out.push('<li>' + inline(line.replace(/^\s*\d+\.\s+/, '')) + '</li>'); continue }
        if (!line.trim()) { flushList(); continue }
        flushList(); out.push('<p>' + inline(line) + '</p>')
      }
      flushList(); flushTable()
      if (inCode && codeBuf.length) out.push('<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>')
      return out.join('\n')
    }

    /* ─────────────────────────── 侧栏图标 ─────────────────────────── */

    function KbIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 19.5v-15Z', stroke: 'currentColor', strokeWidth: '1.7' }),
        h('path', { d: 'M9 8h6M9 12h6M9 16h4', stroke: 'currentColor', strokeWidth: '1.7', strokeLinecap: 'round' })
      )
    }

    /* ─────────────────── UI 偏好持久化（2026-11-18 P0） ─────────────────── */
    // 全局偏好（宽度 / 紧凑 / 收起）与按库偏好（展开状态 / 上次选中）分开存：
    // localStorage 按 origin 隔离，而 Web GUI 端口在 app 重启时会变，所以这里只能
    // 保证「刷新页面不丢」；跨重启持久化需宿主侧 /ui-state，留到 P1。
    function readPref(k, fallback) {
      try {
        const raw = window.localStorage.getItem('kb-memory:pref:' + k)
        return raw === null ? fallback : JSON.parse(raw)
      } catch { return fallback }
    }
    function writePref(k, v) {
      try { window.localStorage.setItem('kb-memory:pref:' + k, JSON.stringify(v)) } catch { /* 隐私模式等：静默降级 */ }
    }
    function readLibPref(libId, k, fallback) {
      try {
        const raw = window.localStorage.getItem('kb-memory:lib:' + (libId || '_') + ':' + k)
        return raw === null ? fallback : JSON.parse(raw)
      } catch { return fallback }
    }
    function writeLibPref(libId, k, v) {
      try { window.localStorage.setItem('kb-memory:lib:' + (libId || '_') + ':' + k, JSON.stringify(v)) } catch { /* ignore */ }
    }

    // 搜索命中判定：标题 / 条目名 / 摘要 / 分类路径 / tags
    function matchEntry(e, catName, q) {
      const parts = [e.title, e.name, e.summary, catName]
      if (Array.isArray(e.tags)) parts.push(e.tags.join(' '))
      return parts.some((x) => String(x || '').toLowerCase().includes(q))
    }
    // 命中片段高亮：返回 React 子节点数组（文本 + <mark>），不拼 HTML 字符串
    function highlightText(text, q) {
      const s = String(text || '')
      if (!q) return s
      const lower = s.toLowerCase()
      const out = []
      let i = 0
      while (i < s.length) {
        const j = lower.indexOf(q, i)
        if (j < 0) { out.push(s.slice(i)); break }
        if (j > i) out.push(s.slice(i, j))
        out.push(h('mark', { className: 'kbm-hl', key: 'hl' + j }, s.slice(j, j + q.length)))
        i = j + q.length
      }
      return out
    }

    /* ─────────────────────────── 主面板 ─────────────────────────── */

    function KbPanel() {
      const [tree, setTree] = React.useState(null)
      const [expanded, setExpanded] = React.useState({})
      const [sel, setSel] = React.useState(null) // {category, name}
      const [content, setContent] = React.useState('')
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [toast, setToast] = React.useState(null) // {msg, err}
      const [dialog, setDialog] = React.useState(null) // {kind:'entry'|'category', ...}
      // 多知识库：注册表 / 当前库 / 管理弹窗草稿
      const [libs, setLibs] = React.useState(null)
      const [libId, setLibId] = React.useState('')
      const [regPath, setRegPath] = React.useState('')
      const [manage, setManage] = React.useState(false)
      const [mDraft, setMDraft] = React.useState(null)
      const [savingReg, setSavingReg] = React.useState(false)
      // 2026-11-18 P0：侧栏宽度 / 紧凑模式 / 收起 / 搜索 / 拖拽状态
      const [sideW, setSideW] = React.useState(() => {
        const v = Number(readPref('sideW', 320))
        return Number.isFinite(v) && v >= 220 && v <= 480 ? v : 320
      })
      const [compact, setCompact] = React.useState(() => readPref('compact', true) !== false)
      const [sideCollapsed, setSideCollapsed] = React.useState(() => readPref('sideCollapsed', false) === true)
      const [query, setQuery] = React.useState('')
      const [dragging, setDragging] = React.useState(false)
      const dragRef = React.useRef(null)
      const restoredRef = React.useRef(false)
      // 防止「libId 先更新、expanded 还没从 localStorage 恢复」时把空对象写回去覆盖偏好
      const expandedReadyRef = React.useRef(false)

      const say = (msg, err) => {
        setToast({ msg, err })
        window.clearTimeout(say._t)
        say._t = window.setTimeout(() => setToast(null), 2600)
      }

      const loadTree = React.useCallback(async (lid) => {
        const id = lid || libId
        if (!id) { setTree(null); return }
        setCurrentLib(id)
        expandedReadyRef.current = false
        try {
          const data = await api('GET', '/tree')
          setTree(data)
          // 2026-11-18 P0：不再默认全展开。首次只展开顶层分类（depth=0），
          // 子分类默认折叠；已有持久化的展开状态优先恢复，新增分类按默认规则补齐。
          const saved = readLibPref(id, 'expanded', null)
          const next = (saved && typeof saved === 'object' && !Array.isArray(saved)) ? { ...saved } : {}
          for (const c of (data.categories || [])) {
            if (next[c.name] === undefined) next[c.name] = (c.depth || 0) === 0
          }
          setExpanded(next)
          expandedReadyRef.current = true
        } catch (e) {
          say('加载失败：' + e.message, true)
        }
      }, [libId])

      // 读注册表 → 选定当前库 → 加载树
      const loadRegistry = async (preferId) => {
        try {
          const reg = await api('GET', '/registry')
          const list = reg.libraries || []
          const want = preferId || libId
          const keep = list.some((l) => l.id === want) ? want : (list[0]?.id || '')
          setLibs(list)
          setRegPath(reg.registryPath || '')
          setLibId(keep)
          setCurrentLib(keep)
          setSel(null); setContent(''); setEditing(false)
          await loadTree(keep)
        } catch (e) {
          say('加载知识库列表失败：' + e.message, true)
        }
      }

      const switchLib = (id) => {
        if (!id || id === libId) return
        setLibId(id)
        setCurrentLib(id)
        setSel(null); setContent(''); setEditing(false); setTree(null)
        setQuery('')
        restoredRef.current = false
        expandedReadyRef.current = false
        loadTree(id)
      }

      const openManage = () => {
        setMDraft((libs || []).map((l) => ({
          id: l.id,
          name: l.name,
          root: l.root,
          projects: (l.projects || []).join('\n'),
        })))
        setManage(true)
      }

      const saveLibConfig = async () => {
        setSavingReg(true)
        try {
          const cleaned = (mDraft || []).map((l) => ({
            id: String(l.id || '').trim(),
            name: String(l.name || '').trim(),
            root: String(l.root || '').trim(),
            projects: String(l.projects || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
          }))
          await api('PUT', '/registry', { version: 1, libraries: cleaned })
          setManage(false)
          await loadRegistry()
          say('知识库配置已保存')
        } catch (e) {
          say('保存失败：' + e.message, true)
        } finally {
          setSavingReg(false)
        }
      }

      React.useEffect(() => { ensureStyle(); loadRegistry() }, [])

      /* 2026-11-18 P0：全部展开/折叠、拖拽调宽、偏好持久化、恢复上次选中 */
      const setAllExpanded = (open) => {
        const next = {}
        for (const c of ((tree && tree.categories) || [])) next[c.name] = open
        setExpanded(next)
      }

      // 宽度统一钳制：220–480px，且不超过面板宽的 45%（窄窗口时主区仍有空间）。
      const clampSideW = (w, panelW) => {
        const maxByPanel = Math.max(220, Math.floor((panelW || 1200) * 0.45))
        return Math.max(220, Math.min(480, maxByPanel, Math.round(w)))
      }
      const currentPanelW = () => {
        try {
          const root = (typeof document !== 'undefined' && document.querySelector) ? document.querySelector('.kbm-root') : null
          return (root && root.clientWidth) || window.innerWidth || 1200
        } catch (_) { return window.innerWidth || 1200 }
      }
      // 不依赖拖拽的显式调宽入口：点 −/+ 每次 20px；工具栏实时显示 px，给即时反馈。
      const nudgeSideW = (delta) => setSideW(clampSideW(sideW + delta, currentPanelW()))
      const onResizeKeyDown = (ev) => {
        const step = ev.shiftKey ? 50 : 20
        let w = null
        if (ev.key === 'ArrowLeft') w = sideW - step
        else if (ev.key === 'ArrowRight') w = sideW + step
        else if (ev.key === 'Home') w = 220
        else if (ev.key === 'End') w = 480
        if (w === null) return
        ev.preventDefault()
        setSideW(clampSideW(w, currentPanelW()))
      }

      // 2026-11-18 修复：原来只挂 window 的 pointermove，且 5px 透明拖拽条命中区太窄。
      // 现在 pointer + mouse 双通道、window + document 双目标、pointer capture 兜底，
      // 并保留 setPointerCapture 以便指针移出元素/窗口时仍能收到 move。
      const onResizeStart = (ev) => {
        if (ev.button !== undefined && ev.button !== 0) return
        ev.preventDefault()
        if (ev.stopPropagation) ev.stopPropagation()
        const el = ev.currentTarget
        const startX = typeof ev.clientX === 'number'
          ? ev.clientX
          : ((ev.touches && ev.touches[0] && ev.touches[0].clientX) || 0)
        dragRef.current = { startX, startW: sideW, panelW: currentPanelW() }
        setDragging(true)
        try {
          if (el && el.setPointerCapture && ev.pointerId != null) el.setPointerCapture(ev.pointerId)
        } catch (_) { /* 不支持 pointer capture 的环境忽略 */ }

        const move = (e) => {
          const d = dragRef.current
          if (!d) return
          const x = typeof e.clientX === 'number'
            ? e.clientX
            : ((e.touches && e.touches[0] && e.touches[0].clientX) || d.startX)
          setSideW(clampSideW(d.startW + (x - d.startX), d.panelW))
        }
        // 同时监听 window 与 document（某些环境事件只冒泡到 document）；
        // document 能力缺失时自动降级，避免整个拖拽逻辑抛错不可用。
        const targets = [window]
        try {
          if (typeof document !== 'undefined' && document.addEventListener && document.removeEventListener) targets.push(document)
        } catch (_) { /* 降级为只听 window */ }
        const up = () => {
          dragRef.current = null
          setDragging(false)
          for (const t of targets) {
            t.removeEventListener('pointermove', move)
            t.removeEventListener('mousemove', move)
            t.removeEventListener('pointerup', up)
            t.removeEventListener('mouseup', up)
            t.removeEventListener('pointercancel', up)
          }
          window.removeEventListener('blur', up)
          try {
            if (el && el.releasePointerCapture && ev.pointerId != null) el.releasePointerCapture(ev.pointerId)
          } catch (_) { /* 同上 */ }
        }
        for (const t of targets) {
          t.addEventListener('pointermove', move)
          t.addEventListener('mousemove', move)
          t.addEventListener('pointerup', up)
          t.addEventListener('mouseup', up)
          t.addEventListener('pointercancel', up)
        }
        window.addEventListener('blur', up)
      }

      React.useEffect(() => { writePref('sideW', sideW) }, [sideW])
      React.useEffect(() => { writePref('compact', compact) }, [compact])
      React.useEffect(() => { writePref('sideCollapsed', sideCollapsed) }, [sideCollapsed])
      React.useEffect(() => {
        if (libId && expandedReadyRef.current) writeLibPref(libId, 'expanded', expanded)
      }, [expanded, libId])

      // 恢复上次打开的条目（按库分别记；每次切库后只恢复一次）
      React.useEffect(() => {
        if (restoredRef.current || !tree || !libId) return
        const saved = readLibPref(libId, 'lastSel', null)
        restoredRef.current = true
        if (!saved || !saved.category || !saved.name) return
        const exists = (tree.categories || []).some(
          (c) => c.name === saved.category && (c.entries || []).some((e) => e.name === saved.name)
        )
        if (!exists) return
        setSel({ category: saved.category, name: saved.name })
        setEditing(false)
        api('GET', '/entry?category=' + encodeURIComponent(saved.category) + '&name=' + encodeURIComponent(saved.name))
          .then((data) => setContent(data.text || ''))
          .catch((e) => { setContent(''); say('读取失败：' + e.message, true) })
      }, [tree, libId])

      const openEntry = async (category, name) => {
        setSel({ category, name })
        setEditing(false)
        if (libId) writeLibPref(libId, 'lastSel', { category, name })
        try {
          const data = await api('GET', '/entry?category=' + encodeURIComponent(category) + '&name=' + encodeURIComponent(name))
          setContent(data.text || '')
        } catch (e) {
          setContent('')
          say('读取失败：' + e.message, true)
        }
      }

      const saveEntry = async () => {
        if (!sel) return
        setBusy(true)
        try {
          await api('PUT', '/entry', { category: sel.category, name: sel.name, text: draft })
          setContent(draft)
          setEditing(false)
          await loadTree()
          say('已保存')
        } catch (e) {
          say('保存失败：' + e.message, true)
        } finally {
          setBusy(false)
        }
      }

      const removeEntry = async () => {
        if (!sel) return
        if (!window.confirm(`删除条目 ${sel.category}/${sel.name}.md？此操作不可撤销。`)) return
        setBusy(true)
        try {
          await api('DELETE', '/entry?category=' + encodeURIComponent(sel.category) + '&name=' + encodeURIComponent(sel.name))
          setSel(null); setContent(''); setEditing(false)
          if (libId) writeLibPref(libId, 'lastSel', null)
          await loadTree()
          say('已删除')
        } catch (e) {
          say('删除失败：' + e.message, true)
        } finally {
          setBusy(false)
        }
      }

      const reindex = async () => {
        try { await api('POST', '/reindex'); await loadTree(); say('索引已重建') }
        catch (e) { say('重建失败：' + e.message, true) }
      }

      /* 弹窗：新建条目 / 编辑分类说明 */
      const submitDialog = async () => {
        const d = dialog
        setBusy(true)
        try {
          if (d.kind === 'entry') {
            const tpl = `---\ntitle: "${d.title || d.name}"\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n\n# ${d.title || d.name}\n\n`
            await api('PUT', '/entry', { category: d.category, name: d.name, text: tpl })
            await loadTree()
            setDialog(null)
            await openEntry(d.category, d.name)
            setEditing(true); setDraft(tpl)
            say('已创建，进入编辑')
          } else {
            await api('PUT', '/category', { category: d.category, title: d.title, description: d.description })
            await loadTree()
            setDialog(null)
            say('分类说明已保存')
          }
        } catch (e) {
          say('操作失败：' + e.message, true)
        } finally {
          setBusy(false)
        }
      }

      /* ── 渲染 ── */

      // 2026-11-18 P0：搜索过滤 + 命中项祖先自动展开
      const filtered = React.useMemo(() => {
        const q = String(query || '').trim().toLowerCase()
        const cats = ((tree && tree.categories) || []).map((c) => ({
          ...c,
          entries: (c.entries || []).filter((e) => !q || matchEntry(e, c.name, q)),
        }))
        let eff = expanded
        if (q) {
          const auto = {}
          for (const c of cats) {
            if (!c.entries.length) continue
            const parts = String(c.name).split('/')
            for (let i = 1; i <= parts.length; i++) auto[parts.slice(0, i).join('/')] = true
          }
          eff = { ...expanded, ...auto }
        }
        return { cats, eff, q, hitCount: cats.reduce((n, c) => n + c.entries.length, 0) }
      }, [tree, expanded, query])

      const renderSide = () => {
        if (!libId) return h('div', { className: 'kbm-tree' }, h('div', { className: 'kbm-empty' }, '还没有知识库。点上方「管理」新建一个，并绑定项目绝对路径。'))
        if (!tree) return h('div', { className: 'kbm-tree' }, h('div', { className: 'kbm-empty' }, '加载中…'))
        const cats = filtered.cats
        const q = filtered.q
        // 有关键词时：只保留「自身有命中」或「子孙有命中」的分类，避免一堆（空）噪声
        const hasDescHits = (name) => cats.some((c) => c.entries.length && (c.name === name || c.name.startsWith(name + '/')))
        // 分类是「先序 DFS 的扁平列表 + full path / depth」：子分类只有祖先全展开时才显示。
        const visible = cats.filter((c) => {
          const parts = String(c.name).split('/')
          for (let i = 1; i < parts.length; i++) {
            if (!filtered.eff[parts.slice(0, i).join('/')]) return false
          }
          return !q || c.entries.length > 0 || hasDescHits(c.name)
        })
        return h('div', { className: 'kbm-tree' },
          visible.length === 0 || (q && filtered.hitCount === 0)
            ? h('div', { className: 'kbm-empty' }, q ? '没有匹配的条目，换个关键词试试。' : '知识库还是空的。点右上「新建条目」开始。')
            : visible.map((c) => {
                const open = filtered.eff[c.name]
                const depth = Math.min(c.depth || 0, 3)
                const indent = { paddingLeft: 8 + depth * 12 }
                return h('div', { className: 'kbm-cat' + (depth ? ' nested' : ''), key: c.name },
                  h('div', {
                    className: 'kbm-cat-head',
                    style: indent,
                    onClick: () => setExpanded((p) => ({ ...p, [c.name]: !p[c.name] })),
                  },
                    h('span', { className: 'kbm-caret' }, open ? '▾' : '▸'),
                    h('span', { className: 'kbm-cat-name' }, c.meta.title || c.name),
                    h('span', { className: 'kbm-count' }, `${c.entries.length}`)
                  ),
                  open ? h('div', { className: 'kbm-entries' },
                    c.entries.length === 0 && !q
                      ? h('div', { className: 'kbm-entry-sum', style: { padding: '4px 8px' } }, '（空）')
                      : c.entries.map((e) =>
                          h('div', {
                            key: e.name,
                            className: 'kbm-entry' + (sel && sel.category === c.name && sel.name === e.name ? ' active' : '') + (compact ? ' compact' : ''),
                            style: { paddingLeft: 8 + depth * 12 },
                            onClick: () => openEntry(c.name, e.name),
                            title: (e.title || e.name) + (e.summary ? '\n\n' + e.summary : ''),
                          },
                            compact
                              ? h('div', { className: 'kbm-entry-row' },
                                  h('div', { className: 'kbm-entry-title' }, highlightText(e.title || e.name, q)),
                                  e.updated ? h('span', { className: 'kbm-entry-updated' }, String(e.updated).slice(5)) : null
                                )
                              : h('div', { className: 'kbm-entry-title' }, highlightText(e.title || e.name, q)),
                            compact ? null : (e.summary ? h('div', { className: 'kbm-entry-sum' }, e.summary) : null)
                          )
                        )
                  ) : null
                )
              })
        )
      }

      const reopenSide = () => sideCollapsed
        ? h('button', { className: 'kbm-mini kbm-reopen', title: '展开目录', onClick: () => setSideCollapsed(false) }, '»')
        : null

      const renderMain = () => {
        if (!sel) {
          return h('div', { className: 'kbm-main' },
            h('div', { className: 'kbm-main-head' },
              reopenSide(),
              h('div', { className: 'kbm-path' }, tree ? `${tree.root}` : ''),
              h('button', { className: 'kbm-btn', onClick: reindex }, '重建索引')
            ),
            h('div', { className: 'kbm-body' },
              h('div', { className: 'kbm-empty' }, '选择左侧条目查看；或点「新建条目」添加知识。')
            )
          )
        }
        return h('div', { className: 'kbm-main' },
          h('div', { className: 'kbm-main-head' },
            reopenSide(),
            h('div', { className: 'kbm-path' }, `${sel.category} / ${sel.name}.md`),
            editing
              ? [
                  h('button', { key: 'c', className: 'kbm-btn', onClick: () => { setEditing(false); setDraft(content) }, disabled: busy }, '取消'),
                  h('button', { key: 's', className: 'kbm-btn primary', onClick: saveEntry, disabled: busy }, busy ? '保存中…' : '保存'),
                ]
              : [
                  h('button', { key: 'e', className: 'kbm-btn', onClick: () => { setDraft(content); setEditing(true) } }, '编辑'),
                  h('button', { key: 'd', className: 'kbm-btn danger', onClick: removeEntry, disabled: busy }, '删除'),
                  h('button', { key: 'r', className: 'kbm-btn', onClick: reindex }, '重建索引'),
                ]
          ),
          h('div', { className: 'kbm-body', style: editing ? { padding: 12 } : null },
            editing
              ? h('textarea', { className: 'kbm-editor', value: draft, onChange: (ev) => setDraft(ev.target.value), spellCheck: false })
              : h('div', { className: 'kbm-preview', dangerouslySetInnerHTML: { __html: renderMarkdown(content) } })
          )
        )
      }

      const renderDialog = () => {
        if (!dialog) return null
        const d = dialog
        const set = (k) => (ev) => setDialog({ ...d, [k]: ev.target.value })
        return h('div', { className: 'kbm-mask', onClick: (ev) => { if (ev.target === ev.currentTarget) setDialog(null) } },
          h('div', { className: 'kbm-dialog' },
            h('h3', null, d.kind === 'entry' ? '新建条目' : '编辑分类说明'),
            d.kind === 'entry'
              ? [
                  h('div', { key: 'c', className: 'kbm-field' }, h('label', null, '分类路径（可用 / 分多级）'), h('input', { className: 'kbm-input', value: d.category, onChange: set('category'), placeholder: '如 数仓 或 数仓/单用户CBU' })),
                  h('div', { key: 'n', className: 'kbm-field' }, h('label', null, '条目名（不含 .md，可用空格）'), h('input', { className: 'kbm-input', value: d.name, onChange: set('name'), placeholder: '如 订单事实表' })),
                  h('div', { key: 't', className: 'kbm-field' }, h('label', null, '标题（可选）'), h('input', { className: 'kbm-input', value: d.title || '', onChange: set('title'), placeholder: '默认同条目名' })),
                ]
              : [
                  h('div', { key: 'c', className: 'kbm-field' }, h('label', null, '分类路径（可用 / 分多级）'), h('input', { className: 'kbm-input', value: d.category, onChange: set('category'), placeholder: '如 数仓 或 数仓/单用户CBU' })),
                  h('div', { key: 't', className: 'kbm-field' }, h('label', null, '显示标题'), h('input', { className: 'kbm-input', value: d.title || '', onChange: set('title') })),
                  h('div', { key: 'd', className: 'kbm-field' }, h('label', null, '分类说明（一句话）'), h('input', { className: 'kbm-input', value: d.description || '', onChange: set('description') })),
                ],
            h('div', { className: 'kbm-dialog-actions' },
              h('button', { className: 'kbm-btn', onClick: () => setDialog(null) }, '取消'),
              h('button', { className: 'kbm-btn primary', onClick: submitDialog, disabled: busy || !d.category || (d.kind === 'entry' && !d.name) }, busy ? '处理中…' : '确定')
            )
          )
        )
      }

      const setMD = (i, k) => (ev) => {
        const next = (mDraft || []).map((l, idx) => idx === i ? { ...l, [k]: ev.target.value } : l)
        setMDraft(next)
      }

      const renderManage = () => {
        if (!manage) return null
        const rows = (mDraft || []).map((l, i) =>
          h('div', { className: 'kbm-libcard', key: i },
            h('div', { className: 'kbm-libcard-head' },
              h('span', { className: 'kbm-libcard-title' }, l.name || l.id || '（新库）'),
              h('button', { className: 'kbm-btn danger', onClick: () => setMDraft((mDraft || []).filter((_, j) => j !== i)) }, '删除')
            ),
            h('div', { className: 'kbm-grid' },
              h('div', { className: 'kbm-field', key: 'i' }, h('label', null, '库 id（字母/数字/_/-）'), h('input', { className: 'kbm-input', value: l.id, onChange: setMD(i, 'id'), placeholder: 'shucang' })),
              h('div', { className: 'kbm-field', key: 'n' }, h('label', null, '名称'), h('input', { className: 'kbm-input', value: l.name, onChange: setMD(i, 'name'), placeholder: '数仓' })),
              h('div', { className: 'kbm-field', key: 'r' }, h('label', null, '根目录（绝对路径）'), h('input', { className: 'kbm-input', value: l.root, onChange: setMD(i, 'root'), placeholder: '/Users/.../knowledge-base' }))
            ),
            h('div', { className: 'kbm-field' },
              h('label', null, '绑定项目（工作区绝对路径，一行一个；一个项目只能绑一个库）'),
              h('textarea', { className: 'kbm-textarea', value: l.projects, onChange: setMD(i, 'projects'), spellCheck: false, placeholder: '/path/to/your/workspace' })
            )
          )
        )
        return h('div', { className: 'kbm-mask', onClick: (ev) => { if (ev.target === ev.currentTarget) setManage(false) } },
          h('div', { className: 'kbm-dialog wide' },
            h('h3', null, '知识库管理 · 按项目绑定（一对一）'),
            h('div', { className: 'kbm-reg-path' }, '注册表：' + (regPath || '（未知）')),
            h('div', { className: 'kbm-manage-list' },
              rows.length ? rows : h('div', { className: 'kbm-empty' }, '还没有知识库，点左下「新增知识库」。')
            ),
            h('div', { className: 'kbm-manage-note' },
              '插件在 desktop profile 全局加载；agent 每轮按自己工作区（Current working directory）选库。工作区命中绑定才启用该库，未命中的会话保持静默（不调用 kb_*、不提及知识库）。一对一：同一个项目路径不能同时绑两个库，保存时会校验。新建库会自动创建目录并生成 INDEX.md。'
            ),
            h('div', { className: 'kbm-dialog-actions' },
              h('button', { className: 'kbm-btn', onClick: () => setMDraft([...(mDraft || []), { id: '', name: '', root: '', projects: '' }]) }, '新增知识库'),
              h('button', { className: 'kbm-btn', onClick: () => setManage(false) }, '取消'),
              h('button', { className: 'kbm-btn primary', onClick: saveLibConfig, disabled: savingReg }, savingReg ? '保存中…' : '保存')
            )
          )
        )
      }

      // 2026-11-18 视觉整理：计数徽标（来自 /tree 的扁平分类列表）
      const allCats = (tree && tree.categories) || []
      const totalCats = allCats.length
      const totalEntries = allCats.reduce((n, c) => n + (c.entries || []).length, 0)

      return h('div', { className: 'kbm-root' + (dragging ? ' resizing' : '') },
        h('div', { className: 'kbm-col' },
          h('div', { className: 'kbm-libbar' },
            h('div', { className: 'kbm-brand' },
              h('span', { className: 'kbm-brand-mark' }, 'K'),
              h('span', { className: 'kbm-brand-name' }, '知识库')
            ),
            h('span', { className: 'kbm-libbar-divider' }),
            h('select', { className: 'kbm-select', value: libId, onChange: (ev) => switchLib(ev.target.value), disabled: !libs || !libs.length, title: tree ? tree.root : '知识库根目录' },
              (libs || []).map((l) => h('option', { key: l.id, value: l.id }, (l.name || l.id) + '（' + l.id + '）'))
            ),
            h('div', { className: 'kbm-libbar-spacer' }),
            h('button', { className: 'kbm-btn ghost', onClick: openManage, title: '管理知识库（注册表 / 项目绑定）' }, '管理')
          ),
          h('div', { className: 'kbm-split' },
            h('div', {
              className: 'kbm-side',
              style: { width: sideCollapsed ? 0 : sideW, flex: '0 0 ' + (sideCollapsed ? 0 : sideW) + 'px' },
            },
              h('div', { className: 'kbm-side-head' },
                h('div', { className: 'kbm-side-head-row' },
                  h('div', { className: 'kbm-side-title' },
                    h('span', { className: 'kbm-title' }, '目录'),
                    h('span', { className: 'kbm-badge' }, totalCats + ' 类 · ' + totalEntries + ' 条')
                  ),
                  h('div', { className: 'kbm-side-tools' },
                    h('button', { className: 'kbm-btn primary', onClick: () => setDialog({ kind: 'entry', category: sel ? sel.category : '', name: '', title: '' }), disabled: !libId }, '新建条目'),
                    h('button', { className: 'kbm-btn ghost', title: '编辑或新建分类说明', onClick: () => setDialog({ kind: 'category', category: sel ? sel.category : '', title: '', description: '' }), disabled: !libId }, '分类'),
                    h('button', { className: 'kbm-mini icon', title: '收起目录（右区顶部「»」可展开）', onClick: () => setSideCollapsed(true) }, '«')
                  )
                ),
                h('div', { className: 'kbm-search-row' },
                  h('div', { className: 'kbm-search-wrap' + (query ? ' has-clear' : '') },
                    h('span', { className: 'kbm-search-ico' }),
                    h('input', {
                      className: 'kbm-search',
                      value: query,
                      placeholder: '搜索标题 / 摘要 / 标签 / 分类…',
                      onChange: (ev) => setQuery(ev.target.value),
                      onKeyDown: (ev) => { if (ev.key === 'Escape') setQuery('') },
                      disabled: !libId,
                    }),
                    query ? h('button', { className: 'kbm-search-clear', title: '清空搜索', onClick: () => setQuery('') }, '×') : null,
                    filtered.q ? h('span', { className: 'kbm-hit-count' }, `${filtered.hitCount} 条匹配`) : null
                  )
                )
              ),
              renderSide(),
              h('div', { className: 'kbm-side-foot' },
                h('div', { className: 'kbm-foot-group' },
                  h('span', { className: 'kbm-foot-label' }, '视图'),
                  h('button', { className: 'kbm-mini', title: '全部展开', onClick: () => setAllExpanded(true), disabled: !tree }, '展开'),
                  h('button', { className: 'kbm-mini', title: '全部折叠（只留分类头）', onClick: () => setAllExpanded(false), disabled: !tree }, '折叠'),
                  h('button', { className: 'kbm-mini' + (compact ? ' on' : ''), title: '紧凑模式：只显示单行标题（悬停看完整摘要）', onClick: () => setCompact(!compact) }, compact ? '紧凑' : '摘要')
                ),
                h('div', { className: 'kbm-foot-group' },
                  h('span', { className: 'kbm-foot-label' }, '宽度'),
                  h('div', { className: 'kbm-width-box', title: '目录栏宽度：点 −/+ 每次 20px；也可拖动右侧竖条，或聚焦竖条按 ←/→' },
                    h('button', { className: 'kbm-mini', title: '缩窄 20px', onClick: () => nudgeSideW(-20) }, '−'),
                    h('span', { className: 'kbm-width-val', title: '双击复位 320px', onDoubleClick: () => setSideW(320) }, sideW + 'px'),
                    h('button', { className: 'kbm-mini', title: '加宽 20px', onClick: () => nudgeSideW(20) }, '+')
                  )
                )
              )
            ),
            sideCollapsed ? null : h('div', {
              className: 'kbm-resizer' + (dragging ? ' dragging' : ''),
              title: '拖动调整宽度 · 双击复位 320px · 聚焦后 ←/→ 每次 20px（Shift 50px）',
              role: 'separator',
              'aria-orientation': 'vertical',
              'aria-label': '目录栏宽度，当前 ' + sideW + 'px',
              tabIndex: 0,
              onPointerDown: onResizeStart,
              onKeyDown: onResizeKeyDown,
              onDoubleClick: () => setSideW(320),
            }),
            renderMain()
          )
        ),
        toast ? h('div', { className: 'kbm-toast' + (toast.err ? ' err' : '') }, toast.msg) : null,
        renderDialog(),
        renderManage()
      )
    }

    /* ─────────────────────────── 插件入口 ─────────────────────────── */

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: 'kb-memory', order: 31, label: () => '知识库' },
          KbIcon
        )
      )
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: 'kb-memory' }, KbPanel)
      )
    }

    return { inject, apply }
  },
})
