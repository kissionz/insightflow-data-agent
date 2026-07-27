# Errors

## [ERR-20260727-001] impeccable-context

**Logged**: 2026-07-27T00:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: config

### Summary
The Impeccable context helper was not mirrored into the project's `.claude` directory.

### Error
```
Error: Cannot find module '/Users/kissionz/Documents/insightflow-data-agent/.claude/skills/impeccable/scripts/context.mjs'
```

### Context
- Attempted the project-relative command required by the skill.
- The skill is installed globally at `/Users/kissionz/.codex/skills/impeccable`.

### Suggested Fix
Use the installed skill's absolute script path when the project-local mirror is absent.

### Metadata
- Reproducible: yes
- Related Files: /Users/kissionz/.codex/skills/impeccable/scripts/context.mjs

### Resolution
- **Resolved**: 2026-07-27T00:00:00+08:00
- **Notes**: Continued with the installed skill's absolute script path.

---

## [ERR-20260727-003] git-index-write

**Logged**: 2026-07-27T11:06:00+08:00
**Priority**: low
**Status**: resolved
**Area**: config

### Summary
The managed sandbox permits reading this repository's `.git` directory but not writing its index.

### Error
```
fatal: Unable to create '.git/index.lock': Operation not permitted
```

### Context
- Attempted to stage the completed UI changes with `git add`.
- Project source is writable, while `.git` metadata requires an approved escalation.

### Suggested Fix
Run the authorized Git staging command outside the sandbox.

### Metadata
- Reproducible: yes
- Related Files: .git/index

### Resolution
- **Resolved**: 2026-07-27T11:06:00+08:00
- **Notes**: Retried the user-authorized staging operation with the required permission.

---

## [ERR-20260727-002] local-dev-server

**Logged**: 2026-07-27T10:53:00+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary
The sandbox blocked the IPC socket used by `tsx watch`.

### Error
```
Error: listen EPERM: operation not permitted /var/folders/.../T/tsx-501/71370.pipe
```

### Context
- `npm run dev` starts the API with `tsx watch`.
- The initial sandboxed process could not create its IPC pipe.

### Suggested Fix
Run the approved development server command outside the sandbox for browser QA.

### Metadata
- Reproducible: yes
- Related Files: package.json

### Resolution
- **Resolved**: 2026-07-27T10:53:00+08:00
- **Notes**: The development server started successfully with the approved escalation.

---
