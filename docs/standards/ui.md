# UI standards

How to build UI in `apps/web`: what the look is made of, and the rules that keep a new screen
consistent with the rest and cheap to re-theme.

| Rule                                                                                         | Enforced by                                                  |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Screens use only semantic tokens: no literal colours, no primitives                          | `moon run :check` (`scripts/check-standards.ts`)             |
| Every text/background pair the UI draws meets WCAG 2.2 AA, in every theme                    | `moon run :test` (`apps/web/src/ui/token-sheet.test.ts`)     |
| A new pair of foreground and background is added to that test                                | review                                                       |
| Screens take interactive widgets from `apps/web/src/ui/`, never from `react-aria-components` | `moon run :lint` (`onlyThrough` in `scripts/lint-config.ts`) |
| Interactive targets are at least `--size-hit-min`                                            | review                                                       |
| A keystroke's path does no work beyond sending it; work over 50 ms yields                    | review                                                       |
| The page stays ready for a strict CSP: no `eval`, no HTML strings, no remote script          | review                                                       |
| The page reaches storage only through `deviceStorage` (`apps/web/src/storage.ts`)            | `moon run :lint` (`scripts/lint-config.ts`)                  |

## Tokens

Two tiers, both CSS custom properties in `apps/web/src/ui/`:

- **Primitives**, `palette.css`: raw 12-step scales, one per hue (`neutral`, `blue`, `green`,
  `amber`, `red`), each in a light and a `-dark` variant. Every step has a role: 1–2 app
  backgrounds, 3–5 component backgrounds (normal, hover, selected), 6–8 borders (subtle, normal,
  strong), 9–10 solid fills, 11–12 text (low and high contrast). Only `tokens.css` reads them.
- **Semantic tokens**, `tokens.css`: what a colour is for (`--color-text`, `--color-surface`,
  `--color-danger-subtle`), each mapped onto a primitive. Screens and components use these and
  nothing else.

Spacing, radius, sizes, type and motion have one tier, also in `tokens.css`: the scale is the
token (`--space-1` to `--space-5` on 4px steps, `--font-size-sm`, `--duration-fast`). A category
gets a second tier when a theme first needs to remap it. Layout widths and breakpoints stay
literal; they belong to one screen's layout, not to the look.

Names follow the Design Tokens Community Group format: a CSS name is the token's path with
hyphens for dots (`--color-text` is `color.text`, an alias of `{color.neutral.12}`), and each
group in `tokens.css` notes its `$type`. That keeps a DTCG JSON export a mechanical step for
when a second client needs the same tokens.

## Themes

A theme is a mapping from semantic tokens to primitives, written once in `tokens.css`, one line
per token, light then dark:

```css
--color-text: light-dark(var(--color-neutral-12), var(--color-neutral-dark-12));
```

The system's light or dark preference picks the side. A device can pin one by storing
`bazhen.theme` (`light` or `dark`) in local storage, which sets `data-theme` on `<html>`. A
preference for more contrast remaps a few tokens in the block at the end of `tokens.css`, and
forced colours (Windows High Contrast) replace backgrounds with system colours, so anything a
background alone marks also gets a border or outline (`ui.css`). Reduced motion sets the
durations to zero.

A new theme is another mapping block; it never touches a screen.

To see every semantic colour in both themes, open `/swatches.html` on the dev server
(`moon run :dev`). It is not part of the build.

## Adding a colour

1. Pick the role it plays. If an existing semantic token plays it, use that token.
2. Otherwise add a semantic token to the mapping in `tokens.css`, onto the primitive step whose
   role matches (a hover background is step 4, body text is step 12), in both themes.
3. Add each pair it is drawn with to `TEXT_ON` or `SEEN_ON` in
   `apps/web/src/ui/token-sheet.test.ts`, and run `moon run :test`.
4. A new hue is a new 12-step scale in `palette.css`, light and dark.

One file holds palette colours of its own: the app icon, `apps/web/public/icon.svg`, which the
browser and the OS draw as an image, where no token resolves. It is `--color-neutral-12`,
`--color-neutral-1` and `--color-blue-dark-9` in sRGB; a change to those steps changes it too.

