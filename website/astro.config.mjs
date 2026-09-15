// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { SITE } from './src/site.mjs';

// For GitHub Pages project sites set BASE_PATH=/raya (and SITE_URL=https://<user>.github.io).
export default defineConfig({
  site: process.env.SITE_URL || undefined,
  base: process.env.BASE_PATH || '/',
  integrations: [
    starlight({
      title: SITE.name,
      description: SITE.description,
      logo: { src: './src/assets/logo.svg' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: SITE.github }],
      customCss: [
        '@fontsource-variable/inter',
        '@fontsource-variable/bricolage-grotesque',
        '@fontsource-variable/jetbrains-mono',
        './src/styles/theme.css',
        './src/styles/tokens.css',
      ],
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      expressiveCode: {
        themes: ['github-dark-default', 'github-light-default'],
        styleOverrides: { borderRadius: '0.75rem', codeFontFamily: "'JetBrains Mono Variable', ui-monospace, monospace" },
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            'getting-started/introduction',
            'getting-started/installation',
            'getting-started/quick-start',
            'getting-started/connectors',
          ],
        },
        {
          label: 'Guides',
          items: [
            'guides/players',
            'guides/search',
            'guides/queue',
            'guides/filters',
            'guides/autoplay',
            'guides/voice-status',
            { slug: 'guides/live-now-playing', badge: { text: 'New', variant: 'success' } },
            'guides/auto-leave',
            'guides/restarts',
            'guides/resilience',
            'guides/lavalink-plugins',
            'guides/typescript',
            'guides/debugging',
            'guides/migrating-from-lavaflow',
          ],
        },
        {
          label: 'Tools',
          items: [
            { slug: 'tools/config-builder', badge: { text: 'Interactive', variant: 'tip' } },
            { slug: 'tools/filter-lab', badge: { text: 'Interactive', variant: 'tip' } },
            { slug: 'tools/event-explorer', badge: { text: 'Interactive', variant: 'tip' } },
          ],
        },
        {
          label: 'Reference',
          items: [
            'reference/options',
            'reference/raya',
            'reference/player',
            'reference/queue',
            'reference/filters',
            'reference/node',
            'reference/events',
            'reference/errors',
          ],
        },
      ],
    }),
  ],
});
