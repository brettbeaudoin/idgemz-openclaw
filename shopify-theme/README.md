# IDGemz Shopify Theme

This directory is the Git-backed source for the IDGemz Shopify Online Store theme.

## Store

- Store: `c5e7b1-48.myshopify.com`
- Live theme baseline pulled from: `Updated copy of Spotlight` (`167678705977`)
- Base theme: Shopify Spotlight 14.0.0

## Credential Handling

The Shopify Theme Access password is not committed. It is stored locally at:

```sh
/Users/bbeaudoin/.config/idgemz/shopify-theme-access.env
```

That file should stay `0600` and contain:

```sh
SHOPIFY_FLAG_STORE=c5e7b1-48.myshopify.com
SHOPIFY_CLI_THEME_TOKEN=...
```

## Common Commands

```sh
cd /Users/bbeaudoin/clawd/idgemz-openclaw
set -a
. /Users/bbeaudoin/.config/idgemz/shopify-theme-access.env
set +a

shopify theme list --json --no-color
shopify theme check --path shopify-theme --no-color
shopify theme pull --theme 167678705977 --path shopify-theme --no-color
```

Only push to an unpublished Shopify theme until Brett approves a preview.

## Current Strategy

Keep the theme close to Shopify's native Online Store 2.0 patterns, but make IDGemz more conversion-focused:

- stronger product-first homepage
- device/token-based shopping paths
- bulk/team ordering calls to action
- PLA-CF premium positioning
- better trust/review placement
- clearer collection and product page guidance