## The terminal

xterm.js draws from its own theme object, not CSS, so `terminalTheme()`
(`apps/web/src/terminal/theme.ts`) builds it from the `--color-terminal-*` tokens in `tokens.css`:
background, text, cursor, selection and the 16 ANSI colours, each mapped onto the palette like any
other colour. The contrast test holds the text and every ANSI colour to 4.5:1 on the terminal's
background, in every theme, with one exception: ANSI assumes a black background, so `ansi-black`
in dark is the background's own end of the scale. Programs paint cells with it rather than write
in it, so the test holds the text and `ansi-white` written on it to 4.5:1 instead. In light,
`ansi-bright-white` is text too (`\e[97m`), so it is a grey that reads rather than a white that
would vanish, and a cell painted with it carries light text poorly. Bold is drawn in its own
colour, not the bright one. The selection is a solid fill, 3:1 against the background, with its
own text colour.

The terminal draws in JetBrainsMono Nerd Font Mono, which the page bundles
(`apps/web/src/terminal/font/`, cut by `moon run :font-terminal` from a pinned release), so Nerd Font
icons draw on a device with nothing installed. Its icons are the same in every style, so they ship
once: four text faces carry no icons, and one symbols face, declared for every weight and style so
the browser never emboldens or slants an icon, carries only them. `terminalFontFamily()`
(`apps/web/src/terminal/font.ts`) lists the text family, then the symbols family, then the system's
monospace stack, with a device's own `bazhen.fontFamily` ahead of them all. An icon fills one cell
because two things agree: every glyph of every bundled face is 600 units of a 1000-unit em, a
letter's advance, which the font script checks as it cuts and `terminal-font.medium.test.ts` holds
the committed files to; and Unicode 11 widths give each icon one cell, which `widths.test.ts` holds.
xterm.js measures its cell only when it opens or its family changes, and the WebGL renderer keeps
each glyph it has drawn. So a terminal opens once every bundled face has loaded or failed, or after
5 seconds, and if the faces arrive after that it changes its family and back, clears its glyphs and
fits again. A face that fails opens it on the fallback stack rather than not at all.

An agent's TUI picks its colours once, as it starts, so its terminal is drawn in the theme it
was started for, whatever the page's: a TUI drawn for dark is unreadable on a light terminal. A
launch and a respawn send the theme the page shows, and the daemon passes it to the harness:

- Claude Code gets `theme` in the settings it is started with, over the user's own.
- Codex has no light or dark of its own: its colours follow the background the terminal reports,
  and it gets the bundled `one-half-light` or `one-half-dark` syntax highlighting (its
  `tui.theme`), over the user's own.

A program that asks for the terminal's text or background (OSC 10/11) is told the colours of the
theme its process started for, from its first query, before any view has attached: tmux answers
from the window's style, which the runtime sets in the same command that starts the process. The
daemon, whose client a view's stream comes through, answers the same, and both read
`TERMINAL_COLOURS` in `@bazhen/protocol`, which a test holds to `terminalTheme()`. tmux also
paints the terminal's blank cells in those colours, which is what the terminal is drawn in
anyway; attaching to it from your own terminal shows the theme's background too. Each agent says
which themes its harness can start in. The page itself, and a terminal's contrast preference,
still follow the device live.

When the page's theme differs from an open agent's, the page lists it with "Respawn in <theme>",
behind a confirm. An exited agent respawns at once; a running one is stopped and respawned, and
only between turns as its harness reports them, so an agent whose harness reports nothing says it
can't tell. The confirm checks that again against the latest snapshot, and an agent that hasn't
exited 15 seconds after the stop is left as it is, with a message. If the page goes away between
the stop and the respawn, the agent is left exited, with its own Respawn. An agent started without the web client, from the CLI or by a daemon
restart, is drawn dark and keeps the user's own setting.

## Interactive widgets

