import styles from "./Spinner.module.css";

interface SpinnerProps {
  /// Diameter in pixels. Defaults to a compact 14px that sits inline with text.
  size?: number;
  /// Accessible label announced to screen readers while the spinner shows.
  label?: string;
  /// Extra class (e.g. to set the color via `currentColor`).
  className?: string;
}

/// A small inline loading spinner. Draws its ring from `currentColor`, so it
/// picks up whatever text color it's dropped into (status bars, headers). The
/// ring keeps rotating but slows right down under prefers-reduced-motion.
export function Spinner({ size = 14, label = "Loading", className }: SpinnerProps) {
  return (
    <span
      className={`${styles.spinner}${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      role="status"
      aria-label={label}
    />
  );
}
