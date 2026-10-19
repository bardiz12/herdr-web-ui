### Added
- OpenCode 2.0 or later: its questions are answered from the chat's prompt card through OpenCode's
  own background service instead of keystrokes, one question at a time with Back to change an earlier
  answer, and sent together after the last. OpenCode 1 keeps Terminal.

### Fixed
- Native question answers stay bound to the current pane, session and form. Local service discovery
  rejects stale or non-loopback endpoints, and slow services cannot hold the input queue for minutes.
- Back and question tabs preserve unsent edits; custom multiselect answers remain available, and
  abandoned form drafts are cleared and bounded.
