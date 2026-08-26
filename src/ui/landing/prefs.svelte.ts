/** Landing-page preferences. Nerd mode reveals the engineering margin notes
 *  (`.db-nerd` blocks in the partials); persisted so a data nerd flips it
 *  once. Storage access is guarded — the landing must render in
 *  storage-blocked embeds (Carrd iframes). */

const NERD_KEY = "landing.nerd";

function readSaved(): boolean {
  try {
    return localStorage.getItem(NERD_KEY) === "1";
  } catch {
    return false;
  }
}

class LandingPrefs {
  nerd = $state(readSaved());

  toggleNerd(): void {
    this.nerd = !this.nerd;
    try {
      localStorage.setItem(NERD_KEY, this.nerd ? "1" : "0");
    } catch {
      /* session-only in storage-blocked embeds */
    }
  }
}

export const prefs = new LandingPrefs();
