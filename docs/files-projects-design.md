# Files & Projects in MaiaVM Desktop — RE-based Design

Status: research + design (implementation follows in phases)
Sources: Grok Bot asar (`/tmp/grokbot-asar`, `docs/grok-asar-extract/`) +
hermes-agent desktop source (`~/.hermes/hermes-agent/apps/desktop/src/`).

---

## 1. What Grok Bot does (reverse-engineered)

### Data model (from protobuf `agent.v1` / `aiserver.v1`)
- Every conversation carries **workspace state**:
  - `workspace_root_path` (string)
  - `branch_name` / `base_branch_name` / `base_branch_commit_id`
  - `open_editors` (list), `file_diff_histories` (list)
  - `git_patch`, `remote_url`, `commit_id`, `unsaved_files`
- **File reads** are chunked + hash-addressed: `SimpleFileChunk{relative_workspace_path, range, chunk_hash}` — the UI can cache/verify chunks.
- **Read requests** carry the full context grok wants back:
  `relative_workspace_path`, `start_line_one_indexed`, `end_line_one_indexed_inclusive`,
  `outline` (symbol list), `total_lines`, `matching_cursor_rules`, `read_full_file`.

### UI (from renderer bundle)
1. **File cards inline in the transcript** — when the agent reads/writes a file,
   the message stream shows a `fileCardWrap` entry (sibling of `linkCardWrap` /
   `widgetWrap`). This is the primary "files in chat" surface.
2. **`sand-file-viewer`** — a dedicated file display component with states:
   - `state` view: `{icon (32px), title (sm), detail (xs, tertiary), action}` —
     used for loading / error / empty
   - code view + diff view (highlighted, with git diff)
3. **File-type icons** — seti/cursor icon theme resolved by extension:
   `$nt({filenameOrExt, preferred})` → `{variant: seti|cursor, iconName, color}`.
   Known mappings include `.plan.md → list-todo/yellow`, plus the full
   `file-type-*` icon set (docker, babel, bun, clojure, …) and `logo-vscode`.
4. **Unified search/command panel** (`xos`) — one palette with tabs:
   All / Messages / Agents / Groups / **Files** / Links / Routines / Actions.
   File entries render as `{kind:"file", file:…}` rows with icon + path.
5. **Tool-call chips show file activity with status word + label + icon**:
   - `BoxRead` → "Reading file" + book-open
   - `BoxWrite` → "Drafting the file" + pencil / "On your computer" + laptop
   - `BoxShell` → "Running commands" + terminal
   - `CopyToBox`/`CopyFromBox` → "Organizing files" + laptop
   - `CloudAgent` → "Coding" + cursor-logo
6. **Drag-drop**: chat composer accepts dropped `Files` (copy drop-effect) and
   attaches them as user attachments (`user-attachment` kind, image or file).
7. **Citations**: inline `cite` with `data-citation-start/end` + file/terminal
   type — clicking a file citation opens that file/line.

---

## 2. What hermes-agent already offers (its own desktop app)

Hermes ships a full desktop app with the EXACT surfaces we need — this is the
"what hermes can display" reference. Files are git-driven.

### Projects (sidebar)
- `hermes project` CLI: create/list/show/add-folder/remove-folder/rename/
  set-primary/use/archive/restore/bind-board. Projects = named multi-folder
  workspaces, per-profile.
- Desktop sidebar (`chat/sidebar/projects/`): project tree with
  `SidebarProjectTree { id, label, path, repos, groups, sessions, lastActive,
  sessionCount, isAuto, isNoProject }`; overview rows (active project first,
  auto-discovered repos below, "Home" fixture on top); per-repo lanes via
  `git worktree list` (`useRepoWorktreeMap`); session previews under each
  project (3 recent); persisted open/collapse per node.

### File tree (right sidebar `files/`)
- `react-arborist` virtualized `Tree`, 22px rows, indent 10px.
- Lazy-loaded children with loading + error child nodes
  ("Loading…" / "Unable to read (…)").
- **Gitignore-aware**: `ignore` package rules per git root; `ALWAYS_EXCLUDED`
  paths; dirs sorted first then name-locale.
