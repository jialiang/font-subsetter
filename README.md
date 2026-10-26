# font-subsetter

Build tool for my own sites. Not supported: the API may change without notice.

Subsets web fonts to the characters a page renders in each face.
It reads the page's HTML and CSS, works out which family, weight and style
every piece of text gets, then runs `pyftsubset` once per face and format.

## Requirements

1. Python
2. [uv](https://docs.astral.sh/uv/) on the `PATH`

If deploying through GitHub Actions, add
[`astral-sh/setup-uv`](https://github.com/astral-sh/setup-uv) before the build.

## Usage

```js
import { subsetFonts } from "font-subsetter";

await subsetFonts({
  html,
  stylesheets: [lightCss, darkCss],
  families: {
    "Noto Sans JP": "noto-sans-jp",
    "Noto Sans JP Critical": { name: "noto-sans-jp-critical", source: "noto-sans-jp" },
  },
  extraCharacters: { "noto-sans-jp-regular": "0123456789" },
  sourceDirectory: "./src/fonts/originals",
  outputDirectory: "./dist/fonts",
});
```

It resolves with the file base name of every face it wrote.

| Option            | Default                | Meaning                                                                                                                                |
| ----------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `html`            |                        | The page. Text in `head`, `script` and `style` is ignored.                                                                             |
| `stylesheets`     |                        | One CSS string per page state (such as light and dark theme). Characters are collected under each and merged.                          |
| `families`        |                        | CSS family name to file base name, or `{ name, source }` when the output name differs from the source files' name.                     |
| `fileName`        | `name-weight[-italic]` | Builds a file base name from `{ name, weight, style }`. `weight` is a word (`regular`, `bold`...) and `style` is `normal` or `italic`. |
| `extraCharacters` | `{}`                   | Characters to add per output face, for text that scripts write at runtime.                                                             |
| `sourceDirectory` |                        | Where the original `.ttf` files are.                                                                                                   |
| `outputDirectory` |                        | Where the subsets are written. Created if missing.                                                                                     |
| `pyftsubset`      | run through `uvx`      | Path to your own `pyftsubset` executable, to use instead of uv.                                                                        |
| `formats`         | `["woff2", "woff"]`    | Output formats.                                                                                                                        |

## How faces are matched

A `font-family` list picks its first family that is in `families`.
Text in any other family isn't collected.

Each piece of text goes to the `@font-face` the browser would render it with.
When no face has the requested weight or style, that's the nearest declared
face, the one the browser synthesizes the bold or italic from (following the
[CSS font matching rules][matching]). So the `@font-face` rules must be in
`stylesheets`, at any depth (`@media` included).

Every face that gets text needs an original `.ttf` in `sourceDirectory`,
named by `fileName` with the family's `source` as `name`
(such as `noto-sans-jp-bold.ttf`).

## Limits

1. Only top-level style rules are read: those inside `@media`, `@supports`,
   `@layer` or `@container` are skipped.
2. Only `font-family`, `font-weight` and `font-style` are read, not the `font`
   shorthand or `var()`.
3. Inline `style=""` attributes and `!important` are ignored: the cascade is
   specificity and source order only.
4. `revert` and `revert-layer` take the parent's value like `inherit`, rather
   than the browser default.
5. Rules on interaction states are ignored. `:hover`, `:active` and `:visited`
   never match. `:focus`, `:focus-visible`, `:focus-within`, `:target` and
   `:placeholder-shown` are skipped with a warning.
6. Rules on `::first-line`, `::first-letter`, `::before` and `::after` are
   skipped and text from `content` isn't collected.
7. Characters the tool can't see have to be listed in `extraCharacters`:
   those that `text-transform` or `font-variant` produce (such as the capitals
   of `uppercase` text), text that scripts add at runtime and the hyphen
   (`‐` or `-`) a browser draws where a soft hyphen breaks a line.
8. A character the source font doesn't have fails the build. Invisible
   formatting characters (soft hyphens, zero-width joiners, variation
   selectors) are left out instead, since they never take a glyph.
9. Source fonts must be `.ttf` files.
10. `@font-face` rules with a weight range (variable fonts) are ignored.
11. Vertical text isn't supported: the vertical metrics tables (`vhea`,
    `vmtx`) are dropped, along with `BASE` (cross-script baselines) and `STAT`
    (variable-font style names).

[matching]: https://drafts.csswg.org/css-fonts/#font-style-matching
