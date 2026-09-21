/**
 * dsh-session-vault — browser half.
 *
 * Hand-authored in the client module format DSH's `client-modules` service
 * expects: a plain script that registers one lazy CommonJS factory with
 * `window.__ModuleLoader__.load({ id, factory })`. The `id` must be the exact
 * package name, because the loader matches a served bundle against the entry
 * it was fetched for.
 *
 * No bundler is involved. React arrives through the factory's `require`, which
 * resolves against the module graph the shell has already built; everything
 * else here is plain JavaScript. That keeps `lib/client.js` reviewable and
 * means publishing needs no build step.
 *
 * The UI is one `settings.section` page: pick sessions, export them to a
 * `.dshsession` archive, and import one back.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-archiver',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');

    var h = React.createElement;
    var API_BASE = '/api/dsh-session-vault';

    /* ------------------------------------------------------------------ i18n */

    // Self-contained two-language support. Reading the navigator's language
    // avoids depending on the locale service and its dictionary registration
    // lifecycle for what is, at most, a handful of strings.
    var PREFERS_CHINESE = (function detectChinese() {
      try {
        var languages = navigator.languages && navigator.languages.length > 0
          ? navigator.languages
          : [navigator.language || ''];
        for (var index = 0; index < languages.length; index += 1) {
          if (String(languages[index]).toLowerCase().indexOf('zh') === 0) return true;
        }
      } catch (error) {
        return false;
      }
      return false;
    })();

    /** Pick the Chinese or English string. */
    function t(chinese, english) {
      return PREFERS_CHINESE ? chinese : english;
    }

    /* ------------------------------------------------------------------- api */

    /**
     * Call one host endpoint and unwrap its `{ ok, ... }` envelope.
     * @param path - path below the shared route prefix.
     * @param init - optional fetch init.
     * @returns the response body.
     */
    async function api(path, init) {
      var response = await fetch(API_BASE + path, init);
      // Read as text first so a non-JSON body can be *reported* rather than
      // discarded. A body that is not our JSON envelope almost always means the
      // route never registered and the /api RPC fence answered instead — it
      // replies with a bare-text 401/403 — so the status and the body are the
      // only things that make that diagnosable.
      var text = await response.text();
      var payload;
      try {
        payload = text.length === 0 ? undefined : JSON.parse(text);
      } catch (error) {
        payload = undefined;
      }
      if (payload === null || typeof payload !== 'object') {
        throw new Error(
          'HTTP ' + response.status + (response.statusText ? ' ' + response.statusText : '')
          + ' — ' + (text.slice(0, 160) || t('（空响应）', '(empty body)')),
        );
      }
      if (payload.ok !== true) {
        throw new Error(payload.error || 'HTTP ' + response.status);
      }
      return payload;
    }

    /** POST a JSON body. */
    function postJson(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body === undefined ? {} : body),
      });
    }

    /** Trigger a browser download of one staged archive. */
    function downloadArchive(name) {
      var anchor = document.createElement('a');
      anchor.href = API_BASE + '/download?file=' + encodeURIComponent(name);
      anchor.download = name;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }

    /* -------------------------------------------------------------- formatting */

    /** Human-readable byte size. */
    function formatBytes(value) {
      if (typeof value !== 'number' || !isFinite(value)) return '—';
      if (value < 1024) return value + ' B';
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
      if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB';
      return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    /** Local date-time for a millisecond timestamp or ISO string. */
    function formatWhen(value) {
      if (value === null || value === undefined) return '—';
      var date = typeof value === 'number' ? new Date(value) : new Date(String(value));
      if (isNaN(date.getTime())) return '—';
      return date.toLocaleString();
    }

    /** Shorten a session id for display without losing its distinguishing tail. */
    function shortId(id) {
      var text = String(id);
      if (text.length <= 30) return text;
      return text.slice(0, 14) + '…' + text.slice(-10);
    }

    /**
     * Display text for a session's title, when it has none.
     *
     * "Untitled" alone was the whole story before, and it is the wrong story for
     * most rows it covered: a session whose log holds nothing but its header has
     * no first prompt to derive a title from, and calling that "untitled" makes
     * the entry look broken when it is simply empty. The two cases are worth
     * telling apart, because only one of them is worth opening.
     *
     * @param session - a session descriptor from the host.
     * @returns the stored title, or an explanatory placeholder.
     */
    function titleText(session) {
      if (session.title) return session.title;
      // A session can hold events and still have no conversation: creating one
      // records its permission preset, sandbox mode, approval policy and
      // end-seed marker, which is several events and zero messages. There is no
      // first prompt to derive a title from, and saying so beats "untitled" —
      // which reads as a missing value rather than an empty session. The host
      // establishes this by reading the log, so `null`/absent must fall through
      // to the neutral wording rather than claim the session is unused.
      if (session.conversation === false) {
        return t('（尚未使用 · 无对话）', '(unused · no conversation)');
      }
      return t('（无标题）', '(untitled)');
    }

    /**
     * Whether the host considers a session to have no workspace.
     *
     * `mounted` is the host's single answer, computed from both the registry's
     * validated view and the durable workspace account. An older host that
     * predates the field still gets the registry-only reading, so the panel
     * degrades rather than showing nothing.
     *
     * @param session - a session descriptor.
     * @returns `true` when no workspace accounts for the session.
     */
    function unmountedOf(session) {
      if (typeof session.mounted === 'boolean') return !session.mounted;
      return session.workspace === null || session.workspace === undefined;
    }

    /* ----------------------------------------------------------------- styles */

    var CSS = [
      // Every theme reference goes through one locally-named property with a
      // literal fallback. Two reasons. First, a `var()` with no fallback is
      // invalid at computed-value time when the token is missing, so the
      // declaration silently drops to its initial value — which is how a
      // "primary" button ended up as white text on the browser's default light
      // button face. Second, `--dsw-alias-brand-primary` is *white* in the dark
      // theme, so a hard-coded `color:#fff` was invisible there; the paired
      // foreground token is the only correct partner for a brand-filled surface.
      '.dsv-root{',
      '--dsv-fg:var(--dsw-alias-label-primary,#e9e9ec);',
      '--dsv-fg-dim:var(--dsw-alias-label-secondary,#9b9ba3);',
      '--dsv-surface:var(--dsw-alias-bg-layer-1,#1b1b1e);',
      '--dsv-surface-2:var(--dsw-alias-bg-layer-2,#232327);',
      '--dsv-line:var(--dsw-alias-border-l1,#2f2f34);',
      '--dsv-line-2:var(--dsw-alias-border-l2,#3b3b41);',
      '--dsv-accent:var(--dsw-alias-brand-primary,#6b8afd);',
      '--dsv-accent-fill:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4d6bfe));',
      '--dsv-accent-fg:var(--dsw-alias-label-primary-foreground,#fff);',
      '--dsv-error:var(--dsw-alias-state-error-primary,#f2555a);',
      '--dsv-ok:var(--dsw-alias-state-success-primary,#3ecf8e);',
      '--dsv-warn:var(--dsw-alias-state-warn-primary,#f5a524);',
      'display:flex;flex-direction:column;gap:16px;padding:4px 0 32px;color:var(--dsv-fg);font-size:13px;line-height:1.5}',
      '.dsv-title{margin:0;font-size:16px;font-weight:600}',
      '.dsv-sub{margin:4px 0 0;color:var(--dsv-fg-dim);font-size:12px}',
      '.dsv-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsv-line)}',
      '.dsv-tab{appearance:none;border:0;background:transparent;color:var(--dsv-fg-dim);font:inherit;padding:7px 12px;border-radius:6px 6px 0 0;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}',
      '.dsv-tab:hover{background:var(--dsv-surface-2);color:var(--dsv-fg)}',
      '.dsv-tab[data-active="true"]{color:var(--dsv-fg);border-bottom-color:var(--dsv-accent);font-weight:600}',
      '.dsv-banner{border-radius:6px;padding:8px 12px;border:1px solid transparent;white-space:pre-wrap;word-break:break-word}',
      '.dsv-banner[data-kind="error"]{border-color:var(--dsv-error);color:var(--dsv-error)}',
      '.dsv-banner[data-kind="ok"]{border-color:var(--dsv-ok);color:var(--dsv-ok)}',
      '.dsv-banner[data-kind="warn"]{border-color:var(--dsv-warn);color:var(--dsv-warn)}',
      '.dsv-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.dsv-bar .dsv-grow{flex:1 1 200px;min-width:160px}',
      '.dsv-input,.dsv-select{background:var(--dsv-surface);border:1px solid var(--dsv-line);border-radius:6px;color:inherit;font:inherit;padding:6px 9px;min-width:0;width:100%;box-sizing:border-box}',
      '.dsv-input:focus,.dsv-select:focus{outline:none;border-color:var(--dsv-accent)}',
      '.dsv-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}',
      '.dsv-btn{appearance:none;font:inherit;border-radius:6px;padding:6px 12px;cursor:pointer;border:1px solid var(--dsv-line-2);background:var(--dsv-surface);color:var(--dsv-fg);white-space:nowrap}',
      '.dsv-btn:hover:not(:disabled){border-color:var(--dsv-accent)}',
      '.dsv-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.dsv-btn[data-variant="primary"]{background:var(--dsv-accent-fill);border-color:var(--dsv-accent-fill);color:var(--dsv-accent-fg);font-weight:600}',
      '.dsv-btn[data-variant="danger"]{color:var(--dsv-error);border-color:var(--dsv-line)}',
      '.dsv-btn[data-size="sm"]{padding:3px 9px;font-size:12px}',
      '.dsv-list{display:flex;flex-direction:column;border:1px solid var(--dsv-line);border-radius:8px;overflow:hidden;max-height:46vh;overflow-y:auto}',
      '.dsv-row{display:flex;gap:10px;align-items:flex-start;padding:9px 12px;border-bottom:1px solid var(--dsv-line);cursor:pointer}',
      '.dsv-row:last-child{border-bottom:0}',
      '.dsv-row:hover{background:var(--dsv-surface-2)}',
      '.dsv-row[data-picked="true"]{background:var(--dsv-surface-2)}',
      '.dsv-row input[type=checkbox]{margin-top:2px;flex:none;accent-color:var(--dsv-accent-fill)}',
      '.dsv-row-body{flex:1;min-width:0}',
      '.dsv-row-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsv-row-meta{color:var(--dsv-fg-dim);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsv-empty{padding:22px 12px;text-align:center;color:var(--dsv-fg-dim)}',
      '.dsv-card{border:1px solid var(--dsv-line);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:10px;background:var(--dsv-surface)}',
      '.dsv-field{display:flex;flex-direction:column;gap:4px}',
      '.dsv-field > label{font-size:12px;color:var(--dsv-fg-dim);font-weight:600}',
      '.dsv-hint{font-size:11.5px;color:var(--dsv-fg-dim)}',
      '.dsv-radio{display:flex;gap:6px;align-items:center;font-size:12.5px}',
      '.dsv-drop{border:1.5px dashed var(--dsv-line-2);border-radius:8px;padding:22px;text-align:center;color:var(--dsv-fg-dim);cursor:pointer}',
      '.dsv-drop:hover{border-color:var(--dsv-accent);color:var(--dsv-fg)}',
      '.dsv-table{width:100%;border-collapse:collapse;font-size:12.5px}',
      '.dsv-table th,.dsv-table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--dsv-line);vertical-align:top}',
      '.dsv-table th{color:var(--dsv-fg-dim);font-weight:600;font-size:11.5px}',
      '.dsv-tag{display:inline-block;border:1px solid var(--dsv-line-2);border-radius:10px;padding:0 7px;font-size:11px;color:var(--dsv-fg-dim);margin-left:6px}',
      '.dsv-tag[data-kind="warn"]{border-color:var(--dsv-warn);color:var(--dsv-warn)}',
      '.dsv-scopes{display:flex;flex-wrap:wrap;gap:6px}',
      '.dsv-scope{appearance:none;font:inherit;font-size:12px;padding:3px 10px;border-radius:12px;cursor:pointer;border:1px solid var(--dsv-line-2);background:transparent;color:var(--dsv-fg-dim)}',
      '.dsv-scope:hover{border-color:var(--dsv-accent);color:var(--dsv-fg)}',
      '.dsv-scope[data-active="true"]{background:var(--dsv-surface-2);border-color:var(--dsv-accent);color:var(--dsv-fg);font-weight:600}',
      '.dsv-actions{display:flex;gap:6px;flex-wrap:wrap}',
      '.dsv-spin{color:var(--dsv-fg-dim)}',
    ].join('\n');

    /**
     * Inject the section stylesheet as a plugin-owned effect.
     * @param ctx - the client plugin context.
     */
    function installStyles(ctx) {
      ctx.effect(function install() {
        var tag = document.createElement('style');
        tag.setAttribute('data-dsh-session-vault', '');
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return function remove() {
          tag.remove();
        };
      }, 'dsh-session-vault: styles');
    }

    /* -------------------------------------------------------------- fragments */

    /** A labelled form field. */
    function Field(props) {
      return h('div', { className: 'dsv-field' },
        h('label', null, props.label),
        props.children,
        props.hint ? h('div', { className: 'dsv-hint' }, props.hint) : null);
    }

    /** The transient message banner. */
    function Banner(props) {
      if (!props.message) return null;
      return h('div', { className: 'dsv-banner', 'data-kind': props.kind || 'ok' }, props.message);
    }

    /* ------------------------------------------------------------ export panel */

    /**
     * Session picker plus the export action.
     * @param props - sessions, reload callback, notice setter.
     */
    function ExportPanel(props) {
      var [query, setQuery] = React.useState('');
      var [picked, setPicked] = React.useState({});
      var [busy, setBusy] = React.useState(false);
      var [error, setError] = React.useState(null);
      var [partial, setPartial] = React.useState(null);
      var [scope, setScope] = React.useState('all');

      var sessions = props.sessions;

      // Stored sessions and sidebar sessions are different sets, and the gap is
      // surprising: a session log outlives its workspace (deleting a workspace
      // expressly keeps every session log), and subagent children are stored
      // without ever appearing in the sidebar. Listing `sessionPersistence`
      // therefore shows more than the user can see elsewhere, so the scope is
      // explicit, counted, and selectable — never silently dropped, because an
      // orphaned log is exactly the thing worth rescuing.
      var counts = React.useMemo(function countScopes() {
        var attached = 0;
        var subagents = 0;
        for (var index = 0; index < sessions.length; index += 1) {
          if (!unmountedOf(sessions[index])) attached += 1;
          if (sessions[index].origin === 'subagent') subagents += 1;
        }
        return {
          all: sessions.length,
          attached: attached,
          orphan: sessions.length - attached,
          subagent: subagents,
        };
      }, [sessions]);

      var scoped = React.useMemo(function applyScope() {
        if (scope === 'attached') return sessions.filter(function attachedOnly(s) { return !unmountedOf(s); });
        if (scope === 'orphan') return sessions.filter(function orphanOnly(s) { return unmountedOf(s); });
        if (scope === 'subagent') return sessions.filter(function subagentOnly(s) { return s.origin === 'subagent'; });
        return sessions;
      }, [sessions, scope]);

      var filtered = React.useMemo(function filterSessions() {
        var needle = query.trim().toLowerCase();
        if (needle.length === 0) return scoped;
        return scoped.filter(function matches(session) {
          return [session.id, session.title, session.cwd, session.workspace && session.workspace.title]
            .some(function field(value) {
              return typeof value === 'string' && value.toLowerCase().indexOf(needle) !== -1;
            });
        });
      }, [scoped, query]);

      var pickedIds = Object.keys(picked).filter(function isPicked(id) {
        return picked[id] === true;
      });

      /** Toggle one session. */
      function toggle(id) {
        setPicked(function next(previous) {
          var copy = Object.assign({}, previous);
          if (copy[id] === true) delete copy[id];
          else copy[id] = true;
          return copy;
        });
      }

      /** Run the export, then hand the archive to the browser. */
      async function runExport() {
        setBusy(true);
        setError(null);
        setPartial(null);
        try {
          var selected = pickedIds.length > 0 ? pickedIds : filtered.map(function idOf(session) {
            return session.id;
          });
          if (selected.length === 0) throw new Error(t('没有可导出的会话', 'There are no sessions to export'));
          var result = await postJson('/export', { ids: selected });
          downloadArchive(result.name);
          if (result.failed && result.failed.length > 0) {
            // Partial success. Say exactly which sessions are missing and why —
            // silently downloading a short archive is the worst outcome here.
            setPartial(t(
              '归档已生成并开始下载，但下列 {n} 个会话读取失败，未包含在内：',
              'The archive was created and is downloading, but {n} session(s) could not be read and are not included:',
            ).replace('{n}', String(result.failed.length))
              + '\n' + result.failed.map(function line(entry) {
                return '  · ' + shortId(entry.id) + ' — ' + entry.reason;
              }).join('\n'));
            props.onRefresh();
          } else {
            props.onDone(t('已导出 {sessions} 个会话（{events} 个事件，{size}）。归档：{name}', 'Exported {sessions} session(s), {events} events, {size}. Archive: {name}')
              .replace('{sessions}', String(result.sessionCount))
              .replace('{events}', String(result.eventCount))
              .replace('{size}', formatBytes(result.bytes))
              .replace('{name}', result.name));
          }
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      }

      var scopes = [
        { id: 'all', label: t('全部', 'All'), count: counts.all },
        { id: 'attached', label: t('侧栏可见', 'In sidebar'), count: counts.attached },
        { id: 'orphan', label: t('未挂载工作区', 'No workspace'), count: counts.orphan },
        { id: 'subagent', label: t('子代理', 'Subagent'), count: counts.subagent },
      ];

      return h('div', { className: 'dsv-root' },
        h(Banner, { kind: 'error', message: error }),
        h(Banner, { kind: 'warn', message: partial }),
        h('div', { className: 'dsv-bar' },
          h('div', { className: 'dsv-grow' },
            h('input', {
              className: 'dsv-input',
              type: 'search',
              placeholder: t('搜索标题、路径或会话 ID…', 'Search title, path, or session id…'),
              value: query,
              onChange: function onChange(event) { setQuery(event.target.value); },
            })),
          h('button', {
            className: 'dsv-btn', type: 'button', 'data-size': 'sm',
            onClick: function selectAll() {
              var next = {};
              filtered.forEach(function mark(session) { next[session.id] = true; });
              setPicked(next);
            },
          }, t('全选', 'Select all')),
          h('button', {
            className: 'dsv-btn', type: 'button', 'data-size': 'sm',
            onClick: function clearAll() { setPicked({}); },
          }, t('清空', 'Clear'))),

        h('nav', { className: 'dsv-scopes' },
          scopes.map(function renderScope(entry) {
            return h('button', {
              key: entry.id,
              type: 'button',
              className: 'dsv-scope',
              'data-active': scope === entry.id ? 'true' : 'false',
              onClick: function select() { setScope(entry.id); },
            }, entry.label + ' ' + entry.count);
          })),

        counts.orphan > 0 || counts.subagent > 0
          ? h('div', { className: 'dsv-hint' },
            t('「未挂载工作区」的会话日志还在磁盘上，但不属于任何工作区，所以侧栏看不到它们——删除一个工作区并不会删除它的会话日志。要彻底移除，得删掉会话本身。',
              'Sessions with no workspace still have their log on disk but belong to no workspace, so the sidebar never shows them — deleting a workspace explicitly keeps its session logs. Only deleting the session removes it.'))
          : null,

        h('div', { className: 'dsv-bar' },
          h('span', { className: 'dsv-hint' },
            t('显示 {shown} / 共 {total} 个会话，已选 {picked} 个', 'Showing {shown} of {total} session(s), {picked} selected')
              .replace('{shown}', String(filtered.length))
              .replace('{total}', String(sessions.length))
              .replace('{picked}', String(pickedIds.length))),
          h('div', { className: 'dsv-grow' }),
          h('button', {
            className: 'dsv-btn', type: 'button', 'data-variant': 'primary',
            disabled: busy || filtered.length === 0,
            onClick: runExport,
          }, busy
            ? t('导出中…', 'Exporting…')
            : pickedIds.length > 0
              ? t('导出所选并下载', 'Export selected and download')
              : t('导出当前筛选结果', 'Export what is shown'))),

        h('div', { className: 'dsv-hint' },
          t('未勾选任何会话时导出「当前筛选结果」。归档为 .dshsession 文件，可在任意 DSH 中导入。',
            'With nothing selected, whatever is shown gets exported. An archive is a portable .dshsession file importable by any DSH.')),

        h('div', { className: 'dsv-list' },
          filtered.length === 0
            ? h('div', { className: 'dsv-empty' },
              sessions.length === 0
                ? t('这个部署里还没有已存储的会话。', 'This deployment has no stored sessions yet.')
                : query.trim().length > 0
                  ? t('没有匹配的会话。', 'No sessions match the search.')
                  : t('这个筛选条件下没有会话。', 'No sessions in this scope.'))
            : filtered.map(function renderRow(session) {
              return h('label', {
                className: 'dsv-row',
                key: session.id,
                'data-picked': picked[session.id] === true ? 'true' : 'false',
              },
                h('input', {
                  type: 'checkbox',
                  checked: picked[session.id] === true,
                  onChange: function onChange() { toggle(session.id); },
                }),
                h('div', { className: 'dsv-row-body' },
                  h('div', { className: 'dsv-row-title' },
                    titleText(session),
                    session.archived ? h('span', { className: 'dsv-tag' }, t('已归档', 'archived')) : null,
                    session.isSeeded ? h('span', { className: 'dsv-tag' }, t('分叉', 'forked')) : null,
                    // The two reasons a stored session is absent from the
                    // sidebar, marked on the row so the count difference is
                    // never a mystery.
                    //
                    // `mounted` is the host's own answer and the one the Cleanup
                    // tab filters on; `workspace === null` is only the registry's
                    // view, which hides a session whose header it cannot read.
                    // Preferring `mounted` here is what keeps the two tabs
                    // agreeing on what "unmounted" means.
                    unmountedOf(session)
                      ? h('span', { className: 'dsv-tag', 'data-kind': 'warn' }, t('未挂载工作区', 'no workspace'))
                      : null,
                    session.origin === 'subagent'
                      ? h('span', { className: 'dsv-tag', 'data-kind': 'warn' }, t('子代理', 'subagent'))
                      : null),
                  h('div', { className: 'dsv-row-meta dsv-mono' }, shortId(session.id)),
                  h('div', { className: 'dsv-row-meta' },
                    (session.workspace && session.workspace.title ? session.workspace.title + ' · ' : '')
                    + (session.cwd || t('（无 cwd）', '(no cwd)'))
                    + ' · ' + formatWhen(session.createdAt)
                    + (session.eventCount === null ? '' : ' · ' + session.eventCount + ' ' + t('事件', 'events'))
                    + (session.sizeBytes === null ? '' : ' · ' + formatBytes(session.sizeBytes)))));
            })));
    }

    /* ------------------------------------------------------------ import panel */

    /**
     * Archive picker, options, and the import action.
     * @param props - known archives, current file, notice setter.
     */
    function ImportPanel(props) {
      // The chosen archive is owned by the section, not by this panel.
      //
      // It used to be local state seeded from `initialFile`, which broke the
      // primary flow: uploading calls back to refresh the archive list, and a
      // refresh remounts the panel — so the selection the user had just made
      // was destroyed a tick after it was made and the panel came back empty,
      // looking like the drop did nothing. Keeping it above the panel means the
      // selection survives any remount, whatever causes one.
      var file = props.file;
      var setFile = props.onFileChange;
      var [inspection, setInspection] = React.useState(null);
      var [workspacePath, setWorkspacePath] = React.useState('');
      var [mode, setMode] = React.useState('skip');
      var [createMissing, setCreateMissing] = React.useState(true);
      var [busy, setBusy] = React.useState(false);
      var [error, setError] = React.useState(null);
      var [report, setReport] = React.useState(null);
      var inputRef = React.useRef(null);

      // Inspect whenever the chosen file changes, so the user sees what they
      // are about to import before committing to it.
      React.useEffect(function inspectOnChange() {
        var cancelled = false;
        if (!file) {
          setInspection(null);
          return undefined;
        }
        setError(null);
        postJson('/inspect', { file: file })
          .then(function loaded(result) {
            if (!cancelled) setInspection(result);
          })
          .catch(function failed(failure) {
            if (!cancelled) {
              setInspection(null);
              setError(failure && failure.message ? failure.message : String(failure));
            }
          });
        return function cancel() { cancelled = true; };
      }, [file]);

      /** Upload a chosen file into the plugin staging directory. */
      async function upload(chosen) {
        if (!chosen) return;
        setBusy(true);
        setError(null);
        setReport(null);

        // The staged name only has to be a safe file name in the plugin's own
        // uploads directory. The archive's header is the real validator, so a
        // file that arrives under another name (a re-download that appended
        // "(1)", a `.zip` from a mail client) is normalised rather than
        // rejected — refusing it here would be a silent dead end, which is
        // exactly the failure this whole flow had.
        var staged = String(chosen.name || 'archive').replace(/[\\/:]/g, '_');
        if (!/\.dshsession$/i.test(staged)) staged = staged + '.dshsession';

        try {
          var buffer = await chosen.arrayBuffer();
          await api('/upload?name=' + encodeURIComponent(staged), {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: buffer,
          });
          // Refresh the archive list first, then select: selecting kicks off the
          // inspect that shows the user what they just dropped.
          await props.onUploaded();
          setFile(staged);
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure));
        } finally {
          setBusy(false);
          if (inputRef.current) inputRef.current.value = '';
        }
      }

      /** Run the import (or its dry run). */
      async function run(dryRun) {
        setBusy(true);
        setError(null);
        try {
          if (!file) throw new Error(t('请先选择归档文件', 'Choose an archive first'));
          var result = await postJson('/import', {
            file: file,
            workspacePath: workspacePath.trim().length > 0 ? workspacePath.trim() : undefined,
            mode: mode,
            createMissingDirectory: createMissing,
            dryRun: dryRun,
          });
          setReport(result);
          if (!dryRun) props.onImported();
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      }

      var sessions = inspection ? inspection.sessions : [];

      return h('div', { className: 'dsv-root' },
        h(Banner, { kind: 'error', message: error }),

        h('div', {
          className: 'dsv-drop',
          role: 'button',
          tabIndex: 0,
          onClick: function choose() { if (inputRef.current) inputRef.current.click(); },
          onKeyDown: function key(event) {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              if (inputRef.current) inputRef.current.click();
            }
          },
          onDragOver: function over(event) { event.preventDefault(); },
          onDrop: function drop(event) {
            event.preventDefault();
            if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length > 0) {
              upload(event.dataTransfer.files[0]);
            }
          },
        },
          h('div', null, busy
            ? t('处理中…', 'Working…')
            : t('点击选择，或把 .dshsession 文件拖到这里', 'Click to choose, or drop a .dshsession file here'))),

        // The input sits OUTSIDE the drop target on purpose: a file input's
        // synthetic click bubbles, so nesting it inside the onClick that opens
        // it re-enters the handler.
        //
        // It also carries no `accept` filter. Browsers grey out non-matching
        // files, which makes a renamed archive unselectable — the picker opens,
        // nothing can be chosen, and the user sees exactly the "no reaction"
        // this flow used to produce. The archive header is the real validator
        // and reports a bad file precisely.
        h('input', {
          ref: inputRef,
          type: 'file',
          style: { display: 'none' },
          onChange: function onChange(event) {
            upload(event.target.files && event.target.files[0]);
          },
        }),

        props.archives.length > 0
          ? h(Field, {
            label: t('或选择本机已有的归档', 'Or pick an archive already on this machine'),
          }, h('select', {
            className: 'dsv-select',
            value: file,
            onChange: function onChange(event) { setFile(event.target.value); },
          },
            h('option', { value: '' }, t('— 未选择 —', '— none —')),
            props.archives.map(function option(archive) {
              return h('option', { key: archive.name, value: archive.name },
                archive.name + '  (' + formatBytes(archive.bytes) + ')');
            })))
          : null,

        inspection
          ? h('div', { className: 'dsv-card' },
            h('div', null,
              h('strong', null, file),
              h('div', { className: 'dsv-hint' },
                t('{sessions} 个会话 · {events} 个事件 · 导出于 {when}',
                  '{sessions} session(s) · {events} events · exported {when}')
                  .replace('{sessions}', String(inspection.sessionCount))
                  .replace('{events}', String(inspection.eventCount))
                  .replace('{when}', formatWhen(inspection.header && inspection.header.generatedAt)))),
            h('div', { className: 'dsv-list', style: { maxHeight: '26vh' } },
              sessions.map(function render(entry) {
                return h('div', { className: 'dsv-row', key: entry.id, style: { cursor: 'default' } },
                  h('div', { className: 'dsv-row-body' },
                    h('div', { className: 'dsv-row-title' }, titleText(entry)),
                    h('div', { className: 'dsv-row-meta dsv-mono' }, shortId(entry.id)),
                    h('div', { className: 'dsv-row-meta' },
                      (entry.cwd || t('（无工作区）', '(no workspace)'))
                      + (entry.eventCount === null ? '' : ' · ' + entry.eventCount + ' ' + t('事件', 'events')))));
              })))
          : null,

        h('div', { className: 'dsv-card' },
          h(Field, {
            label: t('导入到工作区目录（可选）', 'Import into workspace directory (optional)'),
            hint: t('留空表示沿用归档里记录的原始路径。填绝对路径可把会话迁移到另一台机器或另一个目录。',
              'Leave blank to keep each session\'s recorded path. An absolute path relocates the sessions.'),
          }, h('input', {
            className: 'dsv-input dsv-mono',
            type: 'text',
            placeholder: t('例如 D:\\\\projects\\\\my-app', 'for example /home/me/projects/my-app'),
            value: workspacePath,
            onChange: function onChange(event) { setWorkspacePath(event.target.value); },
          })),

          h(Field, {
            label: t('会话 ID 已存在时', 'When a session id already exists'),
            hint: t('本插件不会覆盖已有会话：DSH 的存储服务没有删除接口。',
              'This plugin never overwrites a session: DSH\'s persistence service exposes no delete.'),
          }, h('div', { className: 'dsv-actions' },
            h('label', { className: 'dsv-radio' },
              h('input', {
                type: 'radio', name: 'dsv-mode', checked: mode === 'skip',
                onChange: function onChange() { setMode('skip'); },
              }),
              t('跳过（保留本地版本）', 'Skip (keep the local session)')),
            h('label', { className: 'dsv-radio' },
              h('input', {
                type: 'radio', name: 'dsv-mode', checked: mode === 'rename',
                onChange: function onChange() { setMode('rename'); },
              }),
              t('以新 ID 导入（两份都保留）', 'Import under a new id (keep both)')))),

          h('label', { className: 'dsv-radio' },
            h('input', {
              type: 'checkbox', checked: createMissing,
              onChange: function onChange(event) { setCreateMissing(event.target.checked); },
            }),
            t('目标工作区目录不存在时自动创建', 'Create the target workspace directory when missing')),

          h('div', { className: 'dsv-actions' },
            h('button', {
              className: 'dsv-btn', type: 'button', disabled: busy || !file,
              onClick: function preview() { run(true); },
            }, t('预览（不写入）', 'Preview (no writes)')),
            h('button', {
              className: 'dsv-btn', type: 'button', 'data-variant': 'primary',
              disabled: busy || !file,
              onClick: function commit() { run(false); },
            }, busy ? t('处理中…', 'Working…') : t('开始导入', 'Import now')))),

        report ? h(ImportReport, { report: report }) : null);
    }

    /** The structured outcome of one import (or dry run). */
    function ImportReport(props) {
      var report = props.report;
      return h('div', { className: 'dsv-card' },
        h('strong', null, report.dryRun
          ? t('预览结果（未写入任何内容）', 'Preview (nothing was written)')
          : t('导入结果', 'Import result')),
        h('div', { className: 'dsv-hint' },
          t('成功 {ok} · 跳过 {skip} · 失败 {fail}', 'imported {ok} · skipped {skip} · failed {fail}')
            .replace('{ok}', String(report.imported.length))
            .replace('{skip}', String(report.skipped.length))
            .replace('{fail}', String(report.failed.length))),
        report.imported.length > 0
          ? h('table', { className: 'dsv-table' },
            h('thead', null, h('tr', null,
              h('th', null, t('会话', 'Session')),
              h('th', null, t('导入为', 'Imported as')),
              h('th', null, t('工作区', 'Workspace')),
              h('th', null, t('事件', 'Events')))),
            h('tbody', null, report.imported.map(function row(entry) {
              return h('tr', { key: entry.id },
                h('td', null, entry.title || h('span', { className: 'dsv-mono' }, shortId(entry.sourceId))),
                h('td', { className: 'dsv-mono' }, shortId(entry.id),
                  entry.renamed ? h('span', { className: 'dsv-tag' }, t('已改名', 'renamed')) : null),
                h('td', { className: 'dsv-mono' }, entry.cwd || '—'),
                h('td', null, String(entry.eventCount)));
            })))
          : null,
        report.skipped.length > 0
          ? h('div', null,
            h('div', { className: 'dsv-hint' }, t('已跳过', 'Skipped')),
            h('ul', { style: { margin: '4px 0 0', paddingLeft: '18px' } },
              report.skipped.map(function item(entry) {
                return h('li', { key: entry.id, className: 'dsv-mono' }, shortId(entry.id) + ' — ' + entry.reason);
              })))
          : null,
        report.failed.length > 0
          ? h('div', null,
            h('div', { className: 'dsv-hint', style: { color: 'var(--dsv-error)' } },
              t('失败', 'Failed')),
            h('ul', { style: { margin: '4px 0 0', paddingLeft: '18px' } },
              report.failed.map(function item(entry) {
                return h('li', { key: entry.id, className: 'dsv-mono' }, shortId(entry.id) + ' — ' + entry.reason);
              })))
          : null);
    }

    /* ---------------------------------------------------------- archives panel */

    /**
     * Archives already staged in the plugin's export directory.
     * @param props - archives, refresh and navigation callbacks.
     */
    function ArchivesPanel(props) {
      var [busy, setBusy] = React.useState(null);
      var [error, setError] = React.useState(null);

      /** Delete one staged archive after an explicit confirmation. */
      async function remove(name) {
        if (!window.confirm(t('确定删除归档 {name}？', 'Delete archive {name}?').replace('{name}', name))) return;
        setBusy(name);
        setError(null);
        try {
          await postJson('/delete', { file: name, confirm: true });
          props.onChanged(t('已删除 {name}', 'Deleted {name}').replace('{name}', name));
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure));
        } finally {
          setBusy(null);
        }
      }

      if (props.archives.length === 0) {
        return h('div', { className: 'dsv-root' },
          h(Banner, { kind: 'error', message: error }),
          h('div', { className: 'dsv-empty' },
            t('还没有导出过归档。切到「导出」标签页创建一个。',
              'No archives yet. Use the Export tab to create one.')));
      }

      return h('div', { className: 'dsv-root' },
        h(Banner, { kind: 'error', message: error }),
        h('table', { className: 'dsv-table' },
          h('thead', null, h('tr', null,
            h('th', null, t('归档文件', 'Archive')),
            h('th', null, t('大小', 'Size')),
            h('th', null, t('导出时间', 'Created')),
            h('th', null, t('操作', 'Actions')))),
          h('tbody', null, props.archives.map(function row(archive) {
            return h('tr', { key: archive.name },
              h('td', { className: 'dsv-mono' }, archive.name),
              h('td', null, formatBytes(archive.bytes)),
              h('td', null, formatWhen(archive.modifiedAt)),
              h('td', null, h('div', { className: 'dsv-actions' },
                h('button', {
                  className: 'dsv-btn', type: 'button', 'data-size': 'sm',
                  onClick: function download() { downloadArchive(archive.name); },
                }, t('下载', 'Download')),
                h('button', {
                  className: 'dsv-btn', type: 'button', 'data-size': 'sm',
                  onClick: function openImport() { props.onImport(archive.name); },
                }, t('导入', 'Import')),
                h('button', {
                  className: 'dsv-btn', type: 'button', 'data-size': 'sm', 'data-variant': 'danger',
                  disabled: busy === archive.name,
                  onClick: function remove_() { remove(archive.name); },
                }, busy === archive.name ? '…' : t('删除', 'Delete')))));
          }))));
    }

    /* ------------------------------------------------------------- cleanup panel */

    /**
     * Delete the sessions no workspace accounts for.
     *
     * This is the one destructive panel, so it is built to be hard to use by
     * accident: it loads its own candidate list, offers a preview that writes
     * nothing, requires an explicit acknowledgement before the delete button
     * even enables, and then confirms again with the count and the size. The
     * host refuses the same call without `confirm`, so the fences do not depend
     * on this UI being careful.
     *
     * "Unmounted" and "deletable" are deliberately not the same set, and the
     * panel shows both: an unmounted session that has been archived is still
     * unmounted — no workspace claims it, the sidebar never shows it, and it
     * keeps its disk — but deleting it throws away the copy the archive was
     * made to keep. It is therefore hidden behind its own switch, and the empty
     * state names how many are behind it instead of pretending the disk is
     * clean.
     *
     * @param props - `onChanged` refresh callback, fired after a real purge.
     */
    function CleanupPanel(props) {
      var [orphans, setOrphans] = React.useState(null);
      var [reclaimable, setReclaimable] = React.useState(0);
      var [unmountedCount, setUnmountedCount] = React.useState(0);
      var [archivedCount, setArchivedCount] = React.useState(0);
      var [emptyCount, setEmptyCount] = React.useState(0);
      // A set of active buckets rather than one boolean: three kinds of junk now
      // qualify and they are independent, so a single flag would force a choice
      // between them instead of letting a user take all of it.
      var [includeArchived, setIncludeArchived] = React.useState(false);
      var [includeEmpty, setIncludeEmpty] = React.useState(false);
      var [picked, setPicked] = React.useState({});
      var [acknowledged, setAcknowledged] = React.useState(false);
      var [busy, setBusy] = React.useState(false);
      var [error, setError] = React.useState(null);
      var [report, setReport] = React.useState(null);

      /** Load the deletable sessions from the host. */
      var load = React.useCallback(function load() {
        setError(null);
        return api('/orphans?includeArchived=' + (includeArchived ? '1' : '0')
          + '&includeEmpty=' + (includeEmpty ? '1' : '0'))
          .then(function loaded(result) {
            setOrphans(result.sessions);
            setReclaimable(result.reclaimableBytes);
            setUnmountedCount(typeof result.unmountedCount === 'number' ? result.unmountedCount : result.sessions.length);
            setArchivedCount(typeof result.archivedCount === 'number' ? result.archivedCount : 0);
            setEmptyCount(typeof result.emptyCount === 'number' ? result.emptyCount : 0);
          })
          .catch(function failed(failure) {
            setOrphans([]);
            setError(failure && failure.message ? failure.message : String(failure));
          });
      }, [includeArchived, includeEmpty]);

      React.useEffect(function onMount() {
        load();
      }, [load]);

      // Switching scope invalidates the current picks: an id that was visible
      // a moment ago may not be deletable under the new one.
      function changeScope(bucket, next) {
        if (bucket === 'archived') setIncludeArchived(next);
        else setIncludeEmpty(next);
        setPicked({});
        setAcknowledged(false);
      }

      if (orphans === null) return h('div', { className: 'dsv-spin' }, t('加载中…', 'Loading…'));

      var pickedIds = Object.keys(picked).filter(function isPicked(id) { return picked[id] === true; });
      var pickedBytes = orphans
        .filter(function isPicked_(session) { return picked[session.id] === true; })
        .reduce(function total(sum, session) {
          return sum + (typeof session.sizeBytes === 'number' ? session.sizeBytes : 0);
        }, 0);

      /** Toggle one candidate. */
      function toggle(id) {
        setPicked(function next(previous) {
          var copy = Object.assign({}, previous);
          if (copy[id] === true) delete copy[id];
          else copy[id] = true;
          return copy;
        });
      }

      /** Run the purge, in preview or for real. */
      async function run(dryRun) {
        if (dryRun) {
          setBusy(true);
          setError(null);
          try {
            setReport(await postJson('/purge', {
              ids: pickedIds,
              dryRun: true,
              includeArchived: includeArchived,
              includeEmpty: includeEmpty,
            }));
          } catch (failure) {
            setError(failure && failure.message ? failure.message : String(failure));
          } finally {
            setBusy(false);
          }
          return;
        }
        // Second confirmation, outside the checkbox: the button says what it
        // does, and this says how much of it there is.
        var question = t(
          '永久删除 {n} 个会话，释放约 {size}？此操作不可撤销，且不会生成归档。',
          'Permanently delete {n} session(s), freeing about {size}? There is no undo and no archive is made.',
        )
          .replace('{n}', String(pickedIds.length))
          .replace('{size}', formatBytes(pickedBytes));
        if (!window.confirm(question)) return;

        setBusy(true);
        setError(null);
        try {
          var result = await postJson('/purge', {
            ids: pickedIds,
            confirm: true,
            includeArchived: includeArchived,
            includeEmpty: includeEmpty,
          });
          setReport(result);
          setPicked({});
          setAcknowledged(false);
          await load();
          props.onChanged();
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      }

      // A scope selector rather than a lone checkbox, and the option that is
      // normally hidden is always one of the options shown.
      //
      // The bug this replaces was a vocabulary mismatch, not missing data: the
      // Export tab listed N unmounted sessions, this tab listed none, and
      // nothing on screen said why — the archived ones were filtered out behind
      // a checkbox labelled with the reason. Every session the Export tab calls
      // "未挂载工作区" is now visible here, with the archived subset split out
      // under its own chip and its own count.
      //
      // The third chip is a different kind of junk that the workspace question
      // cannot see at all: a session created and abandoned. It *is* mounted, so
      // it belongs to no orphan bucket, and it is exactly what "一键清掉空壳"
      // means. Keeping it a separate chip is also what stops the two tabs from
      // disagreeing again — Export's unmounted total is unaffected by it.
      function scopeChip(id, label, count, active, disabled) {
        return h('button', {
          key: id,
          type: 'button',
          className: 'dsv-scope',
          'data-active': active ? 'true' : 'false',
          disabled: disabled === true,
          onClick: function select() { changeScope(id, !active); },
        }, label + (typeof count === 'number' ? ' ' + count : ''));
      }

      var scopeBar = h('div', { className: 'dsv-bar' },
        h('span', { className: 'dsv-hint' }, t('范围：', 'Scope:')),
        h('nav', { className: 'dsv-scopes' },
          scopeChip('deletable', t('可清理', 'Cleanable'), unmountedCount - archivedCount, !includeArchived, false),
          scopeChip('archived', t('已归档的未挂载', 'Archived, unmounted'), archivedCount, includeArchived, archivedCount === 0),
          scopeChip('empty', t('空壳会话（从未使用）', 'Never used'), emptyCount, includeEmpty, emptyCount === 0)),
        h('div', { className: 'dsv-grow' }),
        archivedCount > 0 && !includeArchived
          ? h('span', { className: 'dsv-hint' },
            t('已归档会话不在默认范围内 —— 归档可能是它们唯一的副本。',
              'Archived sessions are out of the default scope — the archive may be their only copy.'))
          : null);

      if (orphans.length === 0) {
        return h('div', { className: 'dsv-root' },
          h(Banner, { kind: 'error', message: error }),
          h(Banner, { kind: 'ok', message: report && report.deleted.length > 0
            ? t('已清理 {n} 个会话。', 'Cleaned up {n} session(s).').replace('{n}', String(report.deleted.length))
            : null }),
          scopeBar,
          h('div', { className: 'dsv-empty' },
            hiddenHint(archivedCount, includeArchived, emptyCount, includeEmpty)
              || t('没有可清理的会话。所有已存储的会话都归属某个工作区，且都在使用中。',
                'Nothing to clean. Every stored session belongs to a workspace and is in use.')));
      }

      return h('div', { className: 'dsv-root' },
        h(Banner, { kind: 'error', message: error }),

        h('div', { className: 'dsv-banner', 'data-kind': 'warn' },
          t('两类可清理的东西：未挂载会话（没有工作区认领，也就是导出页的「未挂载工作区」）和空壳会话（创建过但从未说过一句话）。删除不可撤销，也不会生成归档 —— 想留就先导出。',
            'Two kinds of junk are cleanable here: unmounted sessions (no workspace accounts for them — the Export tab calls them “No workspace”) and never-used sessions (created, but not one message was ever sent). Deleting is irreversible and makes no archive — export first if you might want them.')),

        h('div', { className: 'dsv-bar' },
          h('span', { className: 'dsv-hint' },
            t('当前范围 {total} 个，合计 {size}；已选 {picked} 个（{size2}）',
              '{total} in this scope, {size} in total; {picked} selected ({size2})')
              .replace('{total}', String(orphans.length))
              .replace('{size}', formatBytes(reclaimable))
              .replace('{picked}', String(pickedIds.length))
              .replace('{size2}', formatBytes(pickedBytes))),
          h('div', { className: 'dsv-grow' }),
          h('button', {
            className: 'dsv-btn', type: 'button', 'data-size': 'sm',
            onClick: function selectAll() {
              var next = {};
              orphans.forEach(function mark(session) { next[session.id] = true; });
              setPicked(next);
            },
          }, t('全选', 'Select all')),
          h('button', {
            className: 'dsv-btn', type: 'button', 'data-size': 'sm',
            onClick: function clearAll() { setPicked({}); },
          }, t('清空', 'Clear'))),

        scopeBar,

        h('div', { className: 'dsv-bar' },
          h('div', { className: 'dsv-grow' }),
          archivedCount > 0
            ? h('span', { className: 'dsv-hint' },
              t('未挂载共 {total} 个，其中 {archived} 个已归档。',
                '{total} unmounted in total, {archived} of them archived.')
                .replace('{total}', String(unmountedCount))
                .replace('{archived}', String(archivedCount)))
            : null),

        h('div', { className: 'dsv-list' },
          orphans.map(function renderRow(session) {
            return h('label', {
              className: 'dsv-row',
              key: session.id,
              'data-picked': picked[session.id] === true ? 'true' : 'false',
            },
              h('input', {
                type: 'checkbox',
                checked: picked[session.id] === true,
                onChange: function onChange() { toggle(session.id); },
              }),
              h('div', { className: 'dsv-row-body' },
                h('div', { className: 'dsv-row-title' },
                  titleText(session),
                  h('span', { className: 'dsv-tag' }, t('未挂载', 'orphaned')),
                  session.archived
                    ? h('span', { className: 'dsv-tag' }, t('已归档', 'archived'))
                    : null),
                h('div', { className: 'dsv-row-meta dsv-mono' }, shortId(session.id)),
                h('div', { className: 'dsv-row-meta' },
                  (session.cwd || t('（无工作区）', '(no workspace)'))
                  + ' · ' + formatWhen(session.createdAt)
                  + (session.eventCount === null ? '' : ' · ' + session.eventCount + ' ' + t('事件', 'events'))
                  + (session.sizeBytes === null ? '' : ' · ' + formatBytes(session.sizeBytes)))));
          })),

        h('label', { className: 'dsv-radio' },
          h('input', {
            type: 'checkbox',
            checked: acknowledged,
            onChange: function onChange(event) { setAcknowledged(event.target.checked); },
          }),
          t('我明白：删除后无法恢复，也不会留下归档。', 'I understand: deletion cannot be undone and leaves no archive.')),

        h('div', { className: 'dsv-actions' },
          h('button', {
            className: 'dsv-btn', type: 'button',
            disabled: busy || pickedIds.length === 0,
            onClick: function preview() { run(true); },
          }, t('预览（不写入）', 'Preview (no writes)')),
          h('button', {
            className: 'dsv-btn', type: 'button', 'data-variant': 'danger',
            disabled: busy || pickedIds.length === 0 || !acknowledged,
            onClick: function commit() { run(false); },
          }, busy
            ? t('处理中…', 'Working…')
            : t('永久删除所选', 'Delete selected permanently'))),

        report ? h(PurgeReport, { report: report }) : null);
    }

    /** The structured outcome of one purge (or its preview). */
    function PurgeReport(props) {
      var report = props.report;
      return h('div', { className: 'dsv-card' },
        h('strong', null, report.dryRun
          ? t('预览结果（未写入任何内容）', 'Preview (nothing was written)')
          : t('清理结果', 'Cleanup result')),
        h('div', { className: 'dsv-hint' },
          t('删除 {done} · 拒绝 {refused} · 失败 {failed} · 释放 {size}',
            'deleted {done} · refused {refused} · failed {failed} · reclaimed {size}')
            .replace('{done}', String(report.deleted.length))
            .replace('{refused}', String(report.refused.length))
            .replace('{failed}', String(report.failed.length))
            .replace('{size}', formatBytes(report.reclaimedBytes))),
        report.deleted.length > 0
          ? h('div', { className: 'dsv-hint dsv-mono' },
            report.deleted.map(function line(entry) {
              return entry.id + (typeof entry.bytes === 'number' ? '  ' + formatBytes(entry.bytes) : '');
            }).join('\n'))
          : null,
        report.refused.length > 0
          ? h('ul', { style: { margin: '4px 0 0', paddingLeft: '18px' } },
            report.refused.map(function item(entry) {
              return h('li', { key: entry.id, className: 'dsv-mono' },
                shortId(entry.id) + ' — ' + reasonText(entry.reason));
            }))
          : null,
        report.failed.length > 0
          ? h('ul', { style: { margin: '4px 0 0', paddingLeft: '18px' } },
            report.failed.map(function item(entry) {
              return h('li', { key: entry.id, className: 'dsv-mono' },
                shortId(entry.id) + ' — ' + entry.reason);
            }))
          : null,
        report.survivors && report.survivors.length > 0
          ? h('div', { className: 'dsv-hint' },
            t('注意：{n} 个已删除的会话仍被当前进程列出，重启 dsh 后会消失。',
              'Note: {n} deleted session(s) are still listed by the running process and will disappear after restarting dsh.')
              .replace('{n}', String(report.survivors.length)))
          : null);
    }

    /**
     * A human sentence for one host-side refusal reason.
     * @param reason - the machine reason code from the host.
     * @returns display text.
     */
    function reasonText(reason) {
      var table = {
        'attached-to-a-workspace': t('归属于某个工作区', 'belongs to a workspace'),
        'archived-session': t('已归档', 'archived'),
        'session-is-live': t('会话正在运行中', 'the session is live'),
        'unknown-session': t('未知会话', 'unknown session'),
        'unresolvable-artifact-path': t('无法定位归档目录', 'artifact path could not be resolved'),
        'artifact-path-escapes-the-sessions-root': t('路径越界，已拒绝', 'path escapes the sessions root'),
      };
      return table[reason] || reason;
    }

    /**
     * Explain a scope that is empty while buckets are sitting outside it.
     *
     * Both hidden buckets are named, not just the archived one: whichever the
     * user came looking for, "nothing here" on its own would read as "nothing
     * exists", which is the confusion this whole panel was rebuilt to remove.
     *
     * @param archivedCount - unmounted sessions that are archived.
     * @param includeArchived - whether that bucket is currently in scope.
     * @param emptyCount - mounted sessions that were never used.
     * @param includeEmpty - whether that bucket is currently in scope.
     * @returns the sentence, or `undefined` when nothing is being hidden.
     */
    function hiddenHint(archivedCount, includeArchived, emptyCount, includeEmpty) {
      var hidden = [];
      if (archivedCount > 0 && !includeArchived) {
        hidden.push(t('{n} 个已归档的未挂载会话', '{n} archived, unmounted').replace('{n}', String(archivedCount)));
      }
      if (emptyCount > 0 && !includeEmpty) {
        hidden.push(t('{n} 个空壳会话（从未使用）', '{n} never-used').replace('{n}', String(emptyCount)));
      }
      if (hidden.length === 0) return undefined;
      return t(
        '当前范围内没有可清理的会话，但另有 {list} 不在范围内 —— 点上面的范围按钮即可列出并删除。',
        'Nothing to clean in this scope, but {list} are outside it — use the scope buttons above to list and delete them.',
      ).replace('{list}', hidden.join(t('、', ' and ')));
    }

    /* -------------------------------------------------------------- the section */

    /**
     * The settings page: loads host state and routes between the three panels.
     * @param props - settings.section owner props.
     */
    function SessionVaultSection(props) {
      var [tab, setTab] = React.useState('export');
      var [sessions, setSessions] = React.useState([]);
      var [archives, setArchives] = React.useState([]);
      var [status, setStatus] = React.useState(null);
      // `ready` means "the first load finished" — deliberately NOT "a fetch is
      // in flight". The panels are gated on it, so using a per-fetch flag here
      // would unmount whichever panel was open on every refresh, discarding the
      // user's in-progress work: the archive they just dropped in, the preview
      // they just ran, the partial-export warning they just got. A refresh is
      // background maintenance and must leave the open panel alone.
      var [ready, setReady] = React.useState(false);
      var [error, setError] = React.useState(null);
      var [notice, setNotice] = React.useState(null);
      // Owned here so it outlives the panel that renders it.
      var [importFile, setImportFile] = React.useState('');

      /** Reload everything the panels render, without disturbing them. */
      var reload = React.useCallback(function reload() {
        setError(null);
        return Promise.all([api('/status'), api('/sessions'), api('/archives')])
          .then(function loaded(results) {
            setStatus(results[0]);
            setSessions(results[1].sessions);
            setArchives(results[2].archives);
            setReady(true);
          })
          .catch(function failed(failure) {
            setError(failure && failure.message ? failure.message : String(failure));
            setReady(true);
          });
      }, []);

      React.useEffect(function onMount() {
        reload();
      }, [reload]);

      /** Show a success notice and refresh derived state. */
      function done(message) {
        setNotice(message);
        setError(null);
        reload();
      }

      var tabs = [
        { id: 'export', label: t('导出', 'Export') },
        { id: 'import', label: t('导入', 'Import') },
        { id: 'archives', label: t('归档', 'Archives') },
        { id: 'cleanup', label: t('清理', 'Cleanup') },
      ];

      // A deployment without session persistence cannot do any of this; say so
      // once, in place of a panel full of failing controls.
      var missingServices = status !== null
        && status.services
        && status.services.sessionPersistence !== true;

      return h('div', { className: 'dsv-root' },
        h('header', null,
          h('h2', { className: 'dsv-title' }, t('会话保管库', 'Session Vault')),
          h('p', { className: 'dsv-sub' },
            t('浏览全部会话，把选中的导出成可移植归档，或从归档导入回本机。',
              'Browse every session, export the ones you pick as portable archives, or import an archive back.'))),

        h(Banner, { kind: 'error', message: error }),
        h(Banner, { kind: 'ok', message: notice }),

        missingServices
          ? h(Banner, {
            kind: 'warn',
            message: t('当前 profile 没有组合 sessionPersistence 服务，无法导出或导入会话。',
              'This profile does not compose the sessionPersistence service, so sessions cannot be exported or imported.'),
          })
          : null,

        h('nav', { className: 'dsv-tabs' },
          tabs.map(function renderTab(entry) {
            return h('button', {
              key: entry.id,
              type: 'button',
              className: 'dsv-tab',
              'data-active': tab === entry.id ? 'true' : 'false',
              onClick: function select() { setTab(entry.id); setNotice(null); },
            }, entry.label);
          })),

        ready ? null : h('div', { className: 'dsv-spin' }, t('加载中…', 'Loading…')),

        ready && tab === 'export'
          ? h(ExportPanel, {
            sessions: sessions,
            onDone: done,
            // A partial export refreshes the archive list but must not clear the
            // panel's own warning, so it reloads without touching the notice.
            onRefresh: function refresh() { reload(); },
          })
          : null,
        ready && tab === 'import'
          ? h(ImportPanel, {
            archives: archives,
            file: importFile,
            onFileChange: setImportFile,
            onUploaded: function uploaded() { return reload(); },
            onImported: function imported() { done(t('导入完成。', 'Import finished.')); },
          })
          : null,
        ready && tab === 'archives'
          ? h(ArchivesPanel, {
            archives: archives,
            onChanged: done,
            onImport: function openImport(name) {
              setImportFile(name);
              setNotice(null);
              setTab('import');
            },
          })
          : null,
        ready && tab === 'cleanup'
          ? h(CleanupPanel, {
            onChanged: function changed() { return reload(); },
          })
          : null,

        status
          ? h('div', { className: 'dsv-hint dsv-mono' },
            'v' + status.version + ' · ' + status.exportDir)
          : null);
    }

    /* ------------------------------------------------------------------ plugin */

    const inject = ['slots'];

    /**
     * Register the settings page.
     * @param ctx - the client root context.
     */
    function apply(ctx) {
      installStyles(ctx);
      ctx.slots.inject('settings.section', function register() {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'session-vault',
          // After the shipped sections (general 0 … agent-presets 20) and
          // beside the other management plugins (config-manager 60).
          order: 62,
          label: function label() { return t('会话保管库', 'Session Vault'); },
        }, SessionVaultSection);
      });
    }

    exports.apply = apply;
    exports.inject = inject;

    return module.exports;
  },
});
