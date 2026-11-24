# Roadmap

Ideas we plan to build. Nothing here is promised or scheduled yet.

## Share a tab's memory with a new tab

**Problem.** Each tab has its own memory, so a sign-in only lasts inside the tab
it happened in. Sign in to Gmail, then open ChatGPT in a new tab and choose
"Continue with Google": Google doesn't know you there, so it asks for the full
sign-in and two-factor check again before ChatGPT asks for its own code. In the
Gmail tab itself, "Continue with Google" goes straight through. Today the only
way to reuse a sign-in is to stay in that one tab.

**Idea.** An explicit, opt-in way to open a tab that shares another tab's memory:

- **Tab menu:** "New Tab with Same Memory".
- **Link menu:** "Open Link in Tab with Same Memory", next to the existing
  "Open Link in New Private Tab".

**How it should behave.**

- Tabs that share memory are grouped together in the sidebar, so it's clear
  which ones can see each other's cookies and sign-ins.
- The shared memory is wiped when the last tab in the group closes. That is
  how pop-ups that share their opener's memory already work (sign-in windows,
  for example).
- Every other tab stays isolated. A plain new tab, ⌘T, and "Open Link in New
  Private Tab" still start with empty memory.
- Nothing is ever written to disk.

**Open questions.**

- How groups look in the sidebar (and in Legacy mode): a coloured edge, a
  bracket, or nested tabs.
- Whether a group can be named (for example "Google").
- Whether dragging a tab into a group should be allowed. Moving memory between
  tabs that already have pages loaded is probably not worth it.
