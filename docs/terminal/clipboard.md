# Clipboard, copied text and terminal graphics

## What can be copied

| Content | How to copy | What you get |
|---|---|---|
| The conversation | `/copy` | Prompts and replies as plain text: Markdown source, exact Unicode, no ANSI styling. |
| Transcript text on screen | Your terminal's mouse selection | The cells the terminal shows. Wrapping, padding and the borders of cards are layout, not content. Use `/copy` for exact text. |
| Pasted-content chips | Nothing to do | `[Pasted Content N chars]` is a label. The full paste is kept and sent to the provider. `/copy` writes the label without its hidden id. |
| The startup logo | Not copyable | See below. |

## Startup logo

The logo renderer (`src/core/terminal/logoRenderer.ts`) chooses one of four backends.
`kitty`, `iterm2` and `sixel` draw a real image; `solid` draws coloured block cells.

With the Kitty backend (Kitty, and terminals whose placeholder support Ubume detects at
startup), Ubume uploads the image once (`kittyImageCommands` in
`src/core/terminal/startupGraphics.ts`). It then draws the image with **Unicode
placeholders**: each cell holds U+10EEEE (a Private Use Area code point) followed by two
combining diacritics from Kitty's table that encode the row and column
(`kittyPlaceholderRow`). The foreground colour of those cells holds the image id
(`StartupGraphicRow.tsx`).

A selection that includes the logo therefore copies sequences like
`U+10EEEE U+0305 U+0305 U+10EEEE U+0305 U+030D …`. These are not text. Outside a terminal
displaying that same image they show as boxes or empty marks, and no clipboard can turn them
back into the picture. This is how the Kitty protocol works, so Ubume leaves the logo
unchanged. The logo has no textual content to copy. iTerm2 and Sixel images are not text
either. The `solid` backend copies as the block characters it shows.

## `/copy` on Linux

`copyToClipboard` (`src/core/shared/clipboard.ts`) uses the first bridge that works:

1. `wl-copy` when `WAYLAND_DISPLAY` is set (package `wl-clipboard`).
2. `xclip`, then `xsel`, when `DISPLAY` is set (X11 or XWayland).
3. **OSC 52**: Ubume asks the terminal to set the clipboard. The sequence carries the text's
   exact UTF-8 bytes, base64 encoded, and is written like the terminal title, outside Ink's
   frame output. Inside tmux it is wrapped in a passthrough. The limit is 8 MiB of text.

OSC 52 has no reply, so Ubume reports "sent to the terminal clipboard" rather than "copied".
Kitty allows OSC 52 writes by default (`clipboard_control write-clipboard write-primary`). If
nothing arrives, check that setting, or install `wl-clipboard`. When no bridge exists (no
display and no terminal), `/copy` says why instead of claiming success. macOS uses `pbcopy` and
Windows `clip`.

## Pasting

Bracketed paste is read as one input. Pastes of 1,000 characters or more become a chip in the
composer: a visible label plus an invisible id (U+2063, variation selectors U+FE00–FE09,
U+2063) that keeps repeated chips distinct. The content is stored in the session and expanded
at submit, so the provider receives the paste byte-for-byte, including combining marks,
private-use characters, emoji sequences, CRLF and indentation. Resizing or redrawing the
terminal never touches the stored content. Saved chat titles and `/copy` output drop the
invisible id.

## Known limitations

- Mouse selection is done by the terminal, not Ubume. A selection that crosses card borders or
  wrapped lines includes that layout.
- Kitty placeholders (the logo) cannot be represented as clipboard text.
- OSC 52 delivery depends on the terminal's clipboard policy; some terminals cap its size.
- Copying images out of Ubume is not supported. `/paste-image` reads PNG images from the
  clipboard (`wl-paste`, `xclip`, macOS, Windows).

## Tests

- `src/core/shared/clipboard.test.ts`: bridge order on Wayland and X11, the OSC 52 fallback
  with byte-level round-trips for ASCII, combining marks, private-use placeholders, emoji, ANSI
  text and line breaks, and accurate failure reasons.
- `src/session/transcriptExport.test.ts`: `/copy` text keeps every code point except chip ids.
- `src/ui/input/pastedContent.test.ts`: 1k, 10k, 22,704, 50k and 100k character pastes expand
  byte-for-byte.
