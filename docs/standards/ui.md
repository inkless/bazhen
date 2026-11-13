# UI standards

How to build UI in `apps/web`: what the look is made of, and the rules that keep a new screen
consistent with the rest and cheap to re-theme.

| Rule                                                                                         | Enforced by                                             |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Screens use only semantic tokens: no literal colours, no primitives                          | `pnpm check` (`scripts/check-standards.ts`)             |
| Every text/background pair the UI draws meets WCAG 2.2 AA, in every theme                    | `pnpm test` (`apps/web/src/ui/token-sheet.test.ts`)     |
| A new pair of foreground and background is added to that test                                | review                                                  |
| Screens take interactive widgets from `apps/web/src/ui/`, never from `react-aria-components` | `pnpm lint` (`onlyThrough` in `scripts/lint-config.ts`) |
| Interactive targets are at least `--size-hit-min`                                            | review                                                  |

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
(`pnpm dev`). It is not part of the build.

## Adding a colour

1. Pick the role it plays. If an existing semantic token plays it, use that token.
2. Otherwise add a semantic token to the mapping in `tokens.css`, onto the primitive step whose
   role matches (a hover background is step 4, body text is step 12), in both themes.
3. Add each pair it is drawn with to `TEXT_ON` or `SEEN_ON` in
   `apps/web/src/ui/token-sheet.test.ts`, and run `pnpm test`.
4. A new hue is a new 12-step scale in `palette.css`, light and dark.

## The terminal

xterm.js draws from its own theme object, not CSS, so `terminalTheme()`
(`apps/web/src/terminal/theme.ts`) builds it from the `--color-terminal-*` tokens in `tokens.css`:
background, text, cursor, selection and the 16 ANSI colours, each mapped onto the palette like any
other colour. The contrast test holds the text and every ANSI colour to 4.5:1 on the terminal's
background, in every theme, with one exception per theme: ANSI assumes a black background, so
`ansi-black` in dark and `ansi-bright-white` in light are the background's own end of the scale.
Programs paint cells with those rather than write in them, so the test holds the text and the
opposite end of the scale written on them to 4.5:1 instead.

An open terminal recolours in place when the theme changes, here, in another tab of the device,
or in the system's settings under "System"; its stream is untouched.

An agent's TUI picks its own colours when it starts, so a launch and a respawn tell the daemon
the theme its terminal shows, and the daemon passes it to the harness for that start only:

- Claude Code gets `theme` in the settings it is started with, over the user's own.
- Codex has no light or dark of its own: `tui.theme` gets the bundled `one-half-light` or
  `one-half-dark` syntax highlighting, over the user's own, and the rest of its colours follow
  the background the terminal reports, which the daemon answers as black. A Codex terminal
  therefore stays on the dark palette in every theme.

A running agent keeps the theme it started with until it is respawned. An agent started without
the web client, from the CLI or by a daemon restart, keeps the user's own setting.

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

A new widget (a menu, a combo box, a toast) is a new wrapper: import the React Aria component by
name, style it from semantic tokens, and add the pairs it draws to the contrast test. Its
translated strings ship for `en-US` only (`optimizeLocales` in `apps/web/vite.config.ts`); a
locale the UI is translated into goes in that list too.

Not everything needs one. A list that navigates, like the fleet, stays a native list of
buttons: React Aria's `GridList` is a selection widget, with `role="grid"`. Native inputs and
`<details>` stay native too, since React Aria adds nothing to them.

## Browsers

`light-dark()` sets the floor: Safari 17.5, Chrome 123, Firefox 120. That covers a phone on the
LAN on a current OS.
