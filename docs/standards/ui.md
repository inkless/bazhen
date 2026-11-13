# UI standards

How to build UI in `apps/web`: what the look is made of, and the rules that keep a new screen
consistent with the rest and cheap to re-theme.

| Rule                                                                      | Enforced by                                         |
| ------------------------------------------------------------------------- | --------------------------------------------------- |
| Screens use only semantic tokens: no literal colours, no primitives       | `pnpm check` (`scripts/check-standards.ts`)         |
| Every text/background pair the UI draws meets WCAG 2.2 AA, in every theme | `pnpm test` (`apps/web/src/ui/token-sheet.test.ts`) |
| A new pair of foreground and background is added to that test             | review                                              |
| Interactive targets are at least `--size-hit-min`                         | review                                              |

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
token (`--space-1` to `--space-6` on 4px steps, `--font-size-sm`, `--duration-fast`). A category
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

## Browsers

`light-dark()` sets the floor: Safari 17.5, Chrome 123, Firefox 120. That covers a phone on the
LAN on a current OS.
