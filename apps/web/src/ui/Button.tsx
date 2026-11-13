import { Button as AriaButton, type ButtonProps as AriaButtonProps } from "react-aria-components";

export type ButtonProps = Omit<AriaButtonProps, "className" | "style"> & {
  variant?: "primary" | "secondary" | "quiet" | "link";
};

/** Every action button. Press handling is React Aria's: one press for mouse, touch, pen and keys. */
export function Button({ variant = "secondary", ...props }: ButtonProps) {
  return <AriaButton {...props} className={`button button-${variant}`} />;
}
