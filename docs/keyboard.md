# Keyboard shortcuts

| Key                                          | Action                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Enter`                                      | Split at the caret into a new sibling below (at the end of an expanded bullet, adds a child at the top instead) |
| `Tab` / `Shift+Tab`                          | Indent / outdent                                                                                                |
| `Cmd/Ctrl+Shift+↑` / `↓`                     | Move the bullet among siblings; at the edge reparent into the parent's adjacent sibling                         |
| `Cmd/Ctrl+↑` / `↓`                           | Collapse / expand                                                                                               |
| `Cmd/Ctrl+Enter` or `Cmd/Ctrl+D`             | Toggle complete                                                                                                 |
| `Cmd/Ctrl+.` / `Cmd/Ctrl+,`                  | Zoom in / out                                                                                                   |
| `Backspace` at the start of a task or bullet | Delete the last Markdown marker character and reveal the remaining prefix as editable text                      |
| `Backspace` at the start of a paragraph      | Join into the previous visible row; delete an empty paragraph and focus the previous row                        |
| `Arrow ↑` / `↓` at line edges                | Move between bullets (preserves the caret column)                                                               |
| `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z`            | Undo / redo                                                                                                     |
| `Shift+↑` / `↓`                              | Select whole nodes (then `Tab` indents the run, `Backspace` deletes it, …)                                      |
| `Cmd/Ctrl+K`                                 | Open Find (nodes everywhere, DQL, and commands)                                                                 |
| `Cmd/Ctrl+F`                                 | Filter the current view (`?q=` — tags, operators, free text)                                                    |
| `q`                                          | Quick-add capture (files to Today without leaving where you are)                                                |

The `/` menu on any bullet lists every command (to-do, paragraph, move,
mirror, formatting, …), and `Cmd/Ctrl+K` runs node + global actions from
anywhere.

In an outline row, type `- ` at the start of a paragraph to make it a bullet.
Type `[]`, `[ ]`, or `[x]` at the start of a paragraph or bullet to make it a task.
Backspace removes one marker character at a time: a task becomes a bullet with
`[ ` before its text; a bullet becomes a paragraph with `-` before its text.
The caret stays after the remaining prefix so you can keep deleting it, or type
the missing characters to restore the kind. Text and children stay intact.
