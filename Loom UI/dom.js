/**
 * Small DOM helpers shared by the Loom UI entry and its settings drawer.
 * Kept dependency-free so they can be unit tested outside a browser.
 */

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[character]);
}