Behaviour comes from [React Aria Components](https://react-spectrum.adobe.com/react-aria/)
(Adobe, Apache-2.0): keyboard, touch, focus and screen-reader handling, unstyled. Screens don't
import it. Each widget is a wrapper in `apps/web/src/ui/` that fixes its props and owns its CSS
in `ui.css`, styled on React Aria's `data-*` states (`data-hovered`, `data-pressed`,
`data-focus-visible`, `data-selected`) rather than `:hover` and `:focus`, which stick after a
tap on a phone.

- `Button` for every action, with a `variant`: `primary`, `secondary`, `quiet`, `link`.
- `ConfirmDialog` for a button that asks first: a modal that traps focus, returns it to the
  trigger, and closes on Escape or a tap outside. Its confirm acts once per opening; the screen's
  own command should still refuse a second send while the first is in flight.
- `ThemeSwitch`, the header's System / Light / Dark choice.
- `ToggleButton` for a button that stays pressed until pressed again, such as the key bar's
  sticky Ctrl.

- `Toolbar` for a row of controls that is one tab stop, such as the key bar.

On a phone or an iPad, a key bar under the terminal types what their keyboards lack: Esc, Tab,
Ctrl, the arrows, newline and Enter, through the same key map and lease as a typed key. Its keys
take `preventFocusOnPress`, so a tap leaves focus, and the soft keyboard, on the terminal. It is
the app's bottom row, so it sits on the soft keyboard, and the user can hide it per device.
Stacking goes by `--z-key-bar` and `--z-modal`; a terminal's host isolates xterm.js's own layers.

A new widget (a menu, a combo box, a toast) is a new wrapper: import the React Aria component by
name, style it from semantic tokens, and add the pairs it draws to the contrast test. Its
translated strings ship for `en-US` only (`optimizeLocales` in `apps/web/vite.config.ts`); a
locale the UI is translated into goes in that list too.

Not everything needs one. A list that navigates, like the fleet, stays a native list of
buttons: React Aria's `GridList` is a selection widget, with `role="grid"`. Native inputs and
`<details>` stay native too, since React Aria adds nothing to them.

## The app shell

The page is an app the size of the screen, never a document that scrolls: on a phone a page
scroll and a terminal's scroll fight over the same swipe, and the terminal ends up somewhere
below the fold. So:

- `.app` (`apps/web/src/app.css`) is the part of the window the user sees, `--app-top` and
  `--app-height`, which `apps/web/src/ui/viewport.ts` sets from the visual viewport. `html` and
  `body` don't scroll or bounce.
- Only a pane whose content can outgrow it scrolls, inside itself and without chaining
  (`overflow: auto; overscroll-behavior: contain`): the rail, a list in the centre, the notices,
  and what sits above an agent's terminal, capped at 40% of the workspace, 25% where the app shows
  one thing at a time. An agent's terminals get the rest, less their fixed chrome (status lines,
  the dock's and shells' headers and tabs), and `tests/e2e/layout.spec.ts` holds each screen to it. Anything else fills its parent through flex with `min-height: 0`; no
  height is in `vh`. A one-finger drag over nothing that scrolls that way doesn't move the page
  (`apps/web/src/ui/pan-guard.ts`): with the keyboard up iOS would pan it, sliding the app off
  what the user sees. A pinch and a drag in a text field are left alone, and so is a drag's
  first 10px where anything scrolls either way, since a swipe can lean the wrong way at first.
  React Aria's modals and popovers prevent it themselves.
