import { ThreePane } from "@/components/private/ThreePane";
import styles from "./page.module.css";

// Render per request, not at build time. ThreePane seeds "today"/"now" from
// DateTime.now() in useState initializers; under the default static prerender
// those run once at build and bake the deploy-day date into the HTML. React
// hydration keeps that stale DOM (the client initializer computes the same value
// it would set, so the re-seed effect is a no-op and never forces a repaint), so
// the calendar showed the deploy day as "today" until the user changed views.
// Rendering dynamically evaluates the initializers at request time instead.
export const dynamic = "force-dynamic";

// Private "Today" workspace (calendar · blocks · agent). Auth arrives in phase 7.
export default function Home() {
  return (
    <main className={styles.main}>
      <ThreePane />
    </main>
  );
}
