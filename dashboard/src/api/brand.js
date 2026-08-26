/**
 * The product's own mark.
 *
 * Branding is resolved server-side and normally arrives inline as a data: URI
 * (see `_resolved_branding`). This is the client-side floor: what to show
 * before bootstrap has answered, or if a site's branding resolves to nothing.
 * Previously those cases rendered two text initials, which is not a brand.
 */

export const APP_LOGO = '/assets/techsarena_hr/dashboard/logo-128.png';
export const APP_NAME = 'Techsarena HCM';

/** The logo to render, preferring whatever the site has configured. */
export function brandLogo(branding, { login = false } = {}) {
  return (
    (login ? branding?.login_logo_data : null)
    || branding?.app_logo_data
    || (login ? branding?.login_logo : null)
    || branding?.app_logo
    || APP_LOGO
  );
}

export const brandName = (branding) => branding?.name || APP_NAME;