- Under 700px wide, or 500px tall (`ONE_PANE`, `apps/web/src/shells/layout.ts`), the app shows
  one thing at a time: the fleet, or what was opened from it under the Fleet, Inbox and Tasks
  links. The app's header, the daemon's details, the launch form and the attach commands are on
  the fleet screen, or a wider one, only there; an agent's TUI and its shells are tabs, not one
  above the other. Elsewhere a screen too short to stack them (`TOO_SHORT_TO_STACK`; a touch
  screen's controls are taller) puts the dock beside the TUI where it fits, whatever was chosen,
  and makes them tabs where it doesn't (`useTabbedDock`), so every terminal shown is wholly in view. When the pane that opens leaves focus nowhere, as on a control the fleet's list
  took with it, focus moves to the pane.
- A terminal is never shorter than `6rem`: the daemon refuses a view of fewer than two rows.
- The soft keyboard shortens the app, so a terminal resizes to what is left and its input row
  stays above the keyboard. iOS doesn't shrink the layout viewport, or `dvh`, for the keyboard,
  so nothing but the visual viewport says how much is left. A change of the visual viewport, or of
  focus, is taken once both have held still for 150 ms, the last of a run of changes: a keyboard
  animating in or out is one resize for the program, not one a frame, and a pinch zoom is none. A
  change of the window itself, a phone turning, is taken at once, so the app is never taller than
  the window.
- While the keyboard is up for a focused terminal, the app shows that terminal with its status,
  any alert, and the key bar (`data-typing` on `<html>`). It is set with the app's height, never
  from focus alone: a terminal losing focus as the keyboard closes would otherwise bring the
  chrome back while the app is still short, and the program would be resized twice. The key bar's
  Done closes the keyboard, where Safari's own accessory bar may not show.
- The viewport meta has `viewport-fit=cover`, so the app pads itself clear of the notch and the
  home indicator with `env(safe-area-inset-*)`.

## Responsiveness

A key pressed in a terminal is the interaction users feel most, and a phone the slowest device we
serve. Interaction to Next Paint (INP) measures it: how long after a tap or key the next frame
shows.

- The path from a key to the daemon does nothing else: no state update that re-renders a screen,
  no parsing. A busy main thread delays the key behind it.
- A task over 50 ms is a long task and blocks input. Split a loop that can run that long, such as
  replaying a backlog, and `await scheduler.yield()` once 50 ms are spent, falling back to
  `setTimeout(resolve, 0)` where it is missing.
- Before fixing a slow interaction, find which part it is: input delay (the thread was busy),
  processing (our handler) or presentation (style and layout after it). A fix aimed at the wrong
  part leaves the latency where it was.

## Page security

A terminal is a remote shell, so a script injected into the page is the whole machine. Keep the
page ready for a policy that allows only its own scripts:

- No `eval`, `new Function` or string timers, and no HTML built from strings (`innerHTML`,
  `dangerouslySetInnerHTML`): terminal output and agent text are text nodes.
- No script from another origin, and no new inline script; the one in `index.html` is allowed
  because a policy can name its hash.
- Widening `script-src` (`'unsafe-inline'`, a host or `https:` allowlist) needs its reason in the
  commit: an allowlisted host's open redirect is a way past it.

Why: these cost nothing now, and a strict policy can be turned on later without a rewrite.

## Browsers

`light-dark()` sets the floor: Safari 17.5, Chrome 123, Firefox 120. That covers a phone on the
LAN on a current OS.

With site data blocked, as Safari does with all cookies blocked, merely reading `localStorage`
throws, and a throw while rendering takes the whole page down. So the page keeps a device's
settings only through `deviceStorage` (`apps/web/src/storage.ts`): a read that fails finds
nothing, and a write that fails lasts until the page reloads. `index.html`'s theme script, which
runs before any module, guards its own read.

On a Linux, Windows or ChromeOS desktop a browser tab keeps Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Shift+W
and Ctrl+Tab: the page never sees them, so nothing it does can pass them to a terminal. An
installed app's window offers the page every key first, and xterm.js sends Ctrl+W, Ctrl+T, Ctrl+N,
Ctrl+Tab and Ctrl+Shift+Tab on; it sends no Ctrl+Shift letter, so Ctrl+Shift+W still closes the
window. So there, and only there, the page links its manifest and app icon
(`apps/web/src/install.ts`), and `apps/web/src/terminal/close-guard.ts` asks before a close, in a
tab or the app's window, while Ctrl is down in a focused terminal. A Mac doesn't lose these keys,
and a phone or a tablet is touch-first, so they get neither. Playwright's keys skip the browser's
own shortcuts, so no e2e test presses the real Ctrl+W: check a change here by hand, in a tab and in
the installed app.
