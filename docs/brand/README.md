# Brand images

- `og-image.html` — source for the link-preview banner (Nub cat mark from
  `public/favicon.svg`, Poppins 600, Nub blue backdrop). Size comes from the
  `--w` / `--h` CSS variables on `<body>`.
- `../../public/og-image.jpg` — 1200×630, served at
  `https://agent.nub.lol/og-image.jpg` (see the `og:` / `twitter:` tags in
  `index.html`).
- `nub-agent-banner-1920.jpg` — 1920×1080, for store listings / slides.

Re-render: open `og-image.html` in Chrome (Playwright `channel: 'chrome'`),
set `--w`/`--h` on `body` (1200×630 or 1920×1080), wait for `document.fonts.ready`,
screenshot the viewport, then `sips -s format jpeg -s formatOptions 88`.