- Row actions: inline rename, context menu, drag-and-drop (own dnd-manager),
  `onActivateFile`/`onActivateFolder`/`onPreviewFile`, reveal-in-tree,
  collapse-nonce.
- **Git status badges**: `RepoChangeKind = 'added' | 'conflicted' | 'modified'`
  (untracked → added, conflicted → conflicted, else modified).

### File preview / editor (right rail `preview-file.tsx`)
- Shiki highlight (`github-dark-default` / `github-light-default`), language
  from filename.
- **CodeMirror 6 spot-edit** for small edits (not an IDE), with dirty flag,
  stale-on-disk detection (re-read before save), write-back.
- `FileDiffPanel` for diffs; virtualized fixed-row window (200-line chunks,
  400-line overscan); 512KB text cap; image/video/audio preview via data-URL.

### Terminal (right sidebar `terminal/`)
- Agent terminal stream, persistent terminals, revive-buffer, clipboard,
  links, fonts, active-resize, instance rail.

### Filesystem access — the key architecture for Hetzner
`lib/desktop-fs.ts` has **two modes**:
- **Local**: Electron IPC — `hermes:fs:readDir` (dirs-first sort, dirent
  stat fallback), `hermes:readFileText`, `hermes:fs:writeText`, data-URL read.
- **Remote**: HTTP against a `HermesConnection` (`mode: 'remote'`,
  `remoteKind: 'ssh' | …`, profile-scoped) — `POST /api/fs/list`,
  `/api/fs/read-text`, `/api/fs/write-text`, `/api/fs/read-data-url` with the
  same path hardening (parent-must-exist, size caps).
- Plus: `desktopGitRoot`, `desktopDefaultCwd` (returns branch + cwd),
  `desktopFileDiff(repoRoot, filePath)`, `revealDesktopPath`,
  `renameDesktopPath`, `trashDesktopPath`.
- Cwd is per-conversation (`$currentCwd` in `store/session.ts`, remembered,
  persisted, set on sidebar project click).

---

## 3. The standard to follow (merged Grok × Hermes)

**Files in a conversation = workspace-scoped, git-aware, clickable.**

