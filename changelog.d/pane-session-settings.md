### Added
- An OpenCode 2 chat's composer pill now switches the session's agent and model: pressing it opens one
  sheet with the agent first (the same primary agents `/agents` lists) and a searchable model list
  grouped by provider, with the reasoning variants of the model it runs under its row. The switch goes
  through the OpenCode service the session belongs to, so the terminal's own footer follows it and no
  keystroke is typed into the pane. The pill is a plain label where the pane is not such a session.
- `/agents` and `/models` typed in a supported composer open that sheet instead of handing the
  command to the terminal.
