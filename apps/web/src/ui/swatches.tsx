import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import paletteCss from "./palette.css?raw";
import { mappingOf, type Scheme } from "./token-sheet.ts";
import tokensCss from "./tokens.css?raw";
import "./palette.css";
import "./tokens.css";
import "./ui.css";

const SCHEMES: Scheme[] = ["light", "dark"];

/** Dev only (`/swatches.html` on the Vite dev server): every semantic colour in both themes. */
function Swatches() {
  const mapping = mappingOf(tokensCss, false);
  return (
    <main style={{ padding: "var(--space-4)" }}>
      <h1>Colour tokens</h1>
      <p>
        {mapping.size} semantic tokens over {paletteCss.match(/--color-/g)?.length ?? 0} primitives.
        A system preference for more contrast swaps in the overrides at the end of tokens.css.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-4)" }}>
        {SCHEMES.map((scheme) => (
          <table
            key={scheme}
            aria-label={`${scheme} theme`}
            style={{
              colorScheme: scheme,
              background: "var(--color-bg)",
              color: "var(--color-text)",
              padding: "var(--space-3)",
            }}
          >
            <tbody>
              {[...mapping].map(([name, sides]) => (
                <tr key={name}>
                  <td>
                    <span
                      style={{
                        display: "inline-block",
                        width: "var(--space-5)",
                        height: "var(--space-4)",
                        border: "1px solid var(--color-border-strong)",
                        background: `var(--${name})`,
                      }}
                    />
                  </td>
                  <td>
                    <code>--{name}</code>
                  </td>
                  <td>
                    <code>--{sides[scheme]}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <StrictMode>
    <Swatches />
  </StrictMode>,
);
