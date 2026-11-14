import {
  ToggleButton as AriaToggleButton,
  type ToggleButtonProps as AriaToggleButtonProps,
} from "react-aria-components";

export type ToggleButtonProps = Omit<AriaToggleButtonProps, "className" | "style">;

/** A button that stays pressed until pressed again, like a sticky modifier key. */
export function ToggleButton(props: ToggleButtonProps) {
  return <AriaToggleButton {...props} className="button button-secondary toggle-button" />;
}