| Surface | Grok Bot | Hermes desktop | MaiaVM target |
|---|---|---|---|
| In-chat file card | fileCardWrap + sand-file-viewer | — | ✅ inline file cards in bubbles |
| File tree | outline panel | react-arborist tree | ✅ right-side panel tree |
| Git status | branch/notes in workspace state | RepoChangeKind badges | ✅ badges + branch chip |
| Open/read file | SimpleFileChunk protocol | readDesktopFileText | ✅ hermes bridge read |
| Edit | — | CodeMirror 6 spot-edit | ✅ CodeMirror spot-edit |
| Diff | file_diff_histories | FileDiffPanel | ✅ diff view |
| Terminal | BoxShell chips | full terminal panel | ✅ phase 2 |
| File-type icons | seti/cursor theme | — | ✅ seti mapping |
| Drag-drop attach | composer drop | — | ✅ phase 2 |
| Remote FS | cloud box | /api/fs/* HTTP | ✅ /api/fs via Hetzner |
| Projects | — | hermes project + worktrees | ✅ phase 2 |

---

## 4. Implementation plan for maiavm-desktop

### Phase 1 — Files in the conversation (grok parity, hermes backend)
1. **Bridge**: extend `electron/main.cjs` `maia:hermes` with a `fs` kind →
   `hermes` (or a small Node fs wrapper in main process) exposing:
   `list <path>`, `read-text <path>`, `write-text <path> <content>`,
   `stat`, `git-status <path>`, `git-diff <path>`, `root` (default cwd).
   - Local dev: main-process Node fs (Electron IPC like hermes desktop local mode).
   - **Hetzner**: same bridge, but `fs` kind routes to the remote box —
     preferred: hermes desktop's own `HermesConnection` / `/api/fs/*` HTTP
     surface (profile-scoped), since that is already hardened and tested.
2. **Workspace context per conversation**: add `cwd?: string` (+ optional
   `branch?: string`) to `Conversation`. Persisted (already have the
   client-persisted store). Hydrated hermes conversations get `cwd` from the
   session export (`cwd` field exists in export records) — big win, already
   available.
3. **File card messages**: extend `ChatMessage` with a `fileRefs` array
   (`{ path, lineStart?, lineEnd? }`). When the hermes stream emits file
   activity (tool chips `Reading file` / `Drafting the file`), attach the
   path; the Bubble renders a file card (seti icon + basename + relative
   path + line range + click → open preview).
4. **File preview panel**: new right-rail component (like hermes desktop
   `preview-file.tsx`):
   - read via bridge (`read-text`), Shiki highlight (github themes), line
     numbers, virtualized rows
   - diff mode via `git-diff`
   - CodeMirror 6 spot-edit + write-back via `write-text`
   - image/video/audio preview via data-URL
5. **Icons**: add a `file-icon.ts` with the seti/cursor mapping subset
   (the grok `$nt` extension→icon+color table); fallback `file-text`.

### Phase 2 — File tree + projects (hermes desktop parity)
6. **Right-side file tree panel**: `react-arborist` (already the hermes
   desktop dependency — copy its use), lazy `list` via bridge, gitignore
   filtering, dirs-first sort, status badges (`RepoChangeKind`), inline
   rename, context menu (reveal/rename/trash), click file → preview,
   click folder → navigate, branch chip in the panel header.
7. **Projects**: read `hermes project list` via bridge into the sidebar
   (project rows + expand → repo lanes via `git worktree list`), active
   project sets conversation cwd (hermes desktop parity). New project →
   `hermes project create` + `add-folder` (folder picker in main process).
8. **Terminal panel**: hermes desktop has a full terminal stack — port the
   workspace terminal (or phase-3: shell chips → open external).

### Phase 3 — polish
9. Drag-drop file attach into composer (grok parity), upload/attach via
   bridge to the agent session.
10. File citations in streamed markdown (`file.ts#L10` → open preview).
11. `.plan.md` special card (grok: list-todo icon, yellow).

---

## 5. Verified references (so implementation doesn't re-research)
- Grok file viewer state component: `Bu(n){icon,title,detail,action}` —
  `sand-file-viewer__state`, 32px icon, sm title, xs tertiary detail.
- Grok file-card entries: `fileCardWrap` / `linkCardWrap` / `widgetWrap`
  are sibling transcript entry kinds.
- Grok file-type icons: `$nt({filenameOrExt, preferred})` + `qTt` matches
  (e.g. `.plan.md → {icon:"list-todo", color:"iconYellowPrimary"}`) +
  full `file-type-*` codicon set.
- Hermes tree: `apps/desktop/src/app/right-sidebar/files/{tree,ipc,
  use-project-tree,dnd-manager}.ts*`; entry `{name, path, isDirectory}`,
  22px rows, dirs-first.
- Hermes preview: `apps/desktop/src/app/chat/right-rail/preview-file.tsx`
  (Shiki + CodeMirror 6 + FileDiffPanel + 512KB cap).
- Hermes remote FS: `lib/desktop-fs.ts` — `/api/fs/list|read-text|write-text|
  read-data-url`, path hardening, profile-scoped, ssh-remote connections.
- Hermes projects: `hermes project` CLI + `chat/sidebar/projects/*`
  (`model.ts`, `workspace-groups.ts`, `workspace-header.tsx`,
  `base-branch-picker.tsx`, `worktree-dialog.tsx`).

---

## 6. Hetzner note
The remote FS mode is the intended path: the desktop app talks to the box
over `HermesConnection` (ssh/dashboard) → `/api/fs/*`. Users get a real file
tree of the VM's workspace, edit with CodeMirror, see git status, and the
agent (running on the box) reads the same files — no sync layer needed.
Phase 1 can be done purely over the existing `maia:hermes` bridge by adding
a `fs` kind that shells out to `hermes` file helpers or a hardened Node fs
handler in the main process; the `/api/fs` remote path drops in later.
