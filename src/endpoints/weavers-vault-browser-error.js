/**
 * Thrown when the vault cannot get a browser at all: no binary, no debugging
 * port, or a challenge that never cleared.
 *
 * One definition, not one per backend: the janitor and janny modules re-export
 * this exact class and the routes catch it by identity, so a second class would
 * silently stop the "show the browser window" recovery from ever firing.
 */
export class VaultBrowserUnavailable extends Error {
    constructor(message) {
        super(message);
        this.name = 'VaultBrowserUnavailable';
    }
}
