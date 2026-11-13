import { ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { THEMES, useTheme, type Theme } from "./theme.ts";

const LABEL: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };

/** This device's theme: the system's, or pinned light or dark. */
export function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  return (
    <ToggleButtonGroup
      aria-label="Theme"
      className="segmented"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[theme]}
      onSelectionChange={(keys) => {
        const next = THEMES.find((t) => keys.has(t));
        if (next !== undefined) setTheme(next);
      }}
    >
      {THEMES.map((t) => (
        <ToggleButton key={t} id={t} className="segment">
          {LABEL[t]}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
