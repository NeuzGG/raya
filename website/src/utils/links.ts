const base = import.meta.env.BASE_URL.replace(/\/$/, '');

/** Prefix a site path with the configured base path. */
export function link(path: string): string {
  return `${base}/${path.replace(/^\//, '')}`;
}